# Vonage Video 多言語字幕デモ (AWS サーバーレス)

スマホのブラウザ同士でビデオ会議をし、発言を **自分の選んだ言語の字幕** で表示するサンプルです。

- QR コード → ログイン画面（ユーザー名 / 日本語・English）→ 会議室（定員 4 名）
- 各映像に参加者名と言語をオーバーレイ表示。発話中の人は緑枠
- 他の人の発言は自分の言語に翻訳して字幕表示。同じ言語の相手なら翻訳しない（文字起こしだけ）
- マイクのミュート、ビデオの ON/OFF、退出ボタン（退出するとログイン画面に戻り、入力した名前・言語は残る）
- ログイン画面の下に「Powered by Vonage」リンク
- 1 回の会議は最大 3 分。画面上部に残り時間を表示し、時間になると全員を退出させる

## 構成

```
スマホ ──HTTPS──▶ CloudFront ─┬─ /*      → S3（静的ファイル: HTML/JS/CSS）
   │                          └─ /api/*  → Lambda (Node.js 22, Function URL + OAC)
   │                                         ├─ Vonage Video API  … セッション作成・トークン発行・在室人数確認
   │                                         ├─ Amazon Bedrock    … 翻訳 (Converse API)
   │                                         ├─ Transcribe        … ストリーミング用の署名付き URL 発行
   │                                         ├─ SSM Parameter Store … Vonage 秘密鍵 / ルーム→セッション対応 / 会議の開始時刻
   │                                         └─ EventBridge Scheduler … 会議の終了時刻に Lambda を起動して全員を切断
   ├──WebRTC──▶ Vonage Video（映像・音声、signal で字幕を配信）
   └──WebSocket─▶ Amazon Transcribe Streaming（自分の音声を直接送って文字起こし）
```

常時起動のサーバーはなく、すべて使った分だけの従量課金です（使わない間はほぼ 0 円）。

### 字幕の流れ

1. 話者の端末が、Vonage が使っているマイクの音声トラックを 16kHz PCM に変換して Transcribe Streaming に送る
2. 認識途中・確定の原文を Vonage の `signal` で全員に配信
3. 確定した文は、**自分と違う言語の参加者がいるときだけ** 話者の端末が `/api/translate`（Bedrock）を 1 回呼び、訳文を `signal` で配信
4. 受信側は自分と同じ言語なら原文、違えば訳文を表示（訳文が届くまでは原文を薄く表示）

翻訳は発話ごとに最大 1 回（受信者ごとに呼ばない）、ミュート中は Transcribe も止めるので、費用が増えにくい作りです。

### 会議時間の制限（最大 3 分）

「誰かが入室してから全員が退出するまで」を 1 回の会議とし、開始から 3 分（`MEETING_MAX_SECONDS`）で終了します。

- 最初の 1 人が入室したときに、サーバーが終了時刻を決めて SSM に保存します。途中から入室した人も同じ終了時刻を受け取ります
- 画面上部に残り時間を表示し（残り 30 秒で赤字）、0 になると各端末がログイン画面に戻ります
- 終了時刻には EventBridge Scheduler が Lambda を起動し、残っている接続を Vonage 側で強制切断します。改造したクライアントでも居座れません（Scheduler の起動は最大で 1 分ほど遅れることがあります）
- 全員が退出したあとに誰かが入室すると、新しい会議として 3 分のカウントが始まります
- 翻訳・文字起こし用のチケットは会議の終了時刻 + 60 秒まで、Vonage のトークンは発行から 2 分（接続に使うまで）だけ有効です

## AI モデルの選定

翻訳には **Claude Haiku 5.5**（推論プロファイル `jp.anthropic.claude-haiku-5-5`、データは国内リージョンで処理）を既定にしています。
このアカウント (ap-northeast-1) で候補モデルに同じ会話文を翻訳させて比べた結果です。

