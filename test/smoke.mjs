// 実ネットワークに対して全ツールを 1 回ずつ叩く。MCP を通さず直接呼ぶので、
// 失敗したときに「プロトコルの問題か、チェーン読み取りの問題か」を切り分けられる。
//
//   node test/smoke.mjs            mainnet
//   ETH_NETWORK=sepolia node test/smoke.mjs

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
} from '../src/tools.js';

const NETWORK = process.env.ETH_NETWORK ?? 'mainnet';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const BURN = '0x000000000000000000000000000000000000dEaD'; // コードを持たないので単純送金の宛先に使える

let passed = 0;
let failed = 0;

const show = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function step(label, fn, summarize) {
  process.stdout.write(`\n── ${label}\n`);
  try {
    const result = await fn();
    console.log(summarize ? summarize(result) : show(result).slice(0, 600));
    passed++;
    return result;
  } catch (error) {
    console.log(`   FAILED: ${error.message}`);
    failed++;
    return null;
  }
}

const c = () => clientFor(NETWORK);

console.log(`network = ${NETWORK}`);

const info = await step('chain_info', () => chainInfo(c()), (r) =>
  `   chainId=${r.chain_id} block=${r.latest_block} baseFee=${r.gas.base_fee_gwei} gwei fullness=${r.gas.block_fullness}`);

await step('explain_selector（ネットワーク不要）', async () => explainSelector({ signature: 'transfer(address,uint256)' }), (r) =>
  `   ${r.canonical_form} -> ${r.function_selector}${r.function_selector === '0xa9059cbb' ? '  (期待値と一致)' : '  ← 不一致'}`);

await step('explain_selector（イベント）', async () => explainSelector({ signature: 'Transfer(address indexed from, address indexed to, uint256 value)' }), (r) =>
  `   topic0 = ${r.keccak256}`);

await step('account_info（EOA）', () => accountInfo(c(), { address: VITALIK }), (r) =>
  `   ${r.account_type} balance=${r.balance_eth} ETH nonce=${r.transactions_sent}`);

await step('account_info（コントラクト）', () => accountInfo(c(), { address: USDC }), (r) =>
  `   ${r.account_type} code=${r.code_size_bytes} bytes`);

const block = await step('read_block', () => readBlock(c(), { block: info ? info.latest_block - 3 : 'latest' }), (r) =>
  `   #${r.number} txs=${r.transaction_count} gasUsed=${r.gas_used} parent=${r.parent_hash.slice(0, 18)}…`);

const blockWithTxs = await step('read_block（tx 一覧つき）', () =>
  readBlock(c(), { block: block?.number ?? 'latest', include_transactions: true }), (r) =>
  `   先頭の tx = ${r.transactions?.[0] ?? '(なし)'}`);

if (blockWithTxs?.transactions?.[0]) {
  await step('read_transaction', () => readTransaction(c(), { hash: blockWithTxs.transactions[0] }), (r) =>
    `   status=${r.status} from=${r.from.slice(0, 12)}… value=${r.value_eth} ETH fee=${r.gas.fee_paid_eth} ETH selector=${r.calldata.function_selector}`);
}

await step('call_contract（USDC の totalSupply）', () =>
  callContract(c(), { address: USDC, signature: 'totalSupply()', outputs: ['uint256'] }), (r) =>
  `   ${r.called} -> ${r.decoded?.[0]}  (selector ${r.how_the_selector_was_derived.split('= ')[1]})`);

await step('call_contract（引数つき balanceOf）', () =>
  callContract(c(), { address: USDC, signature: 'balanceOf(address)', args: [VITALIK], outputs: ['uint256'] }), (r) =>
  `   balanceOf(vitalik) = ${r.decoded?.[0]} (6 桁小数の生値)`);

await step('read_token（ERC-20）', () => readToken(c(), { address: USDC, holder: VITALIK }), (r) =>
  `   ${r.standard} ${r.name} (${r.symbol}) decimals=${r.decimals} supply=${r.total_supply} holder=${r.holder_balance}`);

