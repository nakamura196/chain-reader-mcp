#!/usr/bin/env node
// MCP サーバ本体。stdio で話す。
//
// 講義スライドの図:
//
//     LLM   ← 自然言語
//      ↓
//     MCP   ← このファイル
//      ↓
//     RPC   ← src/rpc.js
//      ↓
//   ブロックチェーン
//
// 環境変数:
//   ETH_NETWORK  mainnet | sepolia | holesky | local （既定: mainnet）
//   ETH_RPC_URL  独自エンドポイントの URL。指定するとネットワーク名より優先される

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  clientFor,
  chainInfo,
  accountInfo,
  readTransaction,
  readBlock,
  callContract,
  readToken,
  readEvents,
  prepareUnsignedTransaction,
  verifyAnchor,
  explainSelector,
  NETWORKS,
} from './tools.js';

const DEFAULT_NETWORK = process.env.ETH_RPC_URL ?? process.env.ETH_NETWORK ?? 'mainnet';

const networkArg = z
  .string()
  .optional()
  .describe(`対象ネットワーク。${Object.keys(NETWORKS).join(' / ')} か http(s) の URL。既定は ${DEFAULT_NETWORK}`);

/** BigInt が混ざっても JSON にできるようにする。 */
const stringify = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

const ok = (value) => ({ content: [{ type: 'text', text: stringify(value) }] });

const fail = (error) => ({
  isError: true,
  content: [{ type: 'text', text: `${error.name ?? 'Error'}: ${error.message}` }],
});

const server = new McpServer(
  { name: 'chain-reader', version: '0.1.0' },
  {
    instructions:
      'Ethereum を読み取り専用で観測するツール群です。秘密鍵を持たず、署名も送信もできません。' +
      '各結果の _provenance に、どのエンドポイントがどの RPC で答えたかが入っています。' +
      'ユーザーに数値を伝えるときは、それが「チェーンが保証した事実」なのか' +
      '「コントラクトや送信者が申告した内容」なのかを区別して説明してください。',
  },
);

/**
 * チェーンに触るツールを 1 か所で登録する。毎回新しいクライアントを作るので、
 * _provenance の rpc_calls はその呼び出しで実際に投げたものだけになる。
 */
function registerChainTool(name, config, handler) {
  server.registerTool(
    name,
    {
      ...config,
      inputSchema: { ...config.inputSchema, network: networkArg },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, ...config.annotations },
    },
    async ({ network, ...args }) => {
      try {
        const client = clientFor(network, DEFAULT_NETWORK);
        return ok(await handler(client, args));
      } catch (error) {
        return fail(error);
      }
    },
  );
}

// --- 1. ネットワークの現況 ---------------------------------------------------

registerChainTool(
  'chain_info',
  {
    title: 'チェーンの現況',
    description:
      'チェーン ID、最新ブロック、基本手数料 (base fee)、ブロックの混み具合を返す。' +
      '「いまネットワークはどうなっているか」を最初に見るためのツール。',
    inputSchema: {},
  },
  (client) => chainInfo(client),
);

// --- 2. アカウント -----------------------------------------------------------

registerChainTool(
  'account_info',
  {
    title: 'アカウントを調べる',
    description:
      'アドレスの残高・送信済みトランザクション数 (nonce)・コードの有無を返す。' +
      'コードの有無で EOA（秘密鍵で操作するアカウント）とコントラクトを判別する。',
    inputSchema: {
      address: z.string().describe('0x から始まる 20 バイトのアドレス'),
      block: z.union([z.string(), z.number()]).optional().describe('ブロック番号または latest / finalized など。既定は latest'),
    },
  },
  (client, args) => accountInfo(client, args),
);

// --- 3. トランザクション -----------------------------------------------------

