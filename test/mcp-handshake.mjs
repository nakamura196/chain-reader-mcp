// MCP のプロトコルを実際に通す検証。stdio でサーバを起動し、initialize →
// tools/list → tools/call → prompts/list までを一往復させる。
// smoke.mjs が「チェーンが読めるか」を見るのに対し、こちらは「MCP として正しいか」を見る。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '../src/server.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, ETH_NETWORK: process.env.ETH_NETWORK ?? 'mainnet' },
});

const client = new Client({ name: 'handshake-test', version: '0.1.0' });
await client.connect(transport);

console.log('initialize   ok');
console.log('  server     ', JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
console.log(`tools/list   ok — ${tools.length} 件`);
for (const tool of tools) {
  const params = Object.keys(tool.inputSchema?.properties ?? {});
  console.log(`  - ${tool.name.padEnd(30)} (${params.join(', ') || '引数なし'})`);
}

const { prompts } = await client.listPrompts();
console.log(`prompts/list ok — ${prompts.length} 件: ${prompts.map((p) => p.name).join(', ')}`);

let failures = 0;

async function callTool(name, args, check) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  const problem = result.isError ? `isError: ${text.slice(0, 120)}` : check?.(text, result);
  if (problem) {
    failures++;
    console.log(`tools/call ${name} — FAILED: ${problem}`);
  } else {
    console.log(`tools/call ${name} — ok`);
  }
  return text;
}

// ネットワーク不要のツール。値が既知なので厳密に照合できる。
await callTool('explain_selector', { signature: 'transfer(address,uint256)' }, (text) =>
  JSON.parse(text).function_selector === '0xa9059cbb' ? null : `セレクタが違う: ${text.slice(0, 200)}`);

// チェーンを実際に読むツール。
await callTool('chain_info', {}, (text) => {
  const body = JSON.parse(text);
  if (!body._provenance?.endpoint) return '_provenance が付いていない';
  if (!Number.isInteger(body.latest_block)) return 'latest_block が整数でない';
  return null;
});

await callTool('account_info', { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }, (text) =>
  JSON.parse(text).account_type.startsWith('contract') ? null : 'USDC がコントラクトと判定されていない');

// ネットワーク引数が効くこと。
await callTool('chain_info', { network: 'sepolia' }, (text) =>
  JSON.parse(text).chain_id === 11155111 ? null : 'sepolia の chainId が違う');

// エラーがプロトコルの例外ではなく、ツールの結果として返ること。
const badAddress = await client.callTool({ name: 'account_info', arguments: { address: 'not-an-address' } });
if (badAddress.isError) {
  console.log('tools/call account_info（不正な引数）— ok（isError として返った）');
} else {
  failures++;
  console.log('tools/call account_info（不正な引数）— FAILED: エラーにならなかった');
}

const prompt = await client.getPrompt({ name: 'lecture_walkthrough', arguments: {} });
console.log(`prompts/get  ok — ${prompt.messages.length} メッセージ, ${prompt.messages[0].content.text.length} 文字`);

await client.close();
console.log(`\n${'='.repeat(50)}\n${failures === 0 ? 'すべて通過' : `${failures} 件失敗`}`);
process.exit(failures ? 1 : 0);