await step('read_token（ERC-721 + tokenURI）', () => readToken(c(), { address: BAYC, token_id: 1 }), (r) =>
  `   ${r.standard} ${r.name} (${r.symbol}) owner=${r.owner_of} uri=${String(r.token_uri).slice(0, 60)}`);

await step('read_events（USDC の Transfer）', () =>
  readEvents(c(), { address: USDC, event_signature: 'Transfer(address indexed from, address indexed to, uint256 value)', from_block: (info?.latest_block ?? 0) - 5, limit: 2 }), (r) =>
  `   topic0=${r.topic0.slice(0, 18)}… matches=${r.total_matches} 例: ${show(r.events[0]?.indexed ?? {}).replace(/\s+/g, ' ').slice(0, 120)}`);

await step('prepare_unsigned_transaction（EOA 宛の単純送金）', () =>
  prepareUnsignedTransaction(c(), { from: VITALIK, to: BURN, value_eth: '0.001' }), (r) =>
  `   ${r.signature_status} nonce=${r.unsigned_transaction.nonce} gas=${r.human_readable.gas_limit} maxFee=${r.human_readable.max_fee_gwei} gwei` +
  `${r.human_readable.gas_limit === '21000' ? '  (単純送金の 21000 と一致)' : ''}`);

await step('prepare_unsigned_transaction（revert を事前に検知する）', () =>
  prepareUnsignedTransaction(c(), { from: VITALIK, to: USDC, value_eth: '0.001' }), (r) =>
  `   gas=${r.human_readable.gas_limit ?? 'null'} → ${r.gas_estimate_failed ? '見積もり失敗を検知: ' + r.gas_estimate_failed.reason.slice(0, 70) : '（成功してしまった）'}`);

await step('prepare_unsigned_transaction（関数呼び出しつき）', () =>
  prepareUnsignedTransaction(c(), { from: VITALIK, to: USDC, signature: 'transfer(address,uint256)', args: [VITALIK, '1000000'] }), (r) =>
  `   calls=${r.human_readable.calls} data=${r.unsigned_transaction.data.slice(0, 30)}… gas=${r.human_readable.gas_limit}`);

await step('verify_anchor（一致しない例）', () =>
  verifyAnchor(c(), { tx_hash: blockWithTxs?.transactions?.[0] ?? '0x', text: 'この文字列はチェーンに刻まれていない' }), (r) =>
  `   anchored=${r.anchored} keccak=${r.keccak256.slice(0, 18)}… （false が正しい）`);

// 一致する例。実際の calldata から 32 バイトを取り出し、それを expected_hash として渡す。
// アンカーされた値を見つけられるかという照合ロジックそのものの確認。
const anchorTarget = await (async () => {
  for (const hash of (blockWithTxs?.transactions ?? []).slice(0, 40)) {
    const tx = await readTransaction(c(), { hash });
    if (tx.calldata.length_bytes >= 36) {
      const raw = await clientFor(NETWORK).send('eth_getTransactionByHash', [hash]);
      return { hash, word: '0x' + String(raw.input).slice(10, 74) };
    }
  }
  return null;
})();

if (anchorTarget) {
  await step('verify_anchor（一致する例）', () =>
    verifyAnchor(c(), { tx_hash: anchorTarget.hash, expected_hash: anchorTarget.word }), (r) =>
    `   anchored=${r.anchored} found_in=${r.found_in.join(',')} at block ${r.block_number} (${r.anchored_at_utc})` +
    `${r.anchored ? '' : '  ← true になるべき'}`);
} else {
  console.log('\n── verify_anchor（一致する例）\n   このブロックには calldata 付きの tx が無かったため省略');
}

await step('読み取り専用の境界（許可されていない RPC）', async () => {
  try {
    await c().send('eth_sendRawTransaction', ['0xdeadbeef']);
    throw new Error('通ってしまった。ホワイトリストが効いていない');
  } catch (error) {
    if (error.name !== 'RpcError') throw error;
    return { blocked: true, message: error.message };
  }
}, (r) => `   blocked=${r.blocked}  "${r.message.slice(0, 60)}…"`);

console.log(`\n${'='.repeat(60)}\npassed ${passed} / failed ${failed}`);
process.exit(failed ? 1 : 0);
