#!/usr/bin/env bash

set -euo pipefail

required_commands=(node npm)
required_files=(
  "package.json"
  "package-lock.json"
  "prisma/schema.prisma"
  "dist/index.js"
  "deploy/ecosystem.config.cjs"
  "deploy/nginx/cryptory.conf.example"
)
required_environment=(
  DATABASE_URL
  REDIS_URL
  JWT_SECRET
  GOOGLE_IOS_CLIENT_ID
  APPLE_CLIENT_ID
  APP_HOMEPAGE_URL
  TERMS_URL
  PRIVACY_POLICY_URL
  SUPPORT_URL
  ACCOUNT_DELETION_URL
  INVESTMENT_DISCLAIMER_URL
  COMMUNITY_POLICY_URL
  FIREBASE_PROJECT_ID
  FIREBASE_CLIENT_EMAIL
  FIREBASE_PRIVATE_KEY
  FCM_ENABLED
  FCM_DRY_RUN
  PRICE_ALERT_WORKER_ENABLED
)

echo "== Cryptory pre-cutover check =="

for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "MISSING_COMMAND: $command_name" >&2
    exit 1
  fi
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "UNSUPPORTED_NODE_MAJOR: $node_major (required: 22+)" >&2
  exit 1
fi

for file_path in "${required_files[@]}"; do
  if [[ ! -e "$file_path" ]]; then
    echo "MISSING_FILE: $file_path" >&2
    exit 1
  fi
done

missing_environment=()
for variable_name in "${required_environment[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    missing_environment+=("$variable_name")
  fi
done

if ((${#missing_environment[@]} > 0)); then
  echo "MISSING_ENVIRONMENT_NAMES:"
  printf '  %s\n' "${missing_environment[@]}"
  exit 1
fi

if [[ "${NODE_ENV:-}" != "production" ]]; then
  echo "INVALID_NODE_ENV: expected production" >&2
  exit 1
fi

if [[ "${PORT:-3000}" != "3000" || -n "${PUBLIC_MARKET_API_PORT:-}" && "${PUBLIC_MARKET_API_PORT}" != "3000" ]]; then
  echo "PORT_CONTRACT_MISMATCH: PORT and PUBLIC_MARKET_API_PORT must resolve to 3000" >&2
  exit 1
fi

if [[ "${APP_STORE_REVIEW_MODE:-}" != "true" ]]; then
  echo "APP_STORE_REVIEW_MODE_NOT_ENABLED" >&2
  exit 1
fi

if [[ "${FCM_DRY_RUN:-}" != "true" ]]; then
  echo "FCM_DRY_RUN_NOT_ENABLED" >&2
  exit 1
fi

if [[ "${PRICE_ALERT_WORKER_ENABLED:-}" != "false" ]]; then
  echo "PRICE_ALERT_WORKER_MUST_START_DISABLED" >&2
  exit 1
fi

echo "PASS: commands, files, Node version, environment names, port, and App Review mode"
echo "NOTE: no database migration, network call, PM2 action, or deployment was performed"