registerChainTool(
  'read_transaction',
  {
    title: 'トランザクションを読む',
    description:
      'トランザクションと領収書 (receipt) を突き合わせて、送信者・宛先・送金額・ガス・実際に払った手数料・' +
      '成否・calldata の関数セレクタを人間が読める形で返す。Etherscan の画面を読むのと同じ作業。',
    inputSchema: { hash: z.string().describe('0x から始まる 32 バイトのトランザクションハッシュ') },
  },
  (client, args) => readTransaction(client, args),
);

// --- 4. ブロック -------------------------------------------------------------

registerChainTool(
  'read_block',
  {
    title: 'ブロックを読む',
    description: 'ブロックのヘッダ情報（親ハッシュ、時刻、ガス使用量、収録トランザクション数）を返す。',
    inputSchema: {
      block: z.union([z.string(), z.number()]).optional().describe('ブロック番号または latest。既定は latest'),
      include_transactions: z.boolean().optional().describe('収録トランザクションのハッシュ一覧（先頭 50 件）も返す'),
    },
  },
  (client, args) => readBlock(client, args),
);

// --- 5. コントラクト呼び出し -------------------------------------------------

registerChainTool(
  'call_contract',
  {
    title: 'コントラクトの読み取り関数を呼ぶ',
    description:
      '任意のコントラクトの view / pure 関数を eth_call で呼ぶ。関数署名から keccak256 でセレクタを計算し、' +
      '引数を ABI エンコードして送り、戻り値をデコードして返す。状態は変わらず、ガスもかからない。',
    inputSchema: {
      address: z.string().describe('コントラクトアドレス'),
      signature: z.string().describe('関数署名。例: "balanceOf(address)" / "totalSupply()"'),
      args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe('引数の配列。署名の型と同じ順・同じ個数'),
      outputs: z.array(z.string()).optional().describe('戻り値の型。例: ["uint256"] / ["string"]。省略すると生の 16 進のまま返す'),
      block: z.union([z.string(), z.number()]).optional().describe('この時点の状態で呼ぶ。既定は latest'),
    },
  },
  (client, args) => callContract(client, args),
);

// --- 6. トークン -------------------------------------------------------------

registerChainTool(
  'read_token',
  {
    title: 'トークンを調べる',
    description:
      'ERC-20 / ERC-721 / ERC-1155 を判別し、名称・記号・小数桁・総供給量を読む。' +
      'holder を渡せば残高、token_id を渡せば NFT の所有者と tokenURI も読む。',
    inputSchema: {
      address: z.string().describe('トークンコントラクトのアドレス'),
      holder: z.string().optional().describe('残高を調べたいアドレス'),
      token_id: z.union([z.string(), z.number()]).optional().describe('ERC-721 のトークン ID'),
    },
  },
  (client, args) => readToken(client, args),
);

// --- 7. イベント -------------------------------------------------------------

registerChainTool(
  'read_events',
  {
    title: 'イベントログを読む',
    description:
      'コントラクトが発火したイベントを取得してデコードする。イベント署名の keccak256 が topic0 になり、' +
      'indexed の引数だけが topic に載る、という仕組みがそのまま見える。dApp の画面更新はこれを購読している。',
    inputSchema: {
      address: z.string().optional().describe('絞り込むコントラクトアドレス。省略すると全体から探す（重い）'),
      event_signature: z
        .string()
        .describe('イベント署名。indexed も書く。例: "Transfer(address indexed from, address indexed to, uint256 value)"'),
      from_block: z.union([z.string(), z.number()]).optional().describe('開始ブロック。既定は最新から 200 ブロック前'),
      to_block: z.union([z.string(), z.number()]).optional().describe('終了ブロック。既定は latest'),
      limit: z.number().optional().describe('デコードして返す件数。既定 20'),
    },
  },
  (client, args) => readEvents(client, args),
);

// --- 8. 未署名トランザクションの組み立て -------------------------------------

