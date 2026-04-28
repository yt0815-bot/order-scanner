#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  発注書スキャナー Render 自動デプロイスクリプト
#  フロー: GitHub API でリポジトリ作成 → push → Render API でデプロイ
#
#  必須環境変数:
#    RENDER_API_KEY   Render API キー  (rnd_xxx)
#    GITHUB_TOKEN     GitHub Personal Access Token (repo スコープ)
#  任意:
#    ANTHROPIC_API_KEY  Render 環境変数に自動設定
#    GITHUB_REPO_NAME   リポジトリ名 (デフォルト: order-scanner)
#    RENDER_SERVICE_NAME サービス名  (デフォルト: order-scanner)
# ============================================================

REPO_NAME="${GITHUB_REPO_NAME:-order-scanner}"
SERVICE_NAME="${RENDER_SERVICE_NAME:-order-scanner}"
RENDER_API="https://api.render.com/v1"
GITHUB_API="https://api.github.com"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---- 前提チェック ----
[[ -z "${RENDER_API_KEY:-}"  ]] && die "RENDER_API_KEY が未設定です"
[[ -z "${GITHUB_TOKEN:-}"    ]] && die "GITHUB_TOKEN が未設定です\n  取得: https://github.com/settings/tokens/new (repo スコープ)"
command -v curl >/dev/null || die "curl が必要です"
command -v jq   >/dev/null || die "jq が必要です (brew install jq)"
command -v git  >/dev/null || die "git が必要です"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  発注書スキャナー → Render デプロイ${NC}"
echo -e "${CYAN}  (GitHub API 経由 / 自動リポジトリ作成)${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# ---- API ヘルパー ----
gh_get()  { curl -sf -H "Authorization: token ${GITHUB_TOKEN}" -H "Accept: application/vnd.github.v3+json" "${GITHUB_API}${1}"; }
gh_post() { curl -sf -X POST -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d "$2" "${GITHUB_API}${1}"; }

render_get()  { curl -sf -H "Authorization: Bearer ${RENDER_API_KEY}" -H "Accept: application/json" "${RENDER_API}${1}"; }
render_post() { curl -sf -X POST -H "Authorization: Bearer ${RENDER_API_KEY}" -H "Content-Type: application/json" -d "$2" "${RENDER_API}${1}"; }

# ---- STEP 1: GitHub ユーザー確認 ----
info "GitHub アカウントを確認中..."
GH_USER_JSON=$(gh_get "/user") || die "GitHub API 認証失敗。GITHUB_TOKEN を確認してください。"
GH_USER=$(echo "$GH_USER_JSON" | jq -r '.login')
[[ -z "$GH_USER" || "$GH_USER" == "null" ]] && die "GitHub ユーザー名を取得できませんでした"
success "GitHub アカウント: ${GH_USER}"

# ---- STEP 2: GitHub リポジトリ確認/作成 ----
info "GitHub リポジトリ '${GH_USER}/${REPO_NAME}' を確認中..."
REPO_JSON=$(gh_get "/repos/${GH_USER}/${REPO_NAME}" 2>/dev/null || echo "{}")
REPO_EXISTS=$(echo "$REPO_JSON" | jq -r '.name // empty')

if [[ -n "$REPO_EXISTS" ]]; then
  success "既存リポジトリを使用: https://github.com/${GH_USER}/${REPO_NAME}"
else
  info "リポジトリを新規作成中..."
  CREATE_REPO=$(gh_post "/user/repos" \
    "{\"name\":\"${REPO_NAME}\",\"private\":true,\"auto_init\":false,\"description\":\"アパレル発注書スキャナー\"}") || \
    die "リポジトリ作成に失敗しました"
  success "リポジトリ作成: https://github.com/${GH_USER}/${REPO_NAME}"
  sleep 2
fi

# ---- STEP 3: git 初期化・コミット・push ----
info "コードを GitHub にプッシュ中..."

