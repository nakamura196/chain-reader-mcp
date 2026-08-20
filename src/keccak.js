// Keccak-256 (Ethereum 版) の実装。
//
// Node の crypto にある sha3-256 は NIST SHA-3 で、パディングが 0x06 始まり。
// Ethereum が使うのは標準化前の Keccak で、パディングは 0x01 始まり。
// 値が完全に違うので流用できない。依存を増やさないためここで実装する。
//
// 講義との対応: 関数セレクタは keccak256("transfer(address,uint256)") の先頭 4 バイト。
// この 1 ファイルがあるおかげで、ABI がどこから来るのかを実演できる。

const MASK64 = (1n << 64n) - 1n;

// ρ ステップの回転量。レーン番号 i = x + 5y の順に並べてある。
const RHO = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];

// ι ステップのラウンド定数（24 ラウンド）。
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const rotl = (v, n) => n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64;

function keccakF1600(state) {
  const B = new Array(25);
  const C = new Array(5);
  const D = new Array(5);

  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
    }
    for (let i = 0; i < 25; i++) {
      state[i] ^= D[i % 5];
    }

    // ρ と π
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], RHO[x + 5 * y]);
      }
    }

    // χ
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK64) & B[(x + 2) % 5 + 5 * y]);
      }
    }

    // ι
    state[0] ^= RC[round];
  }
}

/**
 * @param {Uint8Array} message
 * @returns {Uint8Array} 32 バイトのダイジェスト
 */
export function keccak256(message) {
  const RATE = 136; // (1600 - 2*256) / 8
  const state = new Array(25).fill(0n);

  // パディング: 0x01 ... 0x80（SHA-3 の 0x06 ではない）
  const padLen = RATE - (message.length % RATE);
  const padded = new Uint8Array(message.length + padLen);
  padded.set(message);
  padded[message.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;

  // 吸収
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      }
      state[lane] ^= value;
    }
    keccakF1600(state);
  }

  // 搾出（256 ビットは 1 ブロックに収まるので繰り返し不要）
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export const toHex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const keccak256Hex = (message) =>
  toHex(keccak256(typeof message === 'string' ? new TextEncoder().encode(message) : message));

/**
 * 関数セレクタ = keccak256(正規化した署名) の先頭 4 バイト。
 * 例: "transfer(address,uint256)" -> "0xa9059cbb"
 */
export const selectorOf = (signature) => keccak256Hex(signature).slice(0, 10);

/** イベントトピック0 = keccak256(イベント署名) の全 32 バイト。 */
export const eventTopic = (signature) => keccak256Hex(signature);
