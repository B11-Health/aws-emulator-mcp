"""Quantitative GTM benchmark for AWS Emulator MCP.

The benchmark intentionally cannot approve a release based only on a developer's
warm machine. It measures engineering performance and records independent gates.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp import server as m

def percentile(values,p):
    if not values:return None
    values=sorted(values)
    return round(values[max(0,math.ceil(p*len(values))-1)],3)

def command(args,timeout):
    started=time.perf_counter()
    try:
        r=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=timeout)
        return {"passed":r.returncode==0,
                "duration_s":round(time.perf_counter()-started,3),
                "exit_code":r.returncode,
                "stdout_tail":r.stdout[-350:],
                "stderr_tail":r.stderr[-600:]}
    except subprocess.TimeoutExpired:
        return {"passed":False,"duration_s":round(time.perf_counter()-started,3),
                "error":"timeout after %d seconds"%timeout}

def gate(name,passed,observed=None,threshold=None,required=True):
    return {"name":name,"status":"PASS" if passed else "FAIL",
            "required":required,"observed":observed,"threshold":threshold}

def benchmark(repetitions=3,include_unit=True):
    started=time.perf_counter()
    gates=[]
    details={}
    doctor=m.doctor()
    details["doctor"]=doctor
    gates.append(gate("health_identity",doctor["ready"],doctor["ready"],True))
    details["tool_count"]=len(m.TOOLS)
    gates.append(gate("tool_catalog",len(m.TOOLS)>=27,len(m.TOOLS),27))
    if include_unit:
        unit=command([sys.executable,"-m","unittest","discover","-s","tests","-q"],65)
        match=re.search(r"Ran (\d+) tests",unit.get("stderr_tail",""))
        unit["test_count"]=int(match.group(1)) if match else None
        details["unit"]=unit
        gates.append(gate("unit_and_security_tests",unit["passed"] and (unit["test_count"] or 0)>=90,
            unit["test_count"],"90+ passing"))
    probe_path=ROOT/"reports"/"gtm_protocol.json"
    probe_path.parent.mkdir(exist_ok=True)
    protocol=command([sys.executable,str(ROOT/"scripts"/"mcp_launch_check.py"),
        "--out",str(probe_path),"--min-tools","27","--",
        sys.executable,"-u",str(ROOT/"src"/"aws_emulator_mcp"/"server.py")],25)
    details["protocol"]=protocol
    gates.append(gate("protocol_interop",protocol["passed"],protocol["passed"],True))
    if doctor["ready"]:
        selftest=[]
        orders=[]
        for _ in range(repetitions):
            selftest.append(m.emulator_self_test())
            orders.append(m.emulator_order_demo())
        details["selftest"]=[{"passed":r["passed"],"ms":r["elapsed_ms"],
               "checks":len(r["checks"]),"cleanup":len(r["cleanup"])} for r in selftest]
        details["orders"]=[{"passed":r["passed"],"ms":r["duration_ms"],
               "steps":len(r["steps"]),"recovery":len(r["recovery"]),
               "cleanup":len(r["cleanup"]),"resources":r["resources"]} for r in orders]
        passed_service=all(r["passed"] for r in selftest+orders)
        gates.append(gate("scenario_reliability",passed_service and repetitions>=5,
            "%d/%d"%(sum(r["passed"] for r in selftest+orders),2*repetitions),
            "%d/%d"%(2*repetitions,2*repetitions)))
        p95_order=percentile([r["duration_ms"]/1000 for r in orders],.95)
        details["order_p95_seconds"]=p95_order
        gates.append(gate("order_workflow_p95",p95_order is not None and p95_order<=12 and repetitions>=5,
            p95_order,"<= 12s"))
        service_cleanup=all(len(r["cleanup"])==4 and all(x["passed"] for x in r["cleanup"])
                            for r in selftest+orders)
        gates.append(gate("resource_cleanup",service_cleanup,service_cleanup,True))
        listed=(set(m.s3_list_buckets()["buckets"]),
                set(m.dynamodb_list_tables().get("TableNames",[])),
                set(m.sqs_list_queues()["queues"]))
        leaked=[r["resources"] for r in orders
                if any(name in items for name,items in zip(
                   (r["resources"]["bucket"],r["resources"]["table"],r["resources"]["queue"]),listed))]
        details["leaked_order_resource_names"]=leaked
        gates.append(gate("no_leaked_demo_resources",not leaked,len(leaked),0))
    else:
        for key in ("scenario_reliability","order_workflow_p95","resource_cleanup","no_leaked_demo_resources"):
            gates.append(gate(key,False,"emulator unavailable","required"))
    required_gates=[g for g in gates if g["required"]]
    engineering_pass=all(g["status"]=="PASS" for g in required_gates)
    pending=[
        "Independent clean Windows/WSL first-install test on a new host",
        "Independent native Linux installation and E2E test on current AWS Emulator",
        "External MCP client interoperability and security review",
        "GitHub Actions passing on public B11-Health repository",
        "Public release link and final Code Gym launch video verified",
    ]
    report={
        "timestamp_utc":dt.datetime.now(dt.timezone.utc).isoformat(),
        "project":"AWS Emulator MCP","version":m.VERSION,
        "host_platform":sys.platform,"emulator_endpoint":m.ENDPOINT,
        "repetitions":repetitions,"duration_s":round(time.perf_counter()-started,3),
        "engineering_pass":engineering_pass,
        "public_release_approved":False,
        "gates":gates,"independent_release_blockers":pending,
        "measurements":details,
    }
    return report

def main():
    parser=argparse.ArgumentParser(description="Evidence-first release benchmark")
    parser.add_argument("--repetitions",type=int,default=3)
    parser.add_argument("--skip-unit",action="store_true")
    args=parser.parse_args()
    if not 1<=args.repetitions<=20:parser.error("repetitions must be 1-20")
    if sys.platform=="win32":
        # AWS Emulator is native Linux; use the installed WSL environment.
        try:
            located=subprocess.run(["wsl.exe","-e","wslpath","-a",str(ROOT)],
                                    capture_output=True,text=True,timeout=10)
            if located.returncode or not located.stdout.strip().startswith("/"):
                raise RuntimeError("Cannot locate project in WSL")
            script=located.stdout.strip()+"/scripts/gtm_benchmark.py"
            cmd=["wsl.exe","-e","python3",script,"--repetitions",str(args.repetitions)]
            if args.skip_unit:cmd.append("--skip-unit")
            completed=subprocess.run(cmd,timeout=180)
            return completed.returncode
        except (OSError,subprocess.TimeoutExpired,RuntimeError) as exc:
            print("WSL benchmark failed: "+str(exc),file=sys.stderr)
            return 2
    result=benchmark(args.repetitions,not args.skip_unit)
    out=ROOT/"reports"/"gtm_latest.json"
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,indent=2),encoding="utf-8")
    print(json.dumps({"engineering_pass":result["engineering_pass"],
        "public_release_approved":result["public_release_approved"],
        "gates":result["gates"],
        "duration_s":result["duration_s"],"report":str(out)},indent=2))
    return 0 if result["engineering_pass"] else 1

if __name__=="__main__":
    raise SystemExit(main())
