#!/usr/bin/env bash
# superagent 桥接（方案 A）端到端：card → fake Gitea issue → PR open → merged。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
T=$(mktemp -d /tmp/oh-sa.XXXXXX); mkdir -p "$T/bin" "$T/repo"
cat > "$T/bin/fake-gitea" <<'PY'
#!/usr/bin/env python3
import json, os, sys
p=os.environ["FAKE_STATE"]
try: st=json.load(open(p))
except Exception: st={}
args=sys.argv[1:]; assert args[0]=="api"; path=args[1]; method="GET"; fields={}; i=2
while i<len(args):
    a=args[i]
    if a in ("--method","-X"): method=args[i+1]; i+=2
    elif a in ("-f","--field","--raw-field"):
        k,_,v=args[i+1].partition("="); fields[k]=v; i+=2
    else: i+=1
if path=="repos/demo/demo/issues" and method=="POST":
    st["issue"]={"number":1,"state":"open","html_url":"https://gitea.test/demo/demo/issues/1","title":fields.get("title"),"body":fields.get("body")}
    st["comments"]=[]; st["pr"]=None; json.dump(st,open(p,"w")); print(json.dumps(st["issue"])); raise SystemExit(0)
if path=="repos/demo/demo/issues/1": print(json.dumps(st.get("issue",{"number":1,"state":"open"}))); raise SystemExit(0)
if path=="repos/demo/demo/issues/1/comments": print(json.dumps(st.get("comments",[]))); raise SystemExit(0)
if path=="repos/demo/demo/pulls/7": print(json.dumps(st.get("pr",{"number":7,"state":"open","merged":False}))); raise SystemExit(0)
print("[]")
PY
chmod +x "$T/bin/fake-gitea"; : > "$T/token"
python3 - "$T" <<'PY'
import json,sys
T=sys.argv[1]
json.dump({"version":1,"cards":[{"id":"card-auto","title":"桥接测试卡","status":"todo","tags":["auto"],"summary":"目标：跑通桥接","description":"目标：跑通桥接","sourceSessionId":"session-test","createdAt":1,"updatedAt":1}]},open(T+"/KANBAN.json","w"),ensure_ascii=False,indent=2)
json.dump({"version":1,"executor":"superagent","stateDir":T+"/state","featuresRoot":T+"/features","dshHome":"/root/.dsh","dshBin":"dsh","scheduler":"plugin","superagent":{"cli":T+"/bin/fake-gitea","tokenFile":T+"/token","repo":"demo/demo","baseUrl":"https://gitea.test","orchestratorUrl":"http://127.0.0.1:9"},"repos":{"demo":{"path":T+"/repo"}},"boards":[{"id":"demo","file":T+"/KANBAN.json","workdir":T+"/repo","repos":["demo"],"executor":"superagent"}],"gates":{"maxCardsPerRun":1,"maxCardsPerDay":8,"maxCnyPerDay":20,"runTimeout":600,"cooldownMin":0,"idleMin":0,"maxParallel":1,"stormMax":10},"schedule":{"enabled":True,"intervalMin":5,"jitterSec":0},"worker":{"permissionMode":"danger-full-access"}},open(T+"/config.json","w"),ensure_ascii=False,indent=2)
PY
export FAKE_STATE="$T/state.json" NIGHTSHIFT_BOARD="$T/KANBAN.json" NIGHTSHIFT_WORKDIR="$T/repo" \
  NIGHTSHIFT_RUNTIME_DIR="$T/state" NIGHTSHIFT_EXECUTOR=superagent NIGHTSHIFT_SUPERAGENT_CONFIG="$T/config.json" \
  MAX_CARDS_PER_RUN=1 NIGHTSHIFT_FORCE=1
echo '== scan dispatch'
bash "$ROOT/mechanism/scan.sh" --force >/tmp/sa-scan.out 2>&1; rc=$?
[ "$rc" = 0 ] || { echo "scan 失败 rc=$rc"; tail -20 /tmp/sa-scan.out; exit 1; }
python3 -c "import json;d=json.load(open('$T/KANBAN.json'));c=d['cards'][0];assert c['status']=='in_progress' and c['superagentIssue']['number']==1,c;print('card',c['status'],c['superagentIssue'])"
echo '== scan sync PR open'
python3 - "$T" <<'PY'
import json,sys
T=sys.argv[1];st=json.load(open(T+"/state.json"));st["comments"]=[{"body":"PR https://gitea.test/demo/demo/pulls/7"}];st["pr"]={"number":7,"state":"open","merged":False,"html_url":"https://gitea.test/demo/demo/pulls/7"};json.dump(st,open(T+"/state.json","w"))
PY
bash "$ROOT/mechanism/scan.sh" --force >/tmp/sa-scan2.out 2>&1 || { tail -20 /tmp/sa-scan2.out; exit 1; }
python3 -c "import json;d=json.load(open('$T/KANBAN.json'));c=d['cards'][0];assert c['status']=='review' and c['superagentState']=='pr-open',c;print('card',c['status'],c['superagentState'])"
echo '== scan sync PR merged'
python3 - "$T" <<'PY'
import json,sys
T=sys.argv[1];st=json.load(open(T+"/state.json"));st["pr"]={"number":7,"state":"closed","merged":True,"html_url":"https://gitea.test/demo/demo/pulls/7"};st["issue"]["state"]="closed";json.dump(st,open(T+"/state.json","w"))
PY
bash "$ROOT/mechanism/scan.sh" --force >/tmp/sa-scan3.out 2>&1 || { tail -20 /tmp/sa-scan3.out; exit 1; }
python3 -c "import json;d=json.load(open('$T/KANBAN.json'));c=d['cards'][0];assert c['status']=='done' and c['superagentState']=='merged',c;print('card',c['status'],c['superagentState'])"
python3 "$ROOT/tests/superagent_ticket_test.py" "$ROOT/mechanism"
echo "结果：superagent 桥接 PASS"
