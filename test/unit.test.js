// ネットワークに触らない単体テスト。`npm test` で走る。
// keccak と ABI は「合っているつもり」で外すと全部が静かに壊れるので、既知の値で固定する。

import test from 'node:test';
import assert from 'node:assert/strict';

import { keccak256Hex, selectorOf, eventTopic } from '../src/keccak.js';
import { encodeCall, decodeReturn, decodeStringLoose, parseSignature } from '../src/abi.js';
import { parseEventSignature, explainSelector } from '../src/tools.js';
import { RpcClient, formatEther, formatGwei } from '../src/rpc.js';

test('keccak256 は既知のテストベクタと一致する', () => {
  assert.equal(keccak256Hex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Hex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // rate (136 バイト) をまたぐ入力。吸収ループが 2 周する経路を通す。
  assert.equal(
    keccak256Hex('a'.repeat(200)),
    keccak256Hex(new TextEncoder().encode('a'.repeat(200))),
  );
});

test('関数セレクタが実在の値と一致する', () => {
  assert.equal(selectorOf('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selectorOf('balanceOf(address)'), '0x70a08231');
  assert.equal(selectorOf('totalSupply()'), '0x18160ddd');
  assert.equal(selectorOf('decimals()'), '0x313ce567');
  assert.equal(selectorOf('symbol()'), '0x95d89b41');
  assert.equal(selectorOf('name()'), '0x06fdde03');
  assert.equal(selectorOf('ownerOf(uint256)'), '0x6352211e');
  assert.equal(selectorOf('tokenURI(uint256)'), '0xc87b56dd');
  assert.equal(selectorOf('supportsInterface(bytes4)'), '0x01ffc9a7');
});

test('イベントの topic0 が実在の値と一致する', () => {
  assert.equal(
    eventTopic('Transfer(address,address,uint256)'),
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  );
  assert.equal(
    eventTopic('Approval(address,address,uint256)'),
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  );
});

test('署名の正規化で uint が uint256 になり、引数名は落ちる', () => {
  assert.deepEqual(parseSignature('transfer(address to, uint amount)').inputs, ['address', 'uint256']);
  assert.equal(parseSignature('transfer(address to, uint amount)').canonical, 'transfer(address,uint256)');
  assert.equal(selectorOf(parseSignature('transfer(address to, uint amount)').canonical), '0xa9059cbb');
});

test('calldata のエンコードが 32 バイト境界に揃う', () => {
  const { data, selector } = encodeCall('transfer(address,uint256)', ['0x000000000000000000000000000000000000dEaD', 1000000n]);
  assert.equal(selector, '0xa9059cbb');
  assert.equal(data.length, 2 + 8 + 64 * 2, '4 バイトのセレクタ + 32 バイト × 2');
  assert.ok(data.startsWith('0xa9059cbb'));
  assert.ok(data.includes('000000000000000000000000000000000000000000000000000000000000dead'));
  assert.ok(data.endsWith('00000000000000000000000000000000000000000000000000000000000f4240'));
});

test('引数の数が合わないとエンコードで落ちる', () => {
  assert.throws(() => encodeCall('transfer(address,uint256)', ['0x000000000000000000000000000000000000dEaD']), /引数の数が合いません/);
});

test('静的な型のデコード', () => {
  const word = (hex) => hex.padStart(64, '0');
  assert.equal(decodeReturn(['uint256'], '0x' + word('f4240'))[0], '1000000');
  assert.equal(decodeReturn(['address'], '0x' + word('dead'))[0], '0x000000000000000000000000000000000000dead');
  assert.equal(decodeReturn(['bool'], '0x' + word('1'))[0], true);
  assert.equal(decodeReturn(['bool'], '0x' + word('0'))[0], false);
  assert.equal(decodeReturn(['int256'], '0x' + 'f'.repeat(64))[0], '-1', '2 の補数');
});

test('動的な文字列のデコード（オフセット + 長さ + 本体）', () => {
  // "USD Coin" を ABI の string として組み立てたもの
  const body = Buffer.from('USD Coin', 'utf8').toString('hex').padEnd(64, '0');
  const encoded =
    '0x' +
    '0000000000000000000000000000000000000000000000000000000000000020' + // 本体へのオフセット = 32
    '0000000000000000000000000000000000000000000000000000000000000008' + // バイト長 = 8
    body;
  assert.equal(decodeReturn(['string'], encoded)[0], 'USD Coin');
});

test('bytes32 を返す古い ERC-20 でも名前が読める', () => {
  const bytes32 = '0x' + Buffer.from('Maker', 'utf8').toString('hex').padEnd(64, '0');
  assert.equal(decodeStringLoose(bytes32), 'Maker');
  assert.equal(decodeStringLoose('0x'), null);
});

test('イベント署名の indexed を拾い分ける', () => {
  const parsed = parseEventSignature('Transfer(address indexed from, address indexed to, uint256 value)');
  assert.equal(parsed.canonical, 'Transfer(address,address,uint256)');
  assert.deepEqual(parsed.params.map((p) => p.indexed), [true, true, false]);
  assert.equal(parsed.topic0, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
});

test('動的型を indexed にしたイベントは、値ではなくハッシュとして扱う', () => {
  // ABI 仕様: indexed の string / bytes / 配列 / 構造体は、topic に値ではなく
  // keccak ハッシュが載る。値として復号しようとすると壊れる（回帰防止）。
  const parsed = parseEventSignature('Named(string indexed label, uint256 value)');
  assert.deepEqual(parsed.params.map((p) => p.indexed), [true, false]);
  assert.equal(parsed.canonical, 'Named(string,uint256)');

  // 値として読もうとすると例外になることを固定しておく。
  // readEvents はこの型を検出してハッシュのまま返す（下の readEvents 側の分岐）。
  assert.throws(() => decodeReturn(['string'], '0x' + 'ab'.repeat(32)));
});

test('explain_selector は関数とイベントを区別する', () => {
  const fn = explainSelector({ signature: 'transfer(address,uint256)' });
  assert.equal(fn.function_selector, '0xa9059cbb');

  const ev = explainSelector({ signature: 'Transfer(address indexed from, address indexed to, uint256 value)' });
  assert.equal(ev.used_as, 'イベントの topic0。ログの絞り込みに使う。');
  assert.deepEqual(ev.indexed_params, ['address', 'address']);
  assert.deepEqual(ev.data_params, ['uint256']);
});

test('状態を変える RPC はホワイトリストで止まり、送信前に落ちる', async () => {
  // 到達不能な URL を渡す。ホワイトリストが先に効くなら fetch は起きない。
  const client = new RpcClient('http://127.0.0.1:1/never-reached');
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4']) {
    await assert.rejects(() => client.send(method, []), /許可されていません/, `${method} が素通りしている`);
  }
  assert.equal(client.trace.length, 0, 'ネットワークに出ていないこと');
});

test('wei の整形が丸めずに出る', () => {
  assert.equal(formatEther(10n ** 18n), '1');
  assert.equal(formatEther(1n), '0.000000000000000001');
  assert.equal(formatEther(1500000000000000000n), '1.5');
  assert.equal(formatGwei(1000000000n), '1');
  assert.equal(formatEther(0n), '0');
});
