// JSON-RPC クライアント。講義の図でいう「MCP → RPC → ブロックチェーン」の下半分。
//
// 設計上の約束が 2 つある。
//
// 1. 鍵を扱わない。このファイルには署名も秘密鍵の読み込みも存在しない。
//    eth_sendRawTransaction を含む「状態を変える」メソッドは ALLOWED_METHODS に無く、
//    呼ぼうとすると送信前に落ちる。LLM がどう指示されても越えられない境界にしてある。
//
// 2. 答えの出どころを捨てない。どのエンドポイントが、いつ、どのブロック高で答えたかを
//    毎回返す。データそのものより「誰の主張か」を残すという考え方（→ README「論文との対応」）。

/** 既定のネットワーク。いずれも API キー不要の公開エンドポイント。 */
export const NETWORKS = {
  mainnet: { name: 'Ethereum Mainnet', chainId: 1, url: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
  sepolia: { name: 'Sepolia Testnet', chainId: 11155111, url: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
  holesky: { name: 'Holesky Testnet', chainId: 17000, url: 'https://ethereum-holesky-rpc.publicnode.com', explorer: 'https://holesky.etherscan.io' },
  local: { name: 'Local node (anvil / hardhat)', chainId: null, url: 'http://127.0.0.1:8545', explorer: null },
};

/**
 * 呼び出しを許すメソッドの明示的なホワイトリスト。
 * 読み取りのみ。ここに無いものは実行されない。
 */
const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getStorageAt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_getLogs',
  'eth_feeHistory',
  'net_version',
]);

export class RpcError extends Error {
  constructor(message, { method, code, endpoint } = {}) {
    super(message);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
    this.endpoint = endpoint;
  }
}

export class RpcClient {
  /**
   * @param {string} url
   * @param {{label?: string, timeoutMs?: number}} [options]
   */
  constructor(url, { label = null, timeoutMs = 15000 } = {}) {
    this.url = url;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.callCount = 0;
    /** @type {Array<{method: string, params: unknown[], ms: number}>} このツール呼び出しで実際に投げた RPC。 */
    this.trace = [];
  }

  /** @param {string} method @param {unknown[]} params */
  async send(method, params = []) {
    if (!ALLOWED_METHODS.has(method)) {
      throw new RpcError(
        `メソッド ${method} は許可されていません。このサーバは読み取り専用で、状態を変える RPC は実装していません。` +
          `署名と送信は MetaMask やハードウェアウォレットなど、鍵を持つ別のツールの仕事です。`,
        { method, endpoint: this.url },
      );
    }

    const startedAt = performance.now();
    this.callCount += 1;

    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.callCount, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new RpcError(`${this.url} に到達できませんでした: ${cause.message}`, { method, endpoint: this.url });
    }

    if (!response.ok) {
      throw new RpcError(`RPC が HTTP ${response.status} を返しました`, { method, code: response.status, endpoint: this.url });
    }

    const body = await response.json();
    const ms = Math.round(performance.now() - startedAt);
    this.trace.push({ method, params, ms });

    if (body.error) {
      throw new RpcError(`${method} が失敗しました: ${body.error.message}`, {
        method,
        code: body.error.code,
        endpoint: this.url,
      });
    }
    return body.result;
  }

  /** このツール呼び出しの出どころ。結果に必ず添える。 */
  provenance() {
    return {
      endpoint: this.url,
      network: this.label,
      rpc_calls: this.trace.map((t) => `${t.method} (${t.ms}ms)`),
      note:
        'これは単一の RPC エンドポイントの応答であり、独立に検証したものではない。' +
        'エンドポイントが古い状態や誤った値を返した場合、この結果もそうなる。',
    };
  }
}

/** 16 進文字列 -> BigInt。null/undefined はそのまま返す。 */
export const hexToBigInt = (hex) => (hex === null || hex === undefined ? null : BigInt(hex));

/** wei -> ether の文字列表現（丸めずに小数で出す）。 */
export function formatEther(wei, decimals = 18) {
  if (wei === null || wei === undefined) return null;
  const value = typeof wei === 'bigint' ? wei : BigInt(wei);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** wei -> gwei（ガス価格の表示用）。 */
export const formatGwei = (wei) => (wei === null || wei === undefined ? null : formatEther(wei, 9));