# git 未初期化なら init
if [[ ! -d .git ]]; then
  git init -b main
fi

# .gitignore がなければ作成
if [[ ! -f .gitignore ]]; then
  printf 'node_modules\n.env\n*.log\n' > .gitignore
fi

git add -A

# 変更があればコミット
if git diff --cached --quiet 2>/dev/null; then
  # ステージ済みの変更なし → 既存コミットをそのまま使う
  if ! git rev-parse HEAD &>/dev/null; then
    die "コミットがありません。ファイルを確認してください。"
  fi
else
  git commit -m "deploy: order-scanner $(date '+%Y-%m-%d %H:%M:%S')"
fi

# リモート設定（tokenを埋め込んでHTTPS認証）
REMOTE_URL="https://${GITHUB_TOKEN}@github.com/${GH_USER}/${REPO_NAME}.git"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"

git push -u origin main --force 2>&1 | grep -v "^remote:" | sed 's/^/  /' || true
success "push 完了: https://github.com/${GH_USER}/${REPO_NAME}"

# リモートURLをトークンなしに戻す（セキュリティ）
git remote set-url origin "https://github.com/${GH_USER}/${REPO_NAME}.git"

# ---- STEP 4: Render アカウント確認 ----
info "Render アカウントを確認中..."
OWNER_JSON=$(render_get "/owners?limit=1") || die "Render API 認証失敗。RENDER_API_KEY を確認してください。"
OWNER_ID=$(echo "$OWNER_JSON" | jq -r '.[0].owner.id // .[0].id // empty')
OWNER_NAME=$(echo "$OWNER_JSON" | jq -r '.[0].owner.name // .[0].name // "unknown"')
[[ -z "$OWNER_ID" ]] && die "Render オーナーIDを取得できませんでした"
success "Render アカウント: ${OWNER_NAME} (${OWNER_ID})"

# ---- STEP 5: 環境変数ペイロード組み立て ----
ENV_VARS_JSON='[{"key":"NODE_ENV","value":"production"},{"key":"PORT","value":"3000"}]'
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ENV_VARS_JSON=$(echo "$ENV_VARS_JSON" | jq \
    --arg k "ANTHROPIC_API_KEY" --arg v "$ANTHROPIC_API_KEY" \
    '. + [{"key":$k,"value":$v}]')
  info "ANTHROPIC_API_KEY を環境変数に含めます"
else
  warn "ANTHROPIC_API_KEY 未設定 — Render ダッシュボードで後から設定してください"
fi

# ---- STEP 6: Render サービス確認・作成 / 再デプロイ ----
info "Render サービス '${SERVICE_NAME}' を確認中..."
SERVICES_JSON=$(render_get "/services?limit=100") || SERVICES_JSON="[]"
SERVICE_ID=$(echo "$SERVICES_JSON" | jq -r --arg n "$SERVICE_NAME" \
  '.[] | select(.service.name == $n) | .service.id' | head -1)

REPO_HTML_URL="https://github.com/${GH_USER}/${REPO_NAME}"
DEPLOY_ID=""

if [[ -n "$SERVICE_ID" ]]; then
  success "既存サービスを発見: ${SERVICE_ID}"
  info "再デプロイをトリガー中..."
  DEPLOY_RESULT=$(render_post "/services/${SERVICE_ID}/deploys" '{"clearCache":"do_not_clear"}') || \
    die "再デプロイのトリガーに失敗しました"
  DEPLOY_ID=$(echo "$DEPLOY_RESULT" | jq -r '.id // .deploy.id // empty')

