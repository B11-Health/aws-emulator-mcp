"""Render a portable, offline GTM benchmark dashboard from sanitized evidence.

No browser dependencies, no network requests, no runtime secrets.
"""
from __future__ import annotations
import argparse
import datetime
import html
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def payload(report: dict) -> dict:
    measure=report.get("measurements",{})
    return {
        "timestamp":str(report.get("timestamp_utc","unknown")),
        "version":str(report.get("version","unknown")),
        "git_commit":str(report.get("provenance",{}).get("git_commit") or "")[:12],
        "emulator_version":(str(report.get("provenance",{}).get("emulator_version") or "").splitlines() or [""])[0][:80],
        "engineering_pass":bool(report.get("engineering_pass",False)),
        "public_release_approved":False,
        "repetitions":int(report.get("repetitions",0)),
        "tool_count":int(measure.get("tool_count",0)),
        "p95":measure.get("order_p95_seconds"),
        "gates":[{
            "name":str(item.get("name","")),
            "status":"PASS" if item.get("status")=="PASS" else "FAIL",
            "observed":str(item.get("observed","")),
            "threshold":str(item.get("threshold","")),
        } for item in report.get("gates",[])],
        "orders":[{
            "ms":float(row.get("ms",0)),
            "steps":int(row.get("steps",0)),
            "recovery":int(row.get("recovery",0)),
            "cleanup":int(row.get("cleanup",0)),
            "passed":bool(row.get("passed",False)),
        } for row in measure.get("orders",[])],
        "selftests":[{
            "ms":float(row.get("ms",0)),
            "checks":int(row.get("checks",0)),
            "cleanup":int(row.get("cleanup",0)),
            "passed":bool(row.get("passed",False)),
        } for row in measure.get("selftest",[])],
        "release_blockers":[str(x) for x in report.get("independent_release_blockers",[])],
    }

