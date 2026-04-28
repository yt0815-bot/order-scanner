# 発注書スキャナー

アパレルバイヤー向け発注書画像読み取り＆Excel出力Webアプリ。

## ローカル起動

```bash
cd order-scanner
cp .env.example .env
# .env に ANTHROPIC_API_KEY を設定
npm install
node server.js
# → http://localhost:3000
```

## Renderへのデプロイ手順

1. [Render](https://render.com) にサインイン
2. **New → Web Service** を選択
3. GitHubリポジトリを連携（このディレクトリをpush済みのリポジトリを選択）
4. 以下を確認（render.yaml が自動認識される場合はスキップ可）：
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. **Environment Variables** に追加：
   - `ANTHROPIC_API_KEY` = あなたのAPIキー
6. **Create Web Service** をクリック → デプロイ完了

## 使い方

1. JPEG / PNG / HEIC の発注書画像を複数枚アップロード
2. **AIで読み取る** ボタンをクリック
3. 読み取り結果テーブルをインライン編集で修正
4. **Excelダウンロード** で3シート構成のxlsxを取得

## Excel出力内容

| シート | 内容 |
|--------|------|
| 明細 | カラー別全明細（小計は自動計算式） |
| スタイル別集計 | 品番ごとの合計枚数・金額 |
| カラー変換一覧 | 元表記→カタカナの変換記録 |
