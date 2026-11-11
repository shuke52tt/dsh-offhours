#!/usr/bin/env bash
# 社区版硬门：公开仓库/发布包中不允许出现特定工程名及其主机路径/凭据。
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PAT="he""mou|鹤""眸|x""slink|len""gr"
echo "== community-clean =="
hits=$(grep -RInE "$PAT" "$ROOT" \
  --exclude-dir=.git --exclude-dir=node_modules --exclude='*.tgz' 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "  FAIL 发现工程专属内容：" >&2
  printf '%s\n' "$hits" | sed 's/^/    /' >&2
  exit 1
fi
echo "  ok   无工程专属内容"
