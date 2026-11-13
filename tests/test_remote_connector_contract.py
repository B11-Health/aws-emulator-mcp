"""Security contract for the OPTIONAL private ChatGPT remote gateway.

These tests use Python stdlib only, so they run on Windows and WSL even
when optional gateway/agent dependencies are not installed.
"""
import ast
import pathlib
import re
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
REMOTE=ROOT/"remote_connector"
SAFE={"emulator_status","emulator_doctor","emulator_identity"}

def source(name):
    return (REMOTE/name).read_text(encoding="utf-8")

def allowlist(name,variable):
    tree=ast.parse(source(name))
    for node in tree.body:
        if isinstance(node,ast.Assign) and len(node.targets)==1:
            target=node.targets[0]
            if isinstance(target,ast.Name) and target.id==variable:
                value=node.value
                if isinstance(value,ast.Call) and isinstance(value.func,ast.Name):
                    if value.func.id=="frozenset" and len(value.args)==1:
                        return ast.literal_eval(value.args[0])
    return None

class RemoteConnectorContractTests(unittest.TestCase):
    def test_explicit_readonly_whitelists_match(self):
        self.assertEqual(allowlist("gateway.py","ALLOWED_TOOLS"),SAFE)
        self.assertEqual(allowlist("windows_agent.py","ALLOWED"),SAFE)

    def test_remote_tool_calls_require_windows_agent_routing(self):
        s=source("gateway.py")
        self.assertIn('if os.environ.get("CODEGYM_ROUTE_WINDOWS")!="1":',s)
        self.assertIn("Windows diagnostic relay not configured",s)
        self.assertIn("reply=await relay.call_windows(msg)",s)

    def test_backend_requires_real_proxy_identity_and_client_purpose(self):
        s=source("gateway.py")
        for required in (
            "X-CodeGym-Edge-Token","X-CodeGym-Verified",
            "X-CodeGym-Client-Cert","compare_digest",
            "ExtendedKeyUsageOID.CLIENT_AUTH",
            "mtls.prod.connectors.openai.com",
            'host="127.0.0.1"', "CODEGYM_MCP_SOURCE",
        ):
            self.assertIn(required,s)

    def test_outbound_agent_is_not_general_shell(self):
        s=source("windows_agent.py")
        self.assertIn("wss://",s)
        self.assertIn("ALLOWED",s)
        self.assertIn("CODEGYM_RELAY_URL",s)
        tree=ast.parse(s)
        imports=[x for node in ast.walk(tree)
                 if isinstance(node,(ast.Import,ast.ImportFrom))
                 for x in ([y.name for y in node.names] if isinstance(node,ast.Import)
                           else [node.module or ""])]
        for forbidden in ("subprocess","pexpect","paramiko","pysftp"):
            self.assertNotIn(forbidden,imports)
        self.assertNotIn("shell=True",s)
        self.assertNotIn("os.system(",s)

    def test_nginx_template_fails_closed(self):
        s=source("nginx.example.conf")
        for required in (
            "ssl_verify_client on;","X-CodeGym-Edge-Token",
            "$ssl_client_verify","$ssl_client_escaped_cert",
            "limit_except POST","proxy_pass http://127.0.0.1:",
            "__PRIVATE_CAPABILITY_PATH__",
        ):
            self.assertIn(required,s)

    def test_optional_dependencies_not_in_main_runtime(self):
        r=(REMOTE/"requirements-gateway.txt").read_text()
        a=(REMOTE/"requirements-agent.txt").read_text()
        self.assertIn("aiohttp==",r)
        self.assertIn("cryptography==",r)
        self.assertIn("websockets==",a)
        p=(ROOT/"pyproject.toml").read_text()
        self.assertNotIn('aiohttp>=',p)
        self.assertNotIn('websockets>=',p)

    def test_no_credential_values_in_remote_sources(self):
        for p in REMOTE.iterdir():
            if not p.is_file() or p.suffix in (".pyc",".bin"):
                continue
            s=p.read_text(encoding="utf-8")
            self.assertNotRegex(s,r"(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}")
            self.assertNotRegex(s,r"ghp_[A-Za-z0-9]{36,}")
            self.assertNotRegex(s,r"sk-[A-Za-z0-9]{32,}")
        self.assertFalse((REMOTE/"relay.secret").exists())
        self.assertFalse((REMOTE/"edge.secret").exists())

    def test_python_code_compiles_without_third_party_import(self):
        for filename in ("gateway.py","relay.py","windows_agent.py","qa_e2e.py"):
            compile(source(filename),str(REMOTE/filename),"exec")

if __name__=="__main__":
    unittest.main()
