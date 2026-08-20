// ツールの実体。MCP のプロトコルからは独立させてあるので、
// test/smoke.mjs から直接呼べるし、講義中に node -e で単体でも動かせる。
//
// 各ツールは講義スライドの節に対応する（README の対応表を参照）。
// 返り値には必ず _provenance を添える。どのエンドポイントが、どの RPC で、
// 何ミリ秒で答えたか。「答え」ではなく「誰の答えか」を残すため。

import { readFile } from 'node:fs/promises';
import { keccak256Hex, selectorOf, eventTopic } from './keccak.js';
import { encodeCall, decodeReturn, decodeStringLoose, parseSignature } from './abi.js';
import { RpcClient, NETWORKS, formatEther, formatGwei } from './rpc.js';

const ERC721_INTERFACE_ID = '0x80ac58cd';
const ERC1155_INTERFACE_ID = '0xd9b67a26';

const bi = (hex) => (hex === null || hex === undefined ? null : BigInt(hex));
const num = (hex) => (hex === null || hex === undefined ? null : Number(BigInt(hex)));

/** ブロック指定を RPC が受け取れる形に直す。数値でも "latest" でも通す。 */
function blockTag(value) {
  if (value === null || value === undefined || value === '') return 'latest';
  if (typeof value === 'number') return '0x' + value.toString(16);
  const s = String(value);
  if (['latest', 'earliest', 'pending', 'safe', 'finalized'].includes(s)) return s;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return '0x' + BigInt(s).toString(16);
  throw new Error(`ブロック指定として読めません: ${value}`);
}

function assertAddress(address, label = 'address') {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) {
    throw new Error(`${label} が Ethereum アドレスの形式ではありません: ${address}`);
  }
  return String(address).toLowerCase();
}

