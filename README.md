# chain-reader — 読み取り専用の Ethereum MCP サーバ

LLM に Ethereum を**自然言語で読ませる**ための MCP サーバ。
秘密鍵を持たず、署名も送信もしない。すべての結果に「その答えがどこから来たか」が付く。

Tim Weingärtner (HSLU)『Ethereum & Smart Contracts』最終章「ブロックチェーンと AI」の図を、
そのまま動く形にした教材プロトタイプとして書いた。

```
  LLM         ← 自然言語（「このアドレスは何者？」）
   ↓
  MCP         ← src/server.js
   ↓          ← コード／構造化言語（ABI エンコード）
  RPC         ← src/rpc.js
   ↓
ブロックチェーン
```

依存は `@modelcontextprotocol/sdk` と `zod` の 2 つだけ。
Keccak-256 も ABI エンコーダも自前で書いてある（後述の「なぜ自前で書いたか」）。

---

## 動かす

```
git clone <this repo> && cd chain-reader-mcp
npm ci --ignore-scripts
npm test        # 単体 13 件（ネットワーク不要）
npm run smoke   # 実チェーンに対して全ツールを 1 回ずつ
```

Claude Code に登録する。

```
claude mcp add chain-reader -- node "$PWD/src/server.js"
```

このディレクトリで `claude` を起動するなら `.mcp.json` があるので登録は不要。
Claude Desktop なら `claude_desktop_config.json` の `mcpServers` に同じ内容を書く。

環境変数で対象ネットワークを切り替えられる。既定は mainnet。

| 変数 | 値 |
|---|---|
| `ETH_NETWORK` | `mainnet` / `sepolia` / `holesky` / `local` |
| `ETH_RPC_URL` | 独自エンドポイント（指定するとネットワーク名より優先） |

いずれも API キー不要の公開エンドポイントを使う。`local` は `anvil` / `hardhat node` の
`http://127.0.0.1:8545` を見る。

---

## ツールと講義の対応

講義スライドそのものは別リポジトリ（私家版の日本語訳）にあるが、
節の名前だけ挙げておけば対応は追える。

| ツール | 対応するスライド | 何が見えるか |
|---|---|---|
| `chain_info` | ガスと取引手数料 / PoS | 基本手数料がブロックの混み具合で動くこと |
| `account_info` | 2種類のアカウント / Ethereum アドレス | コードの有無で EOA とコントラクトが分かれること |
| `read_transaction` | Etherscan でトランザクションを読む | 手数料 = ガス使用量 × 実効ガス価格 |
| `read_block` | ブロック | `parentHash` の連鎖が「改ざん不可能」の実体 |
| `call_contract` | ABI / Solidity 入門 | セレクタが keccak256(署名) の先頭 4 バイトであること |
| `read_token` | ERC-20 / ERC-721 / クロークの引換札 | 名称も記号もコントラクトの自己申告であること |
| `read_events` | イベント駆動の UI | `indexed` の引数だけが topic に載ること |
| `prepare_unsigned_transaction` | **MCP を使うときの注意** | 鍵を持たない側にできることの限界 |
| `explain_selector` | ABI | ネットワークに触らずセレクタを計算する（板書用） |
| `verify_anchor` | （論文側） | ハッシュのアンカリングで何が証明でき、何ができないか |

`lecture_walkthrough` プロンプトを選ぶと、1〜6 を順に辿る指示が入る。

### 講義でそのまま使える問いかけ

```
このネットワークはいま混んでいますか？
0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 は EOA ですか、コントラクトですか？
USDC の総供給量は？ その数字は誰が保証していますか？
transfer(address,uint256) のセレクタはなぜ 0xa9059cbb になるのですか？
私のアドレスから 0.001 ETH を送る取引を組み立ててください
```

最後の問いには、AI は組み立てた JSON を返すが**送れない**。
そこで「なぜ送れないのか」を説明させると、スライド「MCP を使うときの注意」の内容が
AI 自身の口から出てくる。

---

## 設計上の 2 つの約束

### 1. 鍵を持たない

`src/rpc.js` の `ALLOWED_METHODS` は読み取り専用メソッドの明示的なホワイトリスト。
`eth_sendRawTransaction` / `eth_sendTransaction` / `eth_sign` はそこに無く、
**呼ぼうとするとネットワークに出る前に落ちる**（単体テストで固定してある）。

署名の実装も秘密鍵の読み込みもこのリポジトリには存在しない。
LLM がどう誘導されても、ここから資金は動かない。

`prepare_unsigned_transaction` は、この境界を「できないこと」ではなく
**動く形で見せる**ためにある。nonce もガス見積もりも手数料も埋めた完成品を返し、
署名だけを人間に残す。講義スライドの
「MCP が安全に行えるのは、読み取り専用の呼び出しと、署名済みトランザクションの中継の 2 つに限られる」
がそのまま実装になっている。