registerChainTool(
  'prepare_unsigned_transaction',
  {
    title: '未署名トランザクションを組み立てる',
    description:
      'nonce・ガス見積もり・手数料を埋めた EIP-1559 形式のトランザクションを組み立てて返す。' +
      '【重要】このサーバは署名も送信もしない。返るのは人間が MetaMask やハードウェアウォレットで' +
      '内容を確認してから署名するための JSON。LLM に鍵を渡さないという境界を、実際に動く形で示すためのツール。',
    inputSchema: {
      from: z.string().describe('送信元アドレス（nonce とガス見積もりに使うだけで、鍵は不要）'),
      to: z.string().describe('宛先アドレス'),
      value_eth: z.string().optional().describe('送金額を ETH 単位の文字列で。既定は "0"'),
      signature: z.string().optional().describe('呼び出す関数の署名。例: "transfer(address,uint256)"'),
      args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe('関数の引数'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  (client, args) => prepareUnsignedTransaction(client, args),
);

// --- 9. アンカーの検証 -------------------------------------------------------

registerChainTool(
  'verify_anchor',
  {
    title: 'チェーンに刻まれたハッシュと手元のファイルを突き合わせる',
    description:
      '手元のファイル（またはテキスト）の keccak256 を計算し、指定したトランザクションの calldata や' +
      'イベントログにその値が現れるかを確認する。存在証明とタイムスタンプの検証。' +
      '結果には「これで何が証明できて、何が証明できないか」を必ず併記する。',
    inputSchema: {
      tx_hash: z.string().describe('アンカーしたトランザクションのハッシュ'),
      file_path: z.string().optional().describe('照合したいローカルファイルのパス'),
      text: z.string().optional().describe('ファイルの代わりに直接テキストを渡す'),
      expected_hash: z.string().optional().describe('既に計算済みの keccak256 を直接渡す'),
    },
  },
  (client, args) => verifyAnchor(client, args),
);

// --- 10. セレクタの説明（チェーンに触らない） --------------------------------

server.registerTool(
  'explain_selector',
  {
    title: '関数セレクタ／イベント topic を計算する',
    description:
      '関数署名やイベント署名から keccak256 を計算し、セレクタ（先頭 4 バイト）や topic0 を示す。' +
      'ネットワークには一切アクセスしない。ABI がどこから来るのかを黒板で説明するためのツール。',
    inputSchema: {
      signature: z.string().describe('例: "transfer(address,uint256)" / "Transfer(address indexed from, address indexed to, uint256 value)"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      return ok(explainSelector(args));
    } catch (error) {
      return fail(error);
    }
  },
);

// --- 講義用のプロンプト ------------------------------------------------------

server.registerPrompt(
  'lecture_walkthrough',
  {
    title: '講義デモの流れ',
    description: '講義スライドの順に沿って、チェーンを 1 本読み下す一連の指示。',
    argsSchema: {
      address: z.string().optional().describe('題材にするアドレス。省略すると Vitalik のアドレスを使う'),
    },
  },
  ({ address }) => {
    const target = address || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'chain-reader のツールだけを使って、次の順に調べて説明してください。各段階で、',
              'いま画面に出ている数値が「チェーンが保証した事実」か「誰かが申告した内容」かを明示すること。',
              '',
              '1. chain_info でネットワークの現況を見る（基本手数料と混み具合）',
              `2. account_info で ${target} を調べ、EOA かコントラクトかを判定する`,
              '3. explain_selector で "transfer(address,uint256)" のセレクタを計算し、なぜ 4 バイトなのかを説明する',
              '4. read_token で USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) を調べ、',
              '   名称と記号がコントラクトの自己申告であることを指摘する',
              '5. read_events で USDC の Transfer イベントを直近数ブロック分だけ読み、topic0 の役割を説明する',
              '6. prepare_unsigned_transaction で 0.001 ETH の送金を組み立て、',
              '   なぜこのサーバがそれを送信できないのかを説明して締める',
            ].join('\n'),
          },
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