| モデル | 推論プロファイル ID | 応答時間 (実測) | 品質 (日⇄英の口語) |
|---|---|---|---|
| **Claude Haiku 5.5** (既定) | `jp.anthropic.claude-haiku-5-5` | 0.8〜2.2 秒 | ◎ 主語の省略・言い回しが自然。音声認識の誤字（「開いて」→ free）も文脈で補正 |
| Amazon Nova Micro | `apac.amazon.nova-micro-v1:0` | 約 0.35 秒 | ○ 簡単な文は十分。言い回しはやや直訳寄り |
| Amazon Nova 2 Lite | `jp.amazon.nova-2-lite-v1:0` | 約 0.4〜0.5 秒 | △ 英→日で意味を取り違えた例あり |

- 1 発話は入力 100 トークン・出力 40 トークン程度です。どのモデルでも 1 回の会議で数円〜数十円に収まり、文字起こしと映像の料金のほうがずっと大きくなります。なので **料金より、字幕の品質が効く Haiku 5.5** を選びました
- 遅延をさらに減らしたい・最安にしたい場合は、`.env` の `BEDROCK_MODEL_ID=apac.amazon.nova-micro-v1:0` で切り替えられます（Converse API なのでコード変更は不要）
- 文字起こしは Bedrock ではなく **Amazon Transcribe Streaming** を使います。Bedrock にはリアルタイム音声認識のモデルがないためです

## 料金の目安（デモ利用）

| サービス | 課金の単位 | 備考 |
|---|---|---|
| Vonage Video API | 参加者 × 分 | 単価は Vonage の料金ページで確認してください |
| Amazon Transcribe Streaming | 音声の秒数（話者ごと） | 1 人 1 分あたり数円。ミュート中は止まる |
| Amazon Bedrock | トークン数 | 上記のとおりごく少額 |
| Lambda / CloudFront / S3 / SSM / Scheduler | リクエスト数など | デモ程度なら無料枠に収まる程度 |

### 予算アラート

`.env` に `BUDGET_ALERT_EMAIL` を設定してデプロイすると、AWS Budgets に月額予算（既定 $100、`BUDGET_AMOUNT_USD`）が作られます。
実績が 80%・100% を超えたとき、または月末の予測が 100% を超えたときにメールが届きます。

予算の対象は次の 2 つの合計です。

- **`Project=vonage-video-sample` タグの付いたリソース:** CloudFront・Lambda・S3・ログ、Bedrock（タグ付きのアプリケーション推論プロファイル経由で呼ぶので、このプロジェクトの分だけ集計される）
- **Amazon Transcribe（アカウント全体）:** ストリーミング文字起こしはタグで集計できないため、サービス単位で合算しています。同じアカウントで他に Transcribe を使うと、その分も含まれます

タグで集計するには、Billing でコスト配分タグ `Project` を有効にする必要があります。タグ付きのリソースができてから Billing にタグが現れるまで最大 24 時間かかるので、**初回デプロイの翌日以降に** 次を実行してください。

```bash
AWS_PROFILE=kwc-v4g npm run activate-tag
```

有効化した日以降の費用がタグで集計されます。Vonage の料金は AWS の予算には含まれません。

## セットアップ

### 1. Vonage アプリケーションを用意