### 2. 答えの出どころを捨てない

すべての結果に `_provenance` が付く。

```json
"_provenance": {
  "endpoint": "https://ethereum-rpc.publicnode.com",
  "network": "mainnet (Ethereum Mainnet)",
  "rpc_calls": ["eth_blockNumber (1309ms)", "eth_gasPrice (1416ms)", "eth_chainId (1769ms)", "eth_getBlockByNumber (1023ms)"],
  "note": "これは単一の RPC エンドポイントの応答であり、独立に検証したものではない。"
}
```

「ブロックチェーンだから正しい」で止めないための仕掛け。
LLM は数値を自信たっぷりに言い切る癖があるので、**どの主張がどの層に立っているかを
結果自体に持たせる**。サーバの `instructions` でも、チェーンが保証した事実と
誰かが申告した内容を区別して説明するよう指示している。

---

## 帰属できることと、検証できることは違う

このサーバの出力設計は、記録管理・デジタルアーカイブの文脈から来ている。
**言えること**と**それが本当であること**の差を、ツールの出力に埋め込んである。

**`read_token` の `self_reported_note`** — `name()` が "USD Coin" を返したという事実は
チェーンが保証する。しかしそのコントラクトが本当に Circle のものかは保証しない。
同じ名前と記号のコントラクトは誰でもデプロイできる。
チェーンが保証するのは「この住所のコードがこう答えた」ことまでで、その主張の真偽ではない。

**`verify_anchor` の `what_this_does_not_prove`** — アンカリングが与えるのは
「いつ・誰が・何を主張したか」であって「その主張が正しいか」ではない。
誤った測定値のハッシュも、正しい測定値のハッシュと同じように刻める。
真正性 (authenticity) は真実性 (truth) ではない、という古文書学の区別がそのまま出る。

**`_provenance`** — 記録の品質とは、その来歴グラフの形のことである、という考え方の最小実装。
どのエンドポイントが、どの RPC 呼び出しで、何ミリ秒で答えたか。
PROV-O でいう `prov:wasAttributedTo` を誰にするかを、後から決められる状態にしておく。

署名された申告 / 公開情報との突合 / TEE アテステーション / 機関的な認証 と層を上げていくと
検証の強度は増すが、どこまで行っても「測定器そのもの」は検証できない。
このプロトタイプが実演しているのはその最下層 —— **帰属はできるが検証はできない**領域。
だからこそ、どの層に立っている数値なのかを記録の側に残す。

---

## なぜ Keccak も ABI も自前で書いたか

`viem` や `ethers` を入れれば 3 行で済む。あえて書いた理由が 2 つある。

1. **講義の題材だから。** ABI が魔法のままでは「なぜ 4 バイトなのか」を説明できない。
   `src/keccak.js` と `src/abi.js` は合わせて 300 行ほどで、受講者が読み切れる。
2. **依存を 2 つに抑えられるから。** サプライチェーンの面積が小さいほど、
   3 年後に `npm ci` して動く確率が上がる。

Node の `crypto` にある `sha3-256` は NIST SHA-3 で、Ethereum の Keccak-256 とは
パディングが違う（`0x06` と `0x01`）ので流用できない。ここは実装するしかない。

対応範囲は `address` / `uintN` / `intN` / `bool` / `bytesN` / `string` / `bytes` と
その動的配列まで。タプルと入れ子の動的配列は扱わない。プロトタイプの範囲としては十分だが、
本番で任意のコントラクトを相手にするなら `viem` に置き換えること。

---

## 既知の限界

- **単一の RPC を信じている。** 複数エンドポイントに同じ問いを投げて突き合わせれば
  信頼の層が 1 つ上がる。実装していない
- **タプル型を扱えない。** Uniswap V3 の `slot0()` のような戻り値はデコードできない
- **`read_events` の走査範囲は既定で 200 ブロック。** 公開エンドポイントは
  広い `eth_getLogs` を拒否することがある
- **`verify_anchor` は部分文字列一致で探している。** アンカー用コントラクトの
  ABI が分かっているなら、正しく引数をデコードして照合すべき
- `local` ネットワーク以外は公開エンドポイント依存。講義当日に落ちている可能性を考えて、
  `anvil --fork-url` でローカルにフォークしておくと安全

## ファイル構成

```
src/keccak.js   Keccak-256（既知ベクタで固定）
src/abi.js      ABI エンコード／デコード
src/rpc.js      JSON-RPC クライアント + 読み取り専用ホワイトリスト
src/tools.js    ツール 10 個の実体。MCP から独立していて単体で呼べる
src/server.js   MCP サーバ（stdio）
test/unit.test.js      ネットワーク不要の単体テスト
test/smoke.mjs         実チェーンに対する疎通確認
test/mcp-handshake.mjs MCP プロトコルの往復確認
```
