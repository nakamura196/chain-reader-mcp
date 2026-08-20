// 最小の ABI エンコーダ／デコーダ。
//
// 講義スライド「ABI — フロントエンドとコントラクトのインタフェース」に対応する。
// ライブラリを入れれば済むが、それだと ABI が魔法のままになる。
// 扱う型は address / uintN / intN / bool / bytes32 / string / bytes と、
// それらの動的配列に限る。プロトタイプの範囲としては十分。

import { selectorOf } from './keccak.js';

const WORD = 32;

const pad = (hex) => hex.padStart(64, '0');

/** "transfer(address,uint256)" -> { name, inputs: ["address","uint256"] } */
export function parseSignature(signature) {
  const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*)\)\s*$/s.exec(signature);
  if (!match) {
    throw new Error(`関数署名として読めません: ${signature}（例: "balanceOf(address)"）`);
  }
  const [, name, rawInputs] = match;
  const inputs = rawInputs.trim() === '' ? [] : splitTopLevel(rawInputs).map(normalizeType);
  return { name, inputs, canonical: `${name}(${inputs.join(',')})` };
}

/** タプル記法は扱わないが、括弧の入れ子で誤って分割しないようにはしておく。 */
function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

/** uint -> uint256 など、セレクタ計算に必要な正規化。 */
function normalizeType(type) {
  const t = type.trim().split(/\s+/)[0]; // "address owner" のような引数名を落とす
  if (t === 'uint') return 'uint256';
  if (t === 'int') return 'int256';
  if (t === 'uint[]') return 'uint256[]';
  if (t === 'int[]') return 'int256[]';
  return t;
}

const isDynamic = (type) => type === 'string' || type === 'bytes' || type.endsWith('[]');

function encodeValue(type, value) {
  if (type === 'address') {
    const hex = String(value).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`address として不正です: ${value}`);
    return pad(hex);
  }
  if (type === 'bool') {
    return pad(value ? '1' : '0');
  }
  if (/^uint\d*$/.test(type) || /^int\d*$/.test(type)) {
    let n = BigInt(value);
    if (n < 0n) n = (1n << 256n) + n; // 2 の補数
    return pad(n.toString(16));
  }
  if (/^bytes\d+$/.test(type)) {
    const hex = String(value).replace(/^0x/, '');
    return hex.padEnd(64, '0');
  }
  throw new Error(`エンコード未対応の型です: ${type}`);
}

function encodeDynamic(type, value) {
  if (type === 'string' || type === 'bytes') {
    const bytes = type === 'string'
      ? new TextEncoder().encode(String(value))
      : Uint8Array.from(String(value).replace(/^0x/, '').match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
    const lengthWord = pad(bytes.length.toString(16));
    const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const padded = body.padEnd(Math.ceil(bytes.length / WORD) * 64, '0');
    return lengthWord + padded;
  }
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    const items = Array.isArray(value) ? value : [];
    if (isDynamic(inner)) throw new Error(`入れ子の動的配列はこのプロトタイプでは扱いません: ${type}`);
    return pad(items.length.toString(16)) + items.map((v) => encodeValue(inner, v)).join('');
  }
  throw new Error(`エンコード未対応の型です: ${type}`);
}

/**
 * 関数呼び出しの calldata を作る。
 * @returns {{data: string, selector: string, canonical: string}}
 */
export function encodeCall(signature, args = []) {
  const { inputs, canonical } = parseSignature(signature);
  if (args.length !== inputs.length) {
    throw new Error(`引数の数が合いません。${canonical} は ${inputs.length} 個を要求していますが ${args.length} 個渡されました。`);
  }
  const selector = selectorOf(canonical);

  const head = [];
  const tail = [];
  let tailOffset = inputs.length * WORD;

  inputs.forEach((type, i) => {
    if (isDynamic(type)) {
      head.push(pad(tailOffset.toString(16)));
      const encoded = encodeDynamic(type, args[i]);
      tail.push(encoded);
      tailOffset += encoded.length / 2;
    } else {
      head.push(encodeValue(type, args[i]));
    }
  });

  return { data: selector + head.join('') + tail.join(''), selector, canonical };
}

function decodeStatic(type, word) {
  if (type === 'address') return '0x' + word.slice(24);
  if (type === 'bool') return BigInt('0x' + word) !== 0n;
  if (/^uint\d*$/.test(type)) return BigInt('0x' + word).toString();
  if (/^int\d*$/.test(type)) {
    const n = BigInt('0x' + word);
    return (n >= 1n << 255n ? n - (1n << 256n) : n).toString();
  }
  if (/^bytes\d+$/.test(type)) {
    const size = Number(type.slice(5));
    return '0x' + word.slice(0, size * 2);
  }
  throw new Error(`デコード未対応の型です: ${type}`);
}

/**
 * eth_call の戻り値をデコードする。
 * @param {string[]} outputs 例: ["uint256"] / ["string"] / ["address","uint256"]
 * @param {string} raw 0x つきの 16 進文字列
 */
export function decodeReturn(outputs, raw) {
  const hex = String(raw ?? '0x').replace(/^0x/, '');
  if (hex.length === 0) return outputs.map(() => null);

  const wordAt = (i) => hex.slice(i * 64, i * 64 + 64);

  return outputs.map(normalizeType).map((type, i) => {
    if (!isDynamic(type)) return decodeStatic(type, wordAt(i));

    const offset = Number(BigInt('0x' + wordAt(i))) * 2;
    const length = Number(BigInt('0x' + hex.slice(offset, offset + 64)));
    const bodyStart = offset + 64;

    if (type === 'string' || type === 'bytes') {
      const body = hex.slice(bodyStart, bodyStart + length * 2);
      const bytes = Uint8Array.from(body.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
      return type === 'string' ? new TextDecoder().decode(bytes) : '0x' + body;
    }

    const inner = type.slice(0, -2);
    return Array.from({ length }, (_, k) => decodeStatic(inner, hex.slice(bodyStart + k * 64, bodyStart + k * 64 + 64)));
  });
}

/**
 * ERC-20 の name()/symbol() には、string ではなく bytes32 を返す古い実装がある（MKR など）。
 * 標準どおりに読めなければ bytes32 として読み直す。
 */
export function decodeStringLoose(raw) {
  try {
    const [value] = decodeReturn(['string'], raw);
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // 下の bytes32 解釈に落ちる
  }
  const hex = String(raw ?? '0x').replace(/^0x/, '').slice(0, 64);
  if (hex.length === 0) return null;
  const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16))).filter((b) => b !== 0);
  const text = new TextDecoder().decode(bytes);
  return /^[\x20-\x7e]*$/.test(text) && text.length > 0 ? text : null;
}
