"""Developer commands for checking the local AWS Emulator MCP installation.

Read-only by default; no external service calls or credentials are printed.
"""
from __future__ import annotations
import argparse
import json
import sys
from aws_emulator_mcp import server

def main(argv=None):
    parser=argparse.ArgumentParser(prog="aws-emulator-mcp-cli",
        description="Local-only AWS Emulator MCP diagnostics and demos.")
    commands=parser.add_subparsers(dest="command",required=True)
    d=commands.add_parser("doctor",help="Check install, certificates, credentials, HTTPS, STS")
    d.add_argument("--json",action="store_true",help="Machine-readable output")
    c=commands.add_parser("catalog",help="List available MCP tools")
    c.add_argument("--json",action="store_true")
    s=commands.add_parser("self-test",help="Run isolated S3, DynamoDB, and SQS checks and cleanup")
    s.add_argument("--json",action="store_true")
    order=commands.add_parser("order-demo",help="Run a full synthetic order workflow with error repair and cleanup")
    order.add_argument("--json",action="store_true")
    args=parser.parse_args(argv)
    if args.command=="doctor":
        result=server.doctor()
        if args.json:print(json.dumps(result,indent=2))
        else:
            print("AWS Emulator MCP doctor")
            print("Endpoint:",result["endpoint"])
            print("Emulator:",result["emulator_version"])
            for item in result["checks"]:
                print(("PASS" if item["passed"] else "FAIL")+": "+item["check"])
                if item["fix"]:print("  Fix:",item["fix"])
            print("READY" if result["ready"] else "NOT READY")
        return 0 if result["ready"] else 1
    if args.command=="order-demo":
        result=server.emulator_order_demo()
        if args.json:print(json.dumps(result,indent=2))
        else:
            print("Local order workflow:", "PASS" if result["passed"] else "FAIL")
            print("Order:",result["order_id"])
            print("Workflow steps:",len(result["steps"]))
            print("Expected failure/recovery checks:",len(result["recovery"]))
            print("Resource cleanups:",len(result["cleanup"]))
            if result["error"]:print("Failure:",result["error"])
        return 0 if result["passed"] else 1
    if args.command=="catalog":
        if args.json:print(json.dumps(server.TOOLS,indent=2))
        else:
            print("%d available MCP tools:" % len(server.TOOLS))
            for item in server.TOOLS: print(" -",item["name"])
        return 0
    if args.command=="self-test":
        result=server.emulator_self_test()
        if args.json:print(json.dumps(result,indent=2))
        else:
            print("Local AWS Emulator self-test:", "PASS" if result["passed"] else "FAIL")
            print("Service checks:",len(result["checks"]))
            print("Cleanup steps:",len(result["cleanup"]))
            if result["error"]: print("Failure:",result["error"])
        return 0 if result["passed"] else 1
    return 2

if __name__=="__main__":
    sys.exit(main())