else
  info "新規サービスを作成中..."
  CREATE_PAYLOAD=$(jq -n \
    --arg name   "$SERVICE_NAME" \
    --arg owner  "$OWNER_ID" \
    --arg repo   "$REPO_HTML_URL" \
    --argjson env "$ENV_VARS_JSON" \
    '{
      type: "web_service",
      name: $name,
      ownerId: $owner,
      repo: $repo,
      autoDeploy: "yes",
      branch: "main",
      envVars: $env,
      serviceDetails: {
        env: "node",
        buildCommand: "npm install",
        startCommand: "node server.js",
        plan: "free",
        region: "oregon"
      }
    }')

  CREATE_RESULT=$(render_post "/services" "$CREATE_PAYLOAD") || \
    die "サービス作成に失敗しました。\nRender と GitHub の連携が必要な場合:\n  https://dashboard.render.com/select-repo\nで GitHub アプリを認証してください。"

  SERVICE_ID=$(echo "$CREATE_RESULT" | jq -r '.service.id // .id // empty')
  [[ -z "$SERVICE_ID" ]] && die "サービスIDを取得できませんでした\n$CREATE_RESULT"
  success "サービス作成完了: ${SERVICE_ID}"

  sleep 5
  DEPLOYS_JSON=$(render_get "/services/${SERVICE_ID}/deploys?limit=1")
  DEPLOY_ID=$(echo "$DEPLOYS_JSON" | jq -r '.[0].deploy.id // .[0].id // empty')
fi

[[ -z "$DEPLOY_ID" ]] && die "デプロイIDを取得できませんでした"
success "デプロイ開始: ${DEPLOY_ID}"

# ---- STEP 7: デプロイ完了待ち ----
echo ""
info "デプロイ状況を監視中... (最大 15 分)"
echo ""

MAX_WAIT=900
INTERVAL=15
ELAPSED=0
LAST_STATUS=""

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  DEPLOY_INFO=$(render_get "/services/${SERVICE_ID}/deploys/${DEPLOY_ID}" 2>/dev/null) || {
    sleep $INTERVAL; ((ELAPSED+=INTERVAL)); continue
  }
  STATUS=$(echo "$DEPLOY_INFO" | jq -r '.status // .deploy.status // "unknown"')

  if [[ "$STATUS" != "$LAST_STATUS" ]]; then
    TS=$(date '+%H:%M:%S')
    case "$STATUS" in
      created|pending)    echo -e "  ${YELLOW}[${TS}]${NC} ⏳ 待機中..." ;;
      build_in_progress)  echo -e "  ${CYAN}[${TS}]${NC}  ビルド中 (npm install)..." ;;
      update_in_progress) echo -e "  ${CYAN}[${TS}]${NC} 🚀 サービス起動中..." ;;
      live)               break ;;
      build_failed)       die "ビルド失敗 — Render ダッシュボードのログを確認してください\n  https://dashboard.render.com" ;;
      update_failed)      die "デプロイ失敗 — Render ダッシュボードのログを確認してください" ;;
      canceled)           die "デプロイがキャンセルされました" ;;
      *)                  echo -e "  [${TS}] ステータス: ${STATUS}" ;;
    esac
    LAST_STATUS="$STATUS"
  fi

  sleep $INTERVAL
  ((ELAPSED+=INTERVAL))
done

[[ "$STATUS" != "live" ]] && die "タイムアウト (${MAX_WAIT}秒) — 最終ステータス: ${STATUS}"

# ---- 完了 ----
SERVICE_INFO=$(render_get "/services/${SERVICE_ID}" 2>/dev/null || echo "{}")
SERVICE_URL=$(echo "$SERVICE_INFO" | jq -r '.serviceDetails.url // .service.serviceDetails.url // ""')

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  デプロイ完了！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
success "GitHub リポジトリ : https://github.com/${GH_USER}/${REPO_NAME}"
success "Render サービスID : ${SERVICE_ID}"
[[ -n "$SERVICE_URL" ]] && success "アプリURL         : ${SERVICE_URL}"
echo ""
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  warn "ANTHROPIC_API_KEY が未設定です"
  warn "→ Render ダッシュボード > ${SERVICE_NAME} > Environment で設定してください"
fi
echo ""
