# 作文・要約 かべうちAI（Vercel版）

子どもが型にそって書いた作文を、先生の「見本」と「観点」にそってAIが添削するアプリ。

## 構成
- `index.html` … アプリ本体（先生モードで見本・観点を作り、子どもが書く）
- `api/feedback.js` … Gemini を呼ぶサーバーレス関数。APIキーはここには書かず、Vercelの環境変数から読む。

## デプロイ手順（GitHub → Vercel）

1. **Google AI Studio でGeminiのAPIキーを発行**（無料・クレカ不要）
   - https://aistudio.google.com/ → 「Get API key」→ キーをコピー
2. **このフォルダをGitHubに上げる**
   - GitHubで空のリポジトリを作成（例: `kabeuchi-ai`）
   - このフォルダで:
     ```
     git remote add origin https://github.com/＜ユーザー名＞/kabeuchi-ai.git
     git branch -M main
     git push -u origin main
     ```
3. **Vercelでインポート**
   - https://vercel.com/ → Add New → Project → Import Git Repository → このリポジトリを選ぶ
   - デプロイ設定はそのままでOK（フレームワークなし・ビルドなし）
4. **環境変数を登録**（ここが唯一の手作業）
   - Vercelのプロジェクト → Settings → Environment Variables
   - `GEMINI_API_KEY` = 1で取ったキー を追加 → Save
   - （任意）`GEMINI_MODEL` = `gemini-2.5-flash`（既定）/ `gemini-2.5-flash-lite`（もっと安く）
5. **再デプロイ**（Deployments → 最新 → Redeploy）で環境変数が反映される

→ 発行されたURL（例 `https://kabeuchi-ai.vercel.app`）を子どもに配布。

## あとから変更したいとき
ファイルを直して `git push` すれば、Vercelが自動で再デプロイ（**URLは変わらない**）。

## 注意（無料枠）
- 30人が一斉に押すと、無料枠のレート制限でエラーになることがある（少し待って再送／本番は従量へ）。
- 無料枠は入力データがGoogleのサービス改善に使われることがある。子どもの作文は個人が特定できる内容を避ける。
- キー未設定・オフライン・エラー時は、アプリ内の簡易ルールベース添削に自動で切り替わる（止まらない）。

## Claude に変えたいとき
`api/feedback.js` の中だけ Anthropic API 呼び出しに差し替え、環境変数を `ANTHROPIC_API_KEY` にする。`index.html` の `askAI()` はそのままでよい。