[Vonage ダッシュボード](https://dashboard.nexmo.com/applications) でアプリケーションを作り、**Video** を有効にします。
`Application ID` を控え、`private.key` をダウンロードします。

### 2. 設定

```bash
npm install
cp env.example .env          # VONAGE_APPLICATION_ID と DEMO_ACCESS_KEY を設定
```

`DEMO_ACCESS_KEY` は QR コードの URL に含める簡易キーです。URL を知らない人が入室したり、API を使ったりするのを防ぎます（例: `openssl rand -hex 8`）。

### 3. 秘密鍵を SSM Parameter Store に登録

```bash
AWS_PROFILE=kwc-v4g npm run put-key -- ./private.key
```

`/vonage-video-sample/private-key` に SecureString（標準パラメータなので無料）として保存されます。

### 4. デプロイ

```bash
AWS_PROFILE=kwc-v4g npm run deploy
```

出力の `JoinUrl` が入室用 URL です。初回は CloudFront の作成に数分かかります。

### 5. QR コードを作る

```bash
AWS_PROFILE=kwc-v4g npm run qr
```

ターミナルに QR が表示され、`qr.png` と `qr.html`（PC 画面に映す用）も作られます。

### 片付け

```bash
AWS_PROFILE=kwc-v4g npm run destroy
# SSM の秘密鍵とルーム情報はスタック外なので手動で削除
aws ssm delete-parameter --name /vonage-video-sample/private-key --profile kwc-v4g
for p in rooms meetings; do
  aws ssm delete-parameters --profile kwc-v4g --names $(aws ssm get-parameters-by-path \
    --path /vonage-video-sample/$p --query 'Parameters[].Name' --output text --profile kwc-v4g)
done
```

## ローカルで動かす

PC のブラウザなら `localhost` で HTTPS なしで動作確認できます（Bedrock と Transcribe は実 AWS を使います）。

```bash
# .env に VONAGE_PRIVATE_KEY_PATH=./private.key と AWS_PROFILE=kwc-v4g を追記
npm run dev        # → http://localhost:3000/?room=demo&k=<DEMO_ACCESS_KEY>
```

スマホから試すには HTTPS が必要なので、デプロイした URL を使ってください。

## URL パラメーター

| パラメーター | 例 | 説明 |
|---|---|---|
| `room` | `room=demo` | ルーム名（英数字・`-`・`_`、32 文字まで）。ルームごとに Vonage セッションを作る |
| `k` | `k=abcd1234` | `DEMO_ACCESS_KEY` |
| `stt` | `stt=webspeech` | 【実験的】文字起こしにブラウザ内蔵の Web Speech API を使う（AWS 費用ゼロ。ただし端末によっては WebRTC とマイクを取り合って動かない） |

## 「Powered by Vonage」リンクの設定

リンク先と UTM パラメーターは `frontend/config.js` の `POWERED_BY` で設定します。値を入れた項目だけが URL に付きます。

```js
utm: { utm_source: 'demo', utm_medium: 'qr', utm_campaign: 'video_sample', utm_content: '' },
// → https://kwcplus.kddi-web.com/service/vonage?utm_source=demo&utm_medium=qr&utm_campaign=video_sample
```

変更後は `npm run deploy` で反映されます。

## テスト

```bash
npm test                                                     # ユニットテスト（AWS・Vonage 不要）
AWS_PROFILE=kwc-v4g node test/integration.js ja.wav en.wav   # 実 Transcribe + Bedrock の結合テスト（16kHz モノラル WAV）
```

テスト用の音声は macOS なら次のコマンドで作れます。
`say -v Kyoko "こんにちは" -o ja.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 ja.aiff ja.wav`

## ファイル構成

```
backend/          Lambda (handler.js がルーター)
  vonage.js       セッション作成・トークン発行・接続数取得
  translate.js    Bedrock Converse による翻訳
  transcribe.js   Transcribe Streaming の署名付き URL
  ticket.js       入室者だけが API を使えるようにする署名付きチケット
  meeting.js      会議時間（開始時刻の保存・終了時の強制退出）
frontend/         静的ファイル（ビルド不要）
  app.js          画面・Vonage・字幕のロジック
  config.js       「Powered by Vonage」リンクの URL・UTM 設定
  stt-transcribe.js / eventstream.js / pcm-worklet.js   Transcribe Streaming クライアント
  stt-webspeech.js  Web Speech API 版（実験的）
lib/stack.js      CDK スタック
scripts/          秘密鍵の登録・QR コード作成・コスト配分タグの有効化
local/            ローカル開発サーバー
```

## 制限事項

- 定員は入室時にサーバー側（Vonage の接続数 API）で確認し、ほぼ同時に入室した場合は接続順で 5 人目以降を退出させます
- 字幕はサーバーに保存しません（会議ログは残りません）
- 対応言語は日本語と英語の 2 つです。`backend/config.js`・`backend/transcribe.js`・`frontend/i18n.js` を拡張すれば増やせます
- アクセス制御は URL に含める簡易キーだけです。デモ用途を前提としています
- アクセスキーを知っている人が改造したクライアントで入室 API を短時間に何度も呼ぶと、定員の 4 名を一時的に超えて接続できます。トークンの有効期限（2 分）と会議時間の上限（3 分）で、影響する範囲を絞っています
- 文字起こしの WebSocket は、チケットの期限が切れたあとも、すでに開いている接続はブラウザが閉じるまで続きます。費用は予算アラートで監視します
