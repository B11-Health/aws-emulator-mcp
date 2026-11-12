#!/usr/bin/env python3
"""Live end-to-end MCP test against the official local AWS Emulator."""
import datetime
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
SERVER=ROOT/"src"/"aws_emulator_mcp"/"server.py"
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp import server as m

def legacy(i,method,params=None):
    return {"jsonrpc":"2.0","id":i,"method":method,"params":params or {}}

def modern(i,method,params=None):
    args=dict(params or {})
    args["_meta"]={m.META_VERSION:"2026-07-28",m.META_CAPS:{},
                   "io.modelcontextprotocol/clientInfo":{"name":"integration-test","version":"1.0"}}
    return {"jsonrpc":"2.0","id":i,"method":method,"params":args}

def rpc_tool(response):
    if "error" in response:raise AssertionError(response["error"])
    result=response["result"]
    if result.get("isError"):raise AssertionError(result["content"])
    return json.loads(result["content"][0]["text"])

def main():
    binary=m.emulator_binary()
    if not binary:raise RuntimeError("Official AWS Emulator binary not installed")
    version=subprocess.run([binary,"--version"],capture_output=True,text=True,timeout=8)
    if version.returncode:raise RuntimeError(version.stderr)
    if not m.health()["running"]:print("Starting local emulator",flush=True);m.start()
    if not m.health()["running"]:raise RuntimeError("Emulator failed health check")
    requests=[
        legacy(1,"initialize",{"protocolVersion":"2025-11-25"}),
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        legacy(2,"tools/list"),
        modern(3,"server/discover"),
        modern(4,"tools/list"),
        modern(5,"tools/call",{"name":"emulator_identity","arguments":{}}),
        modern(6,"tools/call",{"name":"emulator_self_test","arguments":{}}),
        modern(7,"tools/call",{"name":"sqs_list_queues","arguments":{}}),
        modern(8,"tools/call",{"name":"s3_list_buckets","arguments":{}}),
        modern(9,"tools/call",{"name":"emulator_order_demo","arguments":{}}),
    ]
    payload="".join(json.dumps(x,separators=(",",":"))+"\n" for x in requests)
    # Include a malformed final message to verify that parsing failures are JSON-RPC errors.
    payload+='this is not JSON\n'
    proc=subprocess.run([sys.executable,"-u",str(SERVER)],input=payload,
                        capture_output=True,text=True,timeout=70)
    if proc.returncode:
        raise RuntimeError("MCP subprocess failed: "+proc.stderr[-600:])
    results=[json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    by_id={r["id"]:r for r in results if r.get("id") is not None}
    assert len(by_id)==9,("expected responses",by_id.keys(),proc.stderr)
    assert len(results)==10,("unexpected JSON-RPC response count",len(results))
    assert results[-1]["error"]["code"]==-32700
    assert by_id[1]["result"]["protocolVersion"]=="2025-11-25"
    assert len(by_id[2]["result"]["tools"])==27
    assert "2026-07-28" in by_id[3]["result"]["supportedVersions"]
    assert by_id[3]["result"]["resultType"]=="complete"
    assert by_id[4]["result"]["resultType"]=="complete"
    assert len(by_id[4]["result"]["tools"])==27
    assert by_id[4]["result"]["cacheScope"]=="public"
    identity=rpc_tool(by_id[5])
    assert identity["Account"]=="000000000000"
    tested=rpc_tool(by_id[6])
    assert tested["passed"],tested
    assert len(tested["checks"])>=13 and all(x["passed"] for x in tested["checks"])
    assert len(tested["cleanup"])==4 and all(x["passed"] for x in tested["cleanup"])
    assert isinstance(rpc_tool(by_id[7])["queues"],list)
    assert isinstance(rpc_tool(by_id[8])["buckets"],list)
    order=rpc_tool(by_id[9])
    assert order["passed"],order
    assert len(order["recovery"])==2 and all(x["passed"] for x in order["recovery"])
    assert len(order["cleanup"])==4 and all(x["passed"] for x in order["cleanup"])
    assert len(order["steps"])>=12 and all(x["passed"] for x in order["steps"])
    out={"result":"PASS","revision":"0.3.0",
         "recorded_utc":datetime.datetime.now(datetime.timezone.utc).isoformat(),
         "emulator_version":(version.stdout+version.stderr).strip(),
         "endpoint":m.ENDPOINT,"account":identity["Account"],
         "tool_count":len(by_id[4]["result"]["tools"]),
         "rpc_responses":len(results),
         "protocol_versions_tested":["2025-11-25","2026-07-28"],
         "service_checks":len(tested["checks"]),"resource_cleanup":len(tested["cleanup"]),
         "selftest_ms":tested["elapsed_ms"],
         "order_demo_checks":len(order["steps"]),
         "order_demo_recovery":len(order["recovery"]),
         "order_demo_cleanup":len(order["cleanup"]),
         "order_demo_ms":order["duration_ms"],
         "selftest":tested,
         "order_demo":order}
    dest=ROOT/"reports"
    dest.mkdir(exist_ok=True)
    (dest/"latest_live.json").write_text(json.dumps(out,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in out.items() if k!="selftest"},indent=2),flush=True)
    return 0

if __name__=="__main__":
    try:sys.exit(main())
    except Exception as exc:
        print("LIVE_TEST_FAILED",repr(exc),file=sys.stderr,flush=True)
        sys.exit(1)
