#!/usr/bin/env bash
# CLI 端到端：offhours init → doctor → card add → run --force → status
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
T=$(mktemp -d /tmp/offhours-cli.XXXXXX)
R=$T/repo; C=$T/config.json; B=$T/KANBAN.json
mkdir -p "$R" "$T/bin"
git init -q -b main "$R"; git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo base > "$R/f.txt"; git -C "$R" add -A; git -C "$R" commit -qm init
cat > "$T/bin/fake-dsh" <<'EOS'
#!/usr/bin/env bash
echo "cli-worker-change" >> f.txt
echo "KANBAN-RESULT: done"
echo "KANBAN-SYSTEM: system"
echo "KANBAN-SUMMARY: CLI fake worker 完成"
echo "KANBAN-EVIDENCE: echo cli-ok"
echo "KANBAN-NOTE: 无"
EOS
chmod +x "$T/bin/fake-dsh"

ok=0; bad=0
ck(){ if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "  ok   $1"; else bad=$((bad+1)); echo "  FAIL $1（期望 [$3] 实际 [$2]）"; fi; }

echo "== e2e-cli =="
DSH_SESSION_ID=session-cli node "$ROOT/bin/offhours.mjs" init --repo "$R" --name demo --board "$B" \
  --config "$C" --feature src --session session-cli --state-dir "$T/state" --features-root "$T/features" \
  >"$T/init.out" 2>&1
ck "init 退出码" "$?" "0"
[ -f "$C" ] && ck "配置已写" "yes" "yes" || ck "配置已写" "no" "yes"

# 用假 worker 跑一轮；只改测试配置，不改 init 生成的其它字段
python3 - "$C" "$T/bin/fake-dsh" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['worker']['dshBin']=sys.argv[2]; json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)
PY

DSH_SESSION_ID=session-cli node "$ROOT/bin/offhours.mjs" doctor --config "$C" >"$T/doctor.out" 2>&1
ck "doctor 退出码" "$?" "0"

DSH_SESSION_ID=session-cli node "$ROOT/bin/offhours.mjs" card add "CLI 测试卡" --summary "目标：跑通 CLI；判据：status done" \
  --tags auto --no-explain --board demo --config "$C" >"$T/card.out" 2>&1
ck "card add 退出码" "$?" "0"
sid=$(python3 -c "import json;print(json.load(open('$B'))['cards'][0].get('sourceSessionId'))" 2>/dev/null)
ck "卡片盖了 session" "$sid" "session-cli"

DSH_SESSION_ID=session-cli timeout 180 node "$ROOT/bin/offhours.mjs" run --force --board demo --config "$C" >"$T/run.out" 2>&1
ck "run --force 退出码" "$?" "0"
st=$(python3 -c "import json;print(json.load(open('$B'))['cards'][0].get('status'))" 2>/dev/null)
ck "卡片 done" "$st" "done"
ck "worker 改动已在 main" "$(grep -c cli-worker-change "$R/f.txt" 2>/dev/null)" "1"

DSH_SESSION_ID=session-cli node "$ROOT/bin/offhours.mjs" status --config "$C" >"$T/status.out" 2>&1
ck "status 退出码" "$?" "0"
done_n=$(python3 - "$T/status.out" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(1 if d['counts']['done'] >= 1 else 0)
PY
)
ck "status 里至少 1 张 done（含回执）" "$done_n" "1"

echo
echo "结果：ok=$ok bad=$bad"
[ "$bad" = 0 ]