/** ネットワーク名または URL から RPC クライアントを作る。 */
export function clientFor(network, defaultNetwork = 'mainnet') {
  const key = network ?? defaultNetwork;
  if (NETWORKS[key]) return new RpcClient(NETWORKS[key].url, { label: `${key} (${NETWORKS[key].name})` });
  if (/^https?:\/\//.test(key)) return new RpcClient(key, { label: 'custom endpoint' });
  throw new Error(`未知のネットワークです: ${key}。指定できるのは ${Object.keys(NETWORKS).join(' / ')} か http(s) の URL です。`);
}

// ---------------------------------------------------------------------------
// 1. chain_info —— 講義「ガスと取引手数料」「プルーフ・オブ・ステーク」
// ---------------------------------------------------------------------------

export async function chainInfo(client) {
  const [chainId, blockNumber, gasPrice] = await Promise.all([
    client.send('eth_chainId'),
    client.send('eth_blockNumber'),
    client.send('eth_gasPrice'),
  ]);
  const block = await client.send('eth_getBlockByNumber', [blockNumber, false]);

  const baseFee = bi(block.baseFeePerGas);
  const gasUsed = bi(block.gasUsed);
  const gasLimit = bi(block.gasLimit);

  return {
    chain_id: num(chainId),
    latest_block: num(blockNumber),
    block_time_utc: new Date(num(block.timestamp) * 1000).toISOString(),
    transactions_in_block: block.transactions.length,
    gas: {
      base_fee_gwei: formatGwei(baseFee),
      gas_price_gwei: formatGwei(bi(gasPrice)),
      block_fullness: gasLimit ? `${((Number(gasUsed) / Number(gasLimit)) * 100).toFixed(1)}%` : null,
      note:
        'EIP-1559 では手数料 = ガス使用量 × (基本手数料 + 優先手数料)。基本手数料は' +
        'ブロックの混み具合で上下し、燃焼される（バーン）。優先手数料はバリデータへ渡る。',
    },
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 2. account_info —— 講義「2種類のアカウント」「Ethereum アドレス」
// ---------------------------------------------------------------------------

export async function accountInfo(client, { address, block }) {
  const addr = assertAddress(address);
  const tag = blockTag(block);

  const [balance, nonce, code] = await Promise.all([
    client.send('eth_getBalance', [addr, tag]),
    client.send('eth_getTransactionCount', [addr, tag]),
    client.send('eth_getCode', [addr, tag]),
  ]);

  const codeHex = String(code).toLowerCase();
  const codeSize = (codeHex.length - 2) / 2;

  // EIP-7702（Pectra, 2025）以降、EOA も「委任指定子」というコードを持てる。
  // 0xef0100 + 20 バイトのアドレス、ちょうど 23 バイト。中身は他所のコードへの参照で、
  // 秘密鍵での操作は引き続き可能。コードの有無だけで判定すると EOA を取り違える。
  const delegation = codeSize === 23 && codeHex.startsWith('0xef0100') ? '0x' + codeHex.slice(8) : null;
  const isContract = codeSize > 0 && delegation === null;

  const accountType = delegation
    ? 'externally owned account / EOA（EIP-7702 で委任先を設定済み）'
    : isContract
      ? 'contract account（コードを持つ）'
      : 'externally owned account / EOA（秘密鍵で操作する）';

  return {
    address: addr,
    account_type: accountType,
    balance_eth: formatEther(bi(balance)),
    balance_wei: bi(balance).toString(),
    transactions_sent: num(nonce),
    code_size_bytes: codeSize,
    delegated_to: delegation,
    at_block: tag,
    what_this_shows: delegation
      ? `コードが置かれているが、0xef0100 で始まる 23 バイトの委任指定子。EIP-7702 により、このアドレスは ${delegation} のコードを借りて動く。` +
        '鍵の持ち主による操作は従来どおり可能で、委任先はいつでも差し替えられる。「コードがある = コントラクト」という古い判定はここで破綻する。'
      : isContract
        ? 'このアドレスにはコードが置かれている。つまり秘密鍵の持ち主ではなく、デプロイされたプログラムが動く場所。'
        : 'このアドレスにコードは無い。対応する秘密鍵を持つ者だけがここから送金でき、その鍵はこのサーバのどこにも存在しない。',
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 3. read_transaction —— 講義「Etherscan でトランザクションを読む」
// ---------------------------------------------------------------------------

export async function readTransaction(client, { hash }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash ?? ''))) {
    throw new Error(`トランザクションハッシュの形式ではありません: ${hash}`);
  }

  const [tx, receipt] = await Promise.all([
    client.send('eth_getTransactionByHash', [hash]),
    client.send('eth_getTransactionReceipt', [hash]),
  ]);

  if (!tx) {
    return {
      hash,
      found: false,
      note: 'このエンドポイントは当該トランザクションを知らない。未伝播か、別のネットワークのものか、削除された可能性がある。',
      _provenance: client.provenance(),
    };
  }

  const gasUsed = receipt ? bi(receipt.gasUsed) : null;
  const effectiveGasPrice = receipt ? bi(receipt.effectiveGasPrice) : null;
  const fee = gasUsed !== null && effectiveGasPrice !== null ? gasUsed * effectiveGasPrice : null;

  const input = String(tx.input ?? '0x');
  const selector = input.length >= 10 ? input.slice(0, 10) : null;

  return {
    hash: tx.hash,
    status: receipt ? (bi(receipt.status) === 1n ? 'success' : 'reverted（失敗しても手数料は戻らない）') : 'pending（まだブロックに入っていない）',
    from: tx.from,
    to: tx.to ?? null,
    contract_deployed: receipt?.contractAddress ?? null,
    value_eth: formatEther(bi(tx.value)),
    nonce: num(tx.nonce),
    block_number: tx.blockNumber ? num(tx.blockNumber) : null,
    gas: {
      gas_limit: num(tx.gas),
      gas_used: gasUsed?.toString() ?? null,
      effective_gas_price_gwei: formatGwei(effectiveGasPrice),
      max_fee_per_gas_gwei: tx.maxFeePerGas ? formatGwei(bi(tx.maxFeePerGas)) : null,
      max_priority_fee_per_gas_gwei: tx.maxPriorityFeePerGas ? formatGwei(bi(tx.maxPriorityFeePerGas)) : null,
      fee_paid_eth: fee !== null ? formatEther(fee) : null,
    },
    calldata: {
      length_bytes: (input.length - 2) / 2,
      function_selector: selector,
      selector_note: selector
        ? `先頭 4 バイト ${selector} は keccak256(関数署名) の先頭 4 バイト。ABI が無いと、この 4 バイトからは関数名を復元できない（一方向ハッシュのため）。`
        : 'calldata が無い。単純な ETH 送金。',
      raw_preview: input.length > 138 ? input.slice(0, 138) + '…' : input,
    },
    logs_emitted: receipt?.logs?.length ?? 0,
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 4. read_block
// ---------------------------------------------------------------------------

export async function readBlock(client, { block, include_transactions = false }) {
  const tag = blockTag(block);
  const b = await client.send('eth_getBlockByNumber', [tag, false]);
  if (!b) throw new Error(`ブロック ${tag} が見つかりません。`);

  return {
    number: num(b.number),
    hash: b.hash,
    parent_hash: b.parentHash,
    timestamp_utc: new Date(num(b.timestamp) * 1000).toISOString(),
    proposer_fee_recipient: b.miner,
    transaction_count: b.transactions.length,
    gas_used: bi(b.gasUsed).toString(),
    gas_limit: bi(b.gasLimit).toString(),
    base_fee_gwei: b.baseFeePerGas ? formatGwei(bi(b.baseFeePerGas)) : null,
    transactions: include_transactions ? b.transactions.slice(0, 50) : undefined,
    chain_note:
      'parent_hash が 1 つ前のブロックを指す。この連鎖が「改ざん不可能」の実体で、' +
      '過去を書き換えるにはそれ以降のすべてを作り直し、ネットワークに受け入れさせる必要がある。',
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 5. call_contract —— 講義「ABI」「Solidity 入門」
// ---------------------------------------------------------------------------

export async function callContract(client, { address, signature, args = [], outputs = [], block }) {
  const addr = assertAddress(address, 'contract address');
  const { data, selector, canonical } = encodeCall(signature, args);

  const raw = await client.send('eth_call', [{ to: addr, data }, blockTag(block)]);
  const decoded = outputs.length > 0 ? decodeReturn(outputs, raw) : null;

  return {
    contract: addr,
    called: canonical,
    how_the_selector_was_derived: `keccak256("${canonical}") の先頭 4 バイト = ${selector}`,
    calldata_sent: data.length > 138 ? data.slice(0, 138) + '…' : data,
    raw_return: raw,
    decoded: decoded,
    decoded_as: outputs.length > 0 ? outputs : '（outputs を指定すると人間が読める形に変換します）',
    call_note:
      'eth_call は状態を変えない。ノードがローカルで実行して結果だけ返すので、ガスもかからず、記録も残らない。',
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 6. read_token —— 講義「ERC-20」「ERC-721」「トークンとは何か」
// ---------------------------------------------------------------------------

async function tryCall(client, address, signature, outputs) {
  try {
    const { data } = encodeCall(signature, []);
    const raw = await client.send('eth_call', [{ to: address, data }, 'latest']);
    if (raw === '0x' || raw === null) return null;
    return decodeReturn(outputs, raw)[0];
  } catch {
    return null;
  }
}

export async function readToken(client, { address, holder = null, token_id = null }) {
  const addr = assertAddress(address, 'token address');

  const code = await client.send('eth_getCode', [addr, 'latest']);
  if (String(code).length <= 2) {
    throw new Error(`${addr} にコードがありません。トークンコントラクトではなく EOA です。`);
  }

  const [nameRaw, symbolRaw] = await Promise.all([
    client.send('eth_call', [{ to: addr, data: selectorOf('name()') }, 'latest']).catch(() => '0x'),
    client.send('eth_call', [{ to: addr, data: selectorOf('symbol()') }, 'latest']).catch(() => '0x'),
  ]);

  const [decimals, totalSupply, is721, is1155] = await Promise.all([
    tryCall(client, addr, 'decimals()', ['uint256']),
    tryCall(client, addr, 'totalSupply()', ['uint256']),
    (async () => {
      const { data } = encodeCall('supportsInterface(bytes4)', [ERC721_INTERFACE_ID]);
      try {
        const raw = await client.send('eth_call', [{ to: addr, data }, 'latest']);
        return decodeReturn(['bool'], raw)[0] === true;
      } catch {
        return false;
      }
    })(),
    (async () => {
      const { data } = encodeCall('supportsInterface(bytes4)', [ERC1155_INTERFACE_ID]);
      try {
        const raw = await client.send('eth_call', [{ to: addr, data }, 'latest']);
        return decodeReturn(['bool'], raw)[0] === true;
      } catch {
        return false;
      }
    })(),
  ]);

  const standard = is721 ? 'ERC-721（代替不可能 / NFT）' : is1155 ? 'ERC-1155（マルチトークン）' : decimals !== null ? 'ERC-20（代替可能）' : '判別できず（標準的な問い合わせに応答しない）';

  const result = {
    contract: addr,
    standard,
    name: decodeStringLoose(nameRaw),
    symbol: decodeStringLoose(symbolRaw),
    decimals: decimals !== null ? Number(decimals) : null,
    total_supply_raw: totalSupply ?? null,
    total_supply: totalSupply !== null && decimals !== null ? formatEther(BigInt(totalSupply), Number(decimals)) : null,
  };

  if (holder) {
    const h = assertAddress(holder, 'holder');
    const { data } = encodeCall('balanceOf(address)', [h]);
    const raw = await client.send('eth_call', [{ to: addr, data }, 'latest']);
    const [balance] = decodeReturn(['uint256'], raw);
    result.holder = h;
    result.holder_balance_raw = balance;
    result.holder_balance = decimals !== null ? formatEther(BigInt(balance), Number(decimals)) : balance;
  }

  if (token_id !== null && token_id !== undefined && is721) {
    result.token_id = String(token_id);
    result.owner_of = await (async () => {
      const { data } = encodeCall('ownerOf(uint256)', [token_id]);
      try {
        const raw = await client.send('eth_call', [{ to: addr, data }, 'latest']);
        return decodeReturn(['address'], raw)[0];
      } catch {
        return null;
      }
    })();
    result.token_uri = await (async () => {
      const { data } = encodeCall('tokenURI(uint256)', [token_id]);
      try {
        const raw = await client.send('eth_call', [{ to: addr, data }, 'latest']);
        return decodeReturn(['string'], raw)[0];
      } catch {
        return null;
      }
    })();
    result.metadata_note =
      'tokenURI が指す先はチェーンの外にある。IPFS なら内容ハッシュなので差し替えは検知できるが、' +
      'HTTP なら所有者はいつでも中身を差し替えられる。「NFT は改ざんできない」が指すのは台帳上の所有権の記録であって、' +
      'その先の画像やメタデータではない。';
  }

  result.self_reported_note =
    'name / symbol / decimals はコントラクト自身が申告した値であって、チェーンが保証した事実ではない。' +
    '同じ名前と記号を持つ別のコントラクトは誰でもデプロイできる。' +
    'チェーンが保証するのは「この住所のコードがこう答えた」ことまでで、その主張が正しいことではない。';
  result._provenance = client.provenance();
  return result;
}

// ---------------------------------------------------------------------------
// 7. read_events —— 講義「イベント駆動の UI とブロックチェーンの反応性」
// ---------------------------------------------------------------------------

/** "Transfer(address indexed from, address indexed to, uint256 value)" を解析する。 */
export function parseEventSignature(signature) {
  const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*)\)\s*$/s.exec(signature);
  if (!match) throw new Error(`イベント署名として読めません: ${signature}`);
  const [, name, rawParams] = match;

  const params = rawParams.trim() === ''
    ? []
    : rawParams.split(',').map((p) => {
        const tokens = p.trim().split(/\s+/);
        const type = tokens[0] === 'uint' ? 'uint256' : tokens[0] === 'int' ? 'int256' : tokens[0];
        return { type, indexed: tokens.includes('indexed') };
      });

  const canonical = `${name}(${params.map((p) => p.type).join(',')})`;
  return { name, params, canonical, topic0: eventTopic(canonical) };
}

export async function readEvents(client, { address, event_signature, from_block, to_block, limit = 20 }) {
  const addr = address ? assertAddress(address, 'contract address') : null;
  const event = parseEventSignature(event_signature);

  const latest = num(await client.send('eth_blockNumber'));
  const to = to_block === undefined || to_block === null ? latest : Number(blockTag(to_block) === 'latest' ? latest : BigInt(blockTag(to_block)));
  const from = from_block === undefined || from_block === null ? Math.max(0, to - 200) : Number(BigInt(blockTag(from_block)));

  const filter = {
    fromBlock: '0x' + from.toString(16),
    toBlock: '0x' + to.toString(16),
    topics: [event.topic0],
  };
  if (addr) filter.address = addr;

  const logs = await client.send('eth_getLogs', [filter]);

  const indexedTypes = event.params.filter((p) => p.indexed).map((p) => p.type);
  const dataTypes = event.params.filter((p) => !p.indexed).map((p) => p.type);

  // ABI 仕様では、indexed の引数が動的型（string / bytes / 配列 / 構造体）のとき、
  // topic に載るのは値ではなく「値の keccak ハッシュ」。復元はできない。
  // 値として読もうとすると壊れるので、ハッシュであることを明示して返す。
  const isDynamicType = (t) => t === 'string' || t === 'bytes' || t.endsWith('[]') || t.startsWith('(');

  const decoded = logs.slice(0, limit).map((log) => {
    const topicValues = log.topics.slice(1).map((topic, i) => {
      const type = indexedTypes[i];
      if (type === undefined) return topic;
      if (isDynamicType(type)) return `${topic}（${type} の値そのものではなく keccak ハッシュ。元の値は復元できない）`;
      try {
        return decodeReturn([type], topic)[0];
      } catch {
        return topic;
      }
    });
    let dataValues = [];
    try {
      dataValues = decodeReturn(dataTypes, log.data);
    } catch {
      dataValues = ['（デコードできませんでした）'];
    }
    return {
      block: num(log.blockNumber),
      tx: log.transactionHash,
      contract: log.address,
      indexed: Object.fromEntries(indexedTypes.map((t, i) => [`arg${i}(${t}, indexed)`, topicValues[i]])),
      data: Object.fromEntries(dataTypes.map((t, i) => [`arg${i}(${t})`, dataValues[i]])),
    };
  });

  return {
    event: event.canonical,
    topic0: event.topic0,
    topic0_note:
      `topic0 = keccak256("${event.canonical}")。ノードはこの 32 バイトで絞り込む。indexed の引数だけが topic に載り、残りは data に詰められる。` +
      'indexed にできるのは最大 3 個（anonymous イベントは 4 個）。anonymous イベントには topic0 が無いので、この絞り込みでは拾えない。' +
      '動的型（string / bytes / 配列 / 構造体）を indexed にした場合、topic に載るのは値ではなくその keccak ハッシュで、元の値は復元できない。',
    scanned_blocks: `${from} 〜 ${to}`,
    total_matches: logs.length,
    shown: decoded.length,
    events: decoded,
    ui_note:
      'dApp のフロントエンドは、この購読で画面を更新する。ただしチェーンは再編成 (reorg) しうるので、' +
      '確定前のイベントで確定的な処理をしてはいけない。',
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 8. prepare_unsigned_transaction —— 講義「MCP を使うときの注意」
// ---------------------------------------------------------------------------

export async function prepareUnsignedTransaction(client, { from, to, value_eth = '0', signature = null, args = [] }) {
  const fromAddr = assertAddress(from, 'from');
  const toAddr = assertAddress(to, 'to');

  let data = '0x';
  let canonical = null;
  if (signature) {
    const encoded = encodeCall(signature, args);
    data = encoded.data;
    canonical = encoded.canonical;
  }

  const valueWei = (() => {
    const [whole, frac = ''] = String(value_eth).split('.');
    return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  })();

  const [chainId, nonce, block] = await Promise.all([
    client.send('eth_chainId'),
    client.send('eth_getTransactionCount', [fromAddr, 'pending']),
    client.send('eth_getBlockByNumber', ['latest', false]),
  ]);

  const baseFee = bi(block.baseFeePerGas) ?? 0n;
  const priorityFee = await client
    .send('eth_maxPriorityFeePerGas')
    .then((v) => bi(v))
    .catch(() => 1_500_000_000n);

  let gasLimit = null;
  let gasEstimateError = null;
  try {
    gasLimit = bi(await client.send('eth_estimateGas', [{ from: fromAddr, to: toAddr, value: '0x' + valueWei.toString(16), data }]));
  } catch (error) {
    // 見積もりの失敗は事故ではなく情報。ノードが実際に実行してみて revert したということ。
    // 署名する前にここで分かるのが eth_estimateGas の価値。
    gasEstimateError = error.message;
  }

  const maxFeePerGas = baseFee * 2n + priorityFee;

  return {
    unsigned_transaction: {
      type: '0x2',
      chainId,
      from: fromAddr,
      to: toAddr,
      nonce,
      value: '0x' + valueWei.toString(16),
      data,
      gas: gasLimit !== null ? '0x' + gasLimit.toString(16) : null,
      maxFeePerGas: '0x' + maxFeePerGas.toString(16),
      maxPriorityFeePerGas: '0x' + priorityFee.toString(16),
    },
    human_readable: {
      calls: canonical ?? '（関数呼び出しなし。ETH の送金のみ）',
      value_eth: formatEther(valueWei),
      gas_limit: gasLimit?.toString() ?? null,
      max_fee_gwei: formatGwei(maxFeePerGas),
      worst_case_fee_eth: gasLimit !== null ? formatEther(gasLimit * maxFeePerGas) : null,
    },
    gas_estimate_failed: gasEstimateError
      ? {
          reason: gasEstimateError,
          meaning:
            'ノードがこのトランザクションを実際に試したところ revert した。署名する前に分かるのが eth_estimateGas の役目。' +
            'このまま送っても手数料だけ取られて失敗する。よくある原因: 宛先が ETH を受け取れない、残高不足、権限がない。',
        }
      : undefined,
    signature_status: 'UNSIGNED — 署名されていません',
    why_unsigned:
      'このサーバは秘密鍵を持たず、署名する機能も実装していません（src/rpc.js の ALLOWED_METHODS に ' +
      'eth_sendRawTransaction がありません）。LLM がどう指示されても、ここから資金を動かすことはできません。' +
      'この JSON を MetaMask・ハードウェアウォレット・専用の署名サービスに渡し、人間が内容を確認して署名してください。',
    next_step:
      'MetaMask なら window.ethereum.request({ method: "eth_sendTransaction", params: [上の unsigned_transaction] }) に渡す。' +
      '署名の瞬間に何を承認しているのかが人間に見えることが重要です。',
    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 9. verify_anchor —— 論文側。チェーンに刻んだハッシュと手元のファイルを突き合わせる
// ---------------------------------------------------------------------------

export async function verifyAnchor(client, { tx_hash, file_path = null, text = null, expected_hash = null }) {
  if (!file_path && !text && !expected_hash) {
    throw new Error('file_path か text か expected_hash のいずれかを指定してください。');
  }

  let digest;
  let subject;
  if (expected_hash) {
    digest = String(expected_hash).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(digest)) throw new Error(`expected_hash が 32 バイトの 16 進ではありません: ${expected_hash}`);
    subject = '（呼び出し側が渡したハッシュ）';
  } else if (file_path) {
    const bytes = new Uint8Array(await readFile(file_path));
    digest = keccak256Hex(bytes).toLowerCase();
    subject = `${file_path}（${bytes.length} バイト）`;
  } else {
    digest = keccak256Hex(text).toLowerCase();
    subject = `渡されたテキスト（${text.length} 文字）`;
  }

  const bare = digest.slice(2);

  const [tx, receipt] = await Promise.all([
    client.send('eth_getTransactionByHash', [tx_hash]),
    client.send('eth_getTransactionReceipt', [tx_hash]),
  ]);
  if (!tx) throw new Error(`トランザクション ${tx_hash} がこのエンドポイントに見つかりません。`);

  const input = String(tx.input ?? '0x').toLowerCase();
  const inCalldata = input.includes(bare);
  const logHits = (receipt?.logs ?? []).flatMap((log, i) => {
    const hits = [];
    log.topics.forEach((topic, t) => {
      if (String(topic).toLowerCase().includes(bare)) hits.push(`log[${i}].topics[${t}]`);
    });
    if (String(log.data ?? '').toLowerCase().includes(bare)) hits.push(`log[${i}].data`);
    return hits;
  });

  const found = inCalldata || logHits.length > 0;
  const blockTime = tx.blockNumber
    ? await client.send('eth_getBlockByNumber', [tx.blockNumber, false]).then((b) => new Date(num(b.timestamp) * 1000).toISOString())
    : null;

  return {
    subject,
    keccak256: digest,
    anchor_transaction: tx_hash,
    anchored: found,
    found_in: found ? [inCalldata ? 'transaction calldata' : null, ...logHits].filter(Boolean) : [],
    block_number: tx.blockNumber ? num(tx.blockNumber) : null,
    anchored_at_utc: blockTime,
    submitted_by: tx.from,

    what_this_proves: found
      ? [
          `${tx.from} が ${blockTime} より前の時点でこのハッシュを知っていたこと（存在証明とタイムスタンプ）。`,
          'その後この記録が書き換えられていないこと。書き換えには以降の全ブロックの再構成が要る。',
          '手元のファイルが、そのとき刻まれたものと 1 バイトも違わないこと。',
        ]
      : ['このハッシュはこのトランザクションのどこにも現れなかった。ファイルが変更されたか、別のトランザクションを見ている。'],

    what_this_does_not_prove: [
      '中身が正しいこと。誤った測定値のハッシュも、正しい測定値のハッシュと同じように刻める。',
      `${tx.from} が名乗るとおりの主体であること。チェーンが結びつけるのは鍵とアドレスであって、組織や人ではない。`,
      'ファイルを作った者が、記録された事実を実際に観測したこと。',
      'このエンドポイントが真実を答えたこと。単一の RPC を信じている。独立に確かめるにはブロックヘッダを別経路で取る必要がある。',
    ],

    archival_note:
      'アンカリングが与えるのは「いつ・誰が・何を主張したか」であって「その主張が正しいか」ではない。' +
      '真正性 (authenticity) は真実性 (truth) ではない、という古文書学の区別がそのまま当てはまる。' +
      '長期保存の観点では、このチェーンが数十年後も読めるかどうかも別の問題として残る。',

    _provenance: client.provenance(),
  };
}

// ---------------------------------------------------------------------------
// 10. explain_selector —— チェーンに触らない補助ツール
// ---------------------------------------------------------------------------

export function explainSelector({ signature }) {
  const isEvent = /\bindexed\b/.test(signature);
  if (isEvent) {
    const event = parseEventSignature(signature);
    return {
      input: signature,
      canonical_form: event.canonical,
      keccak256: eventTopic(event.canonical),
      used_as: 'イベントの topic0。ログの絞り込みに使う。',
      indexed_params: event.params.filter((p) => p.indexed).map((p) => p.type),
      data_params: event.params.filter((p) => !p.indexed).map((p) => p.type),
      note: '引数名は署名に含まれない。型だけが正規形に残る。',
    };
  }
  const fn = parseSignature(signature);
  const full = keccak256Hex(fn.canonical);
  return {
    input: signature,
    canonical_form: fn.canonical,
    keccak256: full,
    function_selector: full.slice(0, 10),
    used_as: 'calldata の先頭 4 バイト。コントラクトはこれで呼ばれた関数を判別する。',
    note:
      '一方向ハッシュなので、セレクタから関数名は復元できない。Etherscan が関数名を表示できるのは、' +
      '既知の署名を集めた辞書と突き合わせているから。ABI が公開されていない契約の calldata が読めないのはこのため。',
  };
}

export { NETWORKS };
