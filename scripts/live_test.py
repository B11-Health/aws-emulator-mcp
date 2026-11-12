#!/usr/bin/env python3
"""Real MCP protocol round trip against AWS's official emulator."""
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
SERVER=ROOT/"src"/"aws_emulator_mcp"/"server.py"
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp import server as m

def msg(i,name=None,args=None,method="tools/call"):
    if method=="tools/call":
        return {"jsonrpc":"2.0","id":i,"method":method,
                "params":{"name":name,"arguments":args or {}}}
    return {"jsonrpc":"2.0","id":i,"method":method,
            "params":{"protocolVersion":"2025-06-18"} if method=="initialize" else {}}

def verify(data,id_,name):
    out=data[id_]
    if "error" in out: raise AssertionError(f"{name}: {out['error']}")
    if name=="initialize":
        assert out["result"]["serverInfo"]["name"]=="aws-emulator-mcp"
        return out["result"]
    if name=="tools/list":
        return out["result"]
    result=out["result"]
    if result.get("isError"): raise AssertionError(f"{name}: {result['content']}")
    return json.loads(result["content"][0]["text"])

def main():
    print("AWS Official Emulator version check",flush=True)
    installed=m.emulator_binary()
    if not installed: raise RuntimeError("Signed official AWS emulator has not been installed")
    version=subprocess.run([installed,"--version"],capture_output=True,text=True,timeout=6)
    print("binary:",(version.stdout+version.stderr).strip(),flush=True)
    if not m.health()["running"]:
        started=m.start()
        print("startup:",started,flush=True)
    else:
        print("reusing healthy emulator",flush=True)

    stamp=str(int(time.time()))
    bucket="mcp-e2e-"+stamp
    table="mcp_e2e_"+stamp
    item_id="item-1"
    text="AWS Emulator via MCP: verified locally"
    msgs=[
        msg(1,method="initialize"),
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        msg(2,method="tools/list"),
        msg(3,"emulator_status"),
        msg(4,"emulator_health"),
        msg(5,"emulator_identity"),
        msg(6,"s3_create_bucket",{"bucket":bucket}),
        msg(7,"s3_put_object",{"bucket":bucket,"key":"sample.txt","text":text}),
        msg(8,"s3_get_object",{"bucket":bucket,"key":"sample.txt"}),
        msg(9,"s3_list_buckets"),
        msg(10,"dynamodb_create_table",{"table":table}),
        msg(11,"dynamodb_put_item",{"table":table,"item_id":item_id,"message":"hello-local"}),
        msg(12,"dynamodb_get_item",{"table":table,"item_id":item_id}),
        msg(13,"dynamodb_delete_table",{"table":table}),
        msg(14,"s3_delete_object",{"bucket":bucket,"key":"sample.txt"}),
    ]
    proc=subprocess.Popen([sys.executable,"-u",str(SERVER)],
          stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    payload="".join(json.dumps(x)+"\n" for x in msgs)
    stdout,stderr=proc.communicate(payload,timeout=45)
    if proc.returncode:
        raise RuntimeError(f"stdio server exited {proc.returncode}: {stderr}")
    data={r["id"]:r for line in stdout.splitlines() if (r:=json.loads(line)).get("id") is not None}
    labels={1:"initialize",2:"tools/list",3:"status",4:"health",5:"identity",
            6:"s3 create",7:"s3 put",8:"s3 get",9:"s3 list",
            10:"dynamodb create",11:"dynamodb put",12:"dynamodb get",
            13:"dynamodb delete",14:"s3 delete"}
    values={i:verify(data,i,name) for i,name in labels.items()}
    assert values[4]["running"], values[4]
    assert values[5]["Account"]=="000000000000",values[5]
    assert values[8]["text"]==text,values[8]
    assert bucket in values[9]["buckets"],values[9]
    assert values[12]["Item"]["id"]["S"]==item_id,values[12]
    assert values[12]["Item"]["message"]["S"]=="hello-local"
    print(json.dumps({"result":"PASS","tests":len(labels),
         "tools":len(values[2]["tools"]),"bucket":bucket,"table":table,
         "account":values[5]["Account"],"endpoint":m.ENDPOINT,
         "sample":values[8]["text"]},indent=2),flush=True)
    return 0

if __name__=="__main__":
    try: sys.exit(main())
    except Exception as e:
        print("LIVE_TEST_FAILED",repr(e),file=sys.stderr,flush=True)
        sys.exit(1)
