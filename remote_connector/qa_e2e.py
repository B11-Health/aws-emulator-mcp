"""Synthetic client-certificate test for the loopback-only gateway.

Nginx verifies real chain; these generated certificates test application
certificate SAN, purposes, and authorization rejection defense-in-depth.
"""
from cryptography import x509
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime,timedelta,timezone
from urllib.parse import quote
from urllib.request import Request,urlopen
from urllib.error import HTTPError
import json,sys,os
from pathlib import Path
source=os.environ.get("CODEGYM_MCP_SOURCE","")
if not source:raise RuntimeError("Set CODEGYM_MCP_SOURCE")
sys.path.insert(0,source)
from aws_emulator_mcp import server as m
base=os.environ.get("CODEGYM_GATEWAY_LOCAL_URL","http://127.0.0.1:8987/mcp")
expected_port=int(os.environ.get("CODEGYM_EXPECTED_EMULATOR_PORT","9297"))
def make_cert(san):
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,"CodeGym-QA")])
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name)
          .public_key(key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1))
          .not_valid_after(datetime.now(timezone.utc)+timedelta(hours=1))
          .add_extension(x509.SubjectAlternativeName([x509.DNSName(san)]),critical=False)
          .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),critical=False)
          .sign(key,hashes.SHA256()))
    return quote(cert.public_bytes(serialization.Encoding.PEM).decode(),safe="")
headers={"Content-Type":"application/json","Accept":"application/json,text/event-stream",
         "X-CodeGym-Verified":"SUCCESS",
         "X-CodeGym-Client-Cert":make_cert("mtls.prod.connectors.openai.com"),
         "X-CodeGym-Edge-Token":Path(os.environ["CODEGYM_EDGE_SECRET_FILE"]).read_text(encoding="utf-8").strip()}
def request(msg,override=None):
    h={**headers,**(override or {})}
    try:
        with urlopen(Request(base,data=json.dumps(msg).encode(),headers=h,method="POST"),timeout=27) as r:
            return r.status,json.load(r)
    except HTTPError as e:
        return e.code,{"error":e.read().decode(errors="replace")[:100]}
def rpc(method,params=None):
    return {"jsonrpc":"2.0","id":1,"method":method,"params":params or {}}

out={}
out["no_edge_token"]=request(rpc("tools/list"),{"X-CodeGym-Edge-Token":""})[0]==403
out["no_verified_header"]=request(rpc("tools/list"),{"X-CodeGym-Verified":"NONE"})[0]==403
out["missing_cert"]=request(rpc("tools/list"),{"X-CodeGym-Client-Cert":""})[0]==403
out["wrong_san"]=request(rpc("tools/list"),{"X-CodeGym-Client-Cert":make_cert("attacker.invalid")})[0]==403
s,res=request(rpc("tools/list"))
names=[x["name"] for x in res.get("result",{}).get("tools",[])]
out["three_readonly_tools"]=s==200 and set(names)=={"emulator_status","emulator_doctor","emulator_identity"}
out["mutation_blocked"]=request(rpc("tools/call",{"name":"s3_create_bucket","arguments":{"bucket":"test"}}))[0]==403
out["bad_origin"]=request(rpc("tools/list"),{"Origin":"https://attacker.invalid"})[0]==403
out["modern_mismatch_blocked"]=request(rpc("tools/call",{"name":"emulator_doctor","_meta":{m.META_VERSION:"2026-07-28"},"arguments":{}}))[0]==400
modern=rpc("tools/call",{"name":"emulator_doctor","_meta":{m.META_VERSION:"2026-07-28",m.META_CAPS:{}},"arguments":{}})
status,res=request(modern,{"Mcp-Method":"tools/call","Mcp-Name":"emulator_doctor","MCP-Protocol-Version":"2026-07-28"})
value=json.loads(res.get("result",{}).get("content",[{"text":"{}"}])[0]["text"])
modern_result=res.get("result",{})
out["modern_chatgpt_compatible"]=status==200 and value.get("port")==expected_port and value.get("ready") is True and modern_result.get("resultType")=="complete"
legacy=rpc("tools/call",{"name":"emulator_identity","arguments":{}})
status,res=request(legacy)
who=json.loads(res.get("result",{}).get("content",[{"text":"{}"}])[0]["text"])
out["legacy_2025_compatible"]=status==200 and who.get("Account")=="000000000000"
for key,passed in out.items(): print(key,"PASS" if passed else "FAIL")
if not all(out.values()):
    print("modern_response_status",status,"modern_error",res.get("error"))
print(json.dumps({"passed":sum(out.values()),"total":len(out),
  "windows_endpoint":value.get("endpoint"),
   "modern_result_type":modern_result.get("resultType"),
  "read_only_tool_names":names},indent=2))
raise SystemExit(0 if all(out.values()) else 1)