HTML=r'''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>AWS Emulator MCP / Release Evidence</title>
<style>
:root{--bg:#08131e;--panel:#102131;--panel2:#13293a;--line:#294457;--ink:#eaf6fb;--muted:#9db6c5;--accent:#62e4d9;--green:#92e6b4;--gold:#ffca83;--warn:#f2a99a;--shadow:0 16px 50px rgba(0,0,0,.19);font:16px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse 55vw 70vh at 88% 2%,rgba(25,101,128,.2),transparent),radial-gradient(ellipse 48vw 65vh at 4% 70%,rgba(22,64,108,.18),transparent),var(--bg);color:var(--ink)}
button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.shell{max-width:1370px;margin:0 auto;padding:32px clamp(18px,4vw,64px) 90px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid var(--line);padding-bottom:25px}
.brand{font-size:23px;font-weight:850;letter-spacing:.14em;display:flex;gap:15px;align-items:center}
.bar{width:5px;height:35px;background:var(--accent);border-radius:4px}
.eyebrow,.chip,.mono{font-family:"SFMono-Regular",Consolas,Monaco,monospace}
.micro{font-size:11px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase}
.link{color:var(--accent);text-decoration:none;font-size:14px}
.kicker{margin:64px 0 17px;color:var(--accent);font:700 12px/1.4 "SFMono-Regular",Consolas,monospace;letter-spacing:.18em;text-transform:uppercase}
h1{font-size:clamp(40px,5.9vw,84px);line-height:1.01;letter-spacing:-.065em;margin:0 0 24px;font-weight:780}
h1 em{font-style:normal;color:var(--accent)}
.lede{color:#b9cfdb;max-width:760px;font-size:clamp(17px,2.1vw,22px);line-height:1.54}
.toprow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:26px 0 34px}
.status{display:inline-flex;align-items:center;gap:9px;border-radius:99px;padding:9px 13px;background:#142b39;border:1px solid #27604e;font-size:12px;font-weight:750;letter-spacing:.04em;color:var(--green)}
.dot{display:inline-block;width:7px;height:7px;background:currentColor;border-radius:100%}
.note{font-size:13px;color:var(--muted)}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:34px}
.metric{border:1px solid var(--line);border-radius:19px;padding:25px 23px 24px;background:linear-gradient(150deg,rgba(27,55,70,.84),rgba(14,30,44,.84));box-shadow:var(--shadow);min-height:160px}
.metric-label{color:var(--muted);font-size:12px;letter-spacing:.11em;text-transform:uppercase;font-weight:700}
.metric-value{font-size:clamp(38px,4.6vw,62px);font-weight:800;letter-spacing:-.06em;margin:7px 0 5px;line-height:1.15}
.metric:nth-child(2) .metric-value{color:var(--accent)}
.metric:nth-child(4) .metric-value{color:var(--green)}
.metric-sub{color:var(--muted);font-size:13px}
.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-top:43px;margin-bottom:17px}
h2{font-size:24px;letter-spacing:-.025em;margin:0}h3{font-size:17px;margin:0 0 10px}
.panel{background:linear-gradient(170deg,rgba(19,41,59,.96),rgba(12,28,42,.96));border:1px solid var(--line);border-radius:20px;padding:25px;box-shadow:var(--shadow)}
.chart-top{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}
.legend{color:var(--muted);font-size:12px;display:flex;gap:18px}
.legend span{display:flex;align-items:center;gap:8px}
.legend .key{width:10px;height:10px;background:var(--accent);border-radius:2px}
.legend .key.alt{background:#7597fc}
.chart{display:block;width:100%;height:290px;margin:28px 0 6px;overflow:visible}
.chart line{stroke:#254052;stroke-width:1}
.chart text{fill:#a0bccc;font-family:Consolas,monospace;font-size:12px}
.chart .bar1{fill:var(--accent)}.chart .bar2{fill:#799cfa}
.chart .bar1:hover,.chart .bar2:hover{filter:brightness(1.3)}
.gates{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.gate{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:rgba(10,26,39,.7);display:flex;align-items:center;justify-content:space-between;gap:15px}
.gate strong{font-size:14px;text-transform:capitalize}
.gate small{display:block;color:var(--muted);font:12px/1.65 Consolas,monospace;margin-top:4px}
.pass{color:var(--green)}.fail{color:var(--warn)}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}
.callout{padding:22px;border:1px solid var(--line);border-radius:17px;background:rgba(17,40,57,.68)}
.callout h3{color:var(--accent);font-size:15px}
.callout p,.callout li{font-size:13px;color:#b8ceda;line-height:1.68}
.callout ul{padding-left:18px}
.minirow{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #244253;padding:11px 0}
.minirow:last-child{border:0}
.minirow strong{font-weight:650}
.footer{display:flex;gap:15px;justify-content:space-between;flex-wrap:wrap;margin-top:50px;border-top:1px solid var(--line);padding-top:20px;color:var(--muted);font-size:12px}
.instruction{color:var(--gold);font-weight:650}
.hidden{display:none}
.tabrow{display:flex;gap:8px;margin:6px 0 24px}
.tabrow button{background:#142a3b;border:1px solid var(--line);color:var(--muted);padding:10px 18px;border-radius:10px;font-size:13px;font-weight:700}
.tabrow button[aria-selected=true]{color:#0c2530;background:var(--accent);border-color:var(--accent)}
.empty{padding:20px;color:var(--muted);text-align:center}
@media(max-width:1020px){.metrics{grid-template-columns:repeat(2,1fr)}.grid3{grid-template-columns:1fr}.gates{grid-template-columns:1fr}}
@media(max-width:630px){.shell{padding-top:21px}.nav{align-items:start}.metrics{gap:9px}.metric{padding:16px;min-height:132px}.metric-value{font-size:39px}.section-head{display:block}.chart{height:220px}.kicker{margin-top:42px}.toprow{margin-top:20px}}
</style></head><body><div class="shell">
<header class="nav"><div class="brand"><span class="bar" aria-hidden="true"></span>AWS EMULATOR MCP</div><div style="text-align:right"><div class="micro">Engineering Evidence / B11-Health</div><div class="micro" style="margin-top:5px">AWS Emulator MCP</div></div></header>
<div class="kicker">Build · Test · Verify · Repeat</div>
<h1>Ship proof.<br><em>Not promises.</em></h1>
<p class="lede">A reproducible, evidence-first local benchmark. Every metric below comes from actual AWS Emulator MCP checks—not estimates, production cloud claims, or fabricated success screens.</p>
<div class="toprow"><span class="status" id="engine-state"><span class="dot"></span><span id="engine-text"></span></span><span class="note" id="report-meta"></span></div>
<section class="metrics" id="metrics" aria-label="Release metrics"></section>
<section><div class="section-head"><div><div class="micro" style="margin-bottom:8px">RELIABILITY AND PERFORMANCE</div><h2>Real workload latency</h2></div><div class="legend"><span><i class="key"></i>Order workflow</span><span><i class="key alt"></i>Service self-test</span></div></div>
<div class="panel"><div class="chart-top"><p class="note">Five isolated repetitions per scenario · measured on the local host</p><span class="micro" id="chart-p95"></span></div><svg id="latency-chart" class="chart" viewBox="0 0 960 270" role="img" aria-label="Benchmark run latencies"></svg><div class="note">Includes resource creation, asynchronous readiness, verification, and scoped cleanup. Local emulator timing is not production AWS latency.</div></div></section>
<section><div class="section-head"><div><div class="micro" style="margin-bottom:8px">AUTOMATED ACCEPTANCE</div><h2>Engineering release gates</h2></div><div class="note">Every required gate must pass; public launch is separate.</div></div><div class="gates" id="gates"></div></section>
<section><div class="section-head"><div><div class="micro" style="margin-bottom:8px">SCENARIO EVIDENCE</div><h2>What actually ran</h2></div></div>
<div class="tabrow"><button type="button" id="tab-orders" aria-selected="true">Order workflows</button><button type="button" id="tab-services" aria-selected="false">Service checks</button></div>
<div class="panel" id="detail-panel"></div></section>
<section><div class="section-head"><div><div class="micro" style="margin-bottom:8px">HONEST SHIP CRITERIA</div><h2>What this result does—and does not—prove</h2></div></div>
<div class="grid3">
<div class="callout"><h3>✓ Verified locally</h3><p>MCP tool discovery, repeatable STS/S3/DynamoDB/SQS operations, a controlled S3 receipt failure-and-repair, bounded execution times, and explicit cleanup checks.</p></div>
<div class="callout"><h3>○ Still needs evidence</h3><p>First-time install on independent Windows, a real desktop MCP host user journey, public CI and security review, and a matching AWS Emulator MCP demonstration.</p></div>
<div class="callout"><h3>× Never implied</h3><p>A real AWS account, production IAM enforcement, complete AWS API parity, persistent cloud resources, or reliable distributed production behavior.</p></div>
</div><p class="instruction" style="margin-top:24px">Public release approval is independent of this local engineering scorecard.</p>
</section>
<footer class="footer"><div>B11-Health / GitHub source · AWS Emulator MCP / Tool</div><div>Independent community adapter · Not endorsed by AWS</div><div>Offline report; no external network requests</div></footer>
</div>
<script id="evidence" type="application/json">__EVIDENCE__</script>
<script>
(function () {
 "use strict";
 const data=JSON.parse(document.getElementById("evidence").textContent);
 const $=id=>document.getElementById(id);
 const safe=s=>String(s);
 const state=$("engine-state");const pass=data.engineering_pass;
 if(!pass)state.style.borderColor="#924d51";
 $("engine-text").textContent=pass?"LOCAL ENGINEERING: PASS":"LOCAL ENGINEERING: FAIL";
 $("report-meta").textContent="v"+data.version+"  ·  "+data.emulator_version+"  ·  "+(data.git_commit||"unversioned")+"  ·  "+data.repetitions+" repetitions";
 const wins=data.orders.filter(x=>x.passed).length+data.selftests.filter(x=>x.passed).length;
 const metrics=[
 ["MCP TOOLS",String(data.tool_count),"Schema-validated local operations"],
 ["LIVE SCENARIOS",wins+"/"+(data.orders.length+data.selftests.length),"Self-tests + order workflows"],
 ["ORDER P95",(data.p95===null?"N/A":Number(data.p95).toFixed(2)+" s"),"Warm local workflow"],
 ["RESOURCE LEAKS",String((data.gates.find(x=>x.name==="no_leaked_demo_resources")||{}).observed??"?"),"Run-created order resources remaining"],
 ];
 for(const row of metrics){
  const box=document.createElement("article");box.className="metric";
  const a=document.createElement("div");a.className="metric-label";a.textContent=row[0];
  const b=document.createElement("div");b.className="metric-value";b.textContent=row[1];
  const c=document.createElement("div");c.className="metric-sub";c.textContent=row[2];
  box.append(a,b,c);$("metrics").append(box);
 }
 $("chart-p95").textContent="p95 "+(data.p95===null?"n/a":data.p95+"s");
 const chart=$("latency-chart"),NS="http://www.w3.org/2000/svg";
 const add=(tag,attrs,parent=chart)=>{const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));parent.append(n);return n;};
 const durations=[...data.orders.map(x=>x.ms/1000),...data.selftests.map(x=>x.ms/1000)];
 const max=Math.max(12,...durations)*1.07;
 const y=sec=>245-(sec/max)*215;
 for(let sec=0;sec<=max;sec+=Math.max(2,Math.ceil(max/5))){
   add("line",{x1:55,x2:935,y1:y(sec),y2:y(sec)});
   const lbl=add("text",{x:47,y:y(sec)+4,"text-anchor":"end"});lbl.textContent=Math.round(sec)+"s";
 }
 const count=Math.max(data.orders.length,data.selftests.length);
 if(count){
 for(let i=0;i<count;i++){
   const cx=80+i*(815/Math.max(1,count-1));
   for(const [j,list] of [[0,data.orders],[1,data.selftests]]){
     if(!list[i])continue;
     const value=list[i].ms/1000;
     const bar=add("rect",{x:cx-19+j*19,y:y(value),width:16,height:245-y(value),rx:4,"class":j?"bar2":"bar1"});
     const tooltip=add("title",{},bar);tooltip.textContent=(j?"Service":"Order")+" #"+(i+1)+": "+value.toFixed(2)+"s";
   }
   const label=add("text",{x:cx,y:262,"text-anchor":"middle"});label.textContent="RUN "+(i+1);
 }
 } else {
  const label=add("text",{x:475,y:130,"text-anchor":"middle"});label.textContent="No scenario data";
 }
 for(const row of data.gates){
   const box=document.createElement("div");box.className="gate";
   const left=document.createElement("div"),title=document.createElement("strong"),sub=document.createElement("small");
   title.textContent=row.name.replace(/_/g," ");sub.textContent="Observed: "+row.observed+"   |   Target: "+row.threshold;
   const status=document.createElement("span");status.textContent=row.status;
   status.className=row.status==="PASS"?"pass mono":"fail mono";
   left.append(title,sub);box.append(left,status);$("gates").append(box);
 }
 function details(kind){
  $("tab-orders").setAttribute("aria-selected",kind==="orders");
  $("tab-services").setAttribute("aria-selected",kind==="services");
  const rows=kind==="orders"?data.orders:data.selftests;
  const panel=$("detail-panel");panel.replaceChildren();
  if(!rows.length){panel.textContent="No data";return;}
  rows.forEach((run,i)=>{
    const item=document.createElement("div");item.className="minirow";
    const left=document.createElement("div"),first=document.createElement("strong"),second=document.createElement("div");
    first.textContent="Run "+(i+1)+"  ·  "+(run.passed?"PASS":"FAIL");
    second.className="note";
    second.textContent=kind==="orders"?
       run.steps+" steps · "+run.recovery+" recovery checks · "+run.cleanup+" cleanups":
       run.checks+" service checks · "+run.cleanup+" cleanups";
    const duration=document.createElement("div");duration.className="mono";duration.textContent=(run.ms/1000).toFixed(3)+"s";
    left.append(first,second);item.append(left,duration);panel.append(item);
  });
 }
 $("tab-orders").addEventListener("click",()=>details("orders"));
 $("tab-services").addEventListener("click",()=>details("services"));
 details("orders");
})();
</script></body></html>
'''

def render(report:dict)->str:
    public=payload(report)
    serialized=json.dumps(public,separators=(",",":"),ensure_ascii=False)
    # Never let data escape the inert JSON <script> block.
    serialized=serialized.replace("<","\\u003c").replace(">","\\u003e").replace("&","\\u0026")
    return HTML.replace("__EVIDENCE__",serialized)

def main():
    parser=argparse.ArgumentParser(description="Render offline GTM evidence report")
    parser.add_argument("--input",default=str(ROOT/"reports"/"gtm_latest.json"))
    parser.add_argument("--output",default=str(ROOT/"reports"/"gtm_dashboard.html"))
    args=parser.parse_args()
    source=Path(args.input)
    report=json.loads(source.read_text(encoding="utf-8"))
    document=render(report)
    dest=Path(args.output)
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(document,encoding="utf-8")
    print("Offline dashboard:",dest.resolve())
    print("Engineering:", "PASS" if report.get("engineering_pass") else "FAIL")
    print("Public release approved: NO (requires independent gates)")
    return 0

if __name__=="__main__":
    raise SystemExit(main())
