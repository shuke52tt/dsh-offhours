#!/usr/bin/env bash
# 卡片入口契约：card-add 必须写全形状 + 盖 sourceSessionId；缺 session 时 pick 要给出可理解的原因。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

T=$(mktemp -d /tmp/ns-cards.XXXXXX); B="$T/board.json"
printf '{"version":1,"cards":[]}\n' > "$B"

echo "== e2e-cards =="
env DSH_SESSION_ID=session-card-test python3 "$NS_PY" card-add "$B" "卡片入口测试" \
  --tags auto --session session-card-test --no-explain >"$T/add.out" 2>&1
eq "card-add 成功" "$?" "0"
python3 - "$B" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding='utf-8'))['cards'][0]
need = ['id', 'title', 'status', 'tags', 'createdAt', 'updatedAt', 'sourceSessionId']
missing = [k for k in need if k not in c]
types = [k for k in ('createdAt', 'updatedAt') if not isinstance(c.get(k), (int, float))]
print('MISSING=' + ','.join(missing))
print('BADTYPES=' + ','.join(types))
print('TAGS=' + ','.join(c.get('tags') or []))
print('SID=' + c.get('sourceSessionId', ''))
PY
out=$(python3 "$NS_PY" card-add "$B" "卡片入口测试2" --tags auto --session session-card-test --no-explain 2>&1)
eq "第二张 card-add 成功" "$?" "0"
pick=$(python3 "$NS_PY" pick "$B" 2>/dev/null)
contains "pick 能挑中带 session 的卡" "$pick" '"runnableCount": 2'
contains "pick 带出 sourceSessionId" "$pick" 'session-card-test'

# 缺 session：不应再被误报成 hold
B2="$T/board2.json"; printf '{"version":1,"cards":[]}\n' > "$B2"
env -u DSH_SESSION_ID python3 "$NS_PY" card-add "$B2" "无会话卡" --tags auto --no-explain >/dev/null 2>&1
pick2=$(python3 "$NS_PY" pick "$B2" 2>/dev/null)
contains "缺 session 的卡被识别" "$pick2" '"missingSessionCount": 1'
contains "原因指向 card add" "$pick2" 'offhours card add'

done_report
