"""Synthetic MCP peer used only to test the launch checker. Not an AWS adapter."""
import json
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "good"
secret = "FIXTURE_SECRET_MUST_NOT_APPEAR_IN_REPORT"
tool = {"name": "fixture_read", "description": "Synthetic read-only fixture",
        "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}}

for line in sys.stdin:
    if mode == "hang":
        time.sleep(60)
    if mode == "crash":
        sys.exit(7)
    if mode == "noisy":
        print(secret, flush=True)
        continue
    if mode == "oversized":
        print("x" * (1024 * 1024 + 1), flush=True)
        continue
    if mode == "stderr_flood":
        sys.stderr.write("x" * (128 * 1024))
        sys.stderr.flush()
    try:
        req = json.loads(line)
    except ValueError:
        req = None
        response = {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32700 if mode != "bad_parse" else -32603,
                              "message": secret}}
    else:
        if not isinstance(req, dict):
            response = {"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32600, "message": secret}}
        elif "id" not in req:
            if mode == "notification_reply" and req.get("method", "").endswith("unknown"):
                response = {"jsonrpc": "2.0", "id": None, "result": {}}
            else:
                continue
        else:
            method = req.get("method")
            meta = req.get("params", {}).get("_meta", {})
            modern = "io.modelcontextprotocol/protocolVersion" in meta
            response = {"jsonrpc": "2.0", "id": req["id"], "result": {}}
            if modern and meta["io.modelcontextprotocol/protocolVersion"] != "2026-07-28":
                response.pop("result")
                response["error"] = {"code": -32022, "message": secret,
                                     "data": {"supported": ["2026-07-28"], "requested": "1900-01-01"}}
                if mode == "modern_bad_version":
                    response["error"]["code"] = -32601
                if mode == "modern_bad_details":
                    response["error"].pop("data")
            elif modern and "io.modelcontextprotocol/clientCapabilities" not in meta:
                if mode != "modern_missing_meta":
                    response.pop("result")
                    response["error"] = {"code": -32602, "message": secret}
            elif method == "server/discover":
                response["result"] = {"supportedVersions": ["2026-07-28"], "capabilities": {"tools": {}}}
                if mode == "modern_bad_advertisement":
                    response["result"]["supportedVersions"] = []
            elif method == "initialize":
                response["result"] = {
                    "protocolVersion": "future" if mode == "version" else "2025-11-25",
                    "capabilities": {} if mode == "capability" else {"tools": {}},
                    "serverInfo": {"name": "SYNTHETIC FIXTURE", "version": "0"},
                }
            elif method == "tools/list":
                tools = [tool.copy()]
                if mode == "missing_schema":
                    tools[0].pop("inputSchema")
                if mode == "duplicate":
                    tools.append(tool)
                if mode == "empty":
                    tools = []
                result = {"tools": tools}
                cursor = req.get("params", {}).get("cursor")
                if mode in ("paginated", "cursor_loop", "page_duplicate"):
                    if not cursor:
                        result["nextCursor"] = "page2"
                    elif mode == "cursor_loop":
                        result = {"tools": [], "nextCursor": "page2"}
                    elif mode == "paginated":
                        result = {"tools": [dict(tool, name="fixture_two")]}
                response["result"] = result
            elif method != "ping" or modern:
                response.pop("result")
                response["error"] = {"code": -32601, "message": secret}
                if mode == "bad_error":
                    response["error"]["code"] = True
            if modern and "result" in response and mode != "modern_no_result_type":
                response["result"]["resultType"] = "complete"
    if mode == "id":
        response["id"] = "wrong"
    if mode == "both":
        response["error"] = {"code": -32603, "message": secret}
    if mode == "bad_rpc":
        response["jsonrpc"] = "1.0"
    if mode == "nan":
        response["extra"] = float("nan")
    if mode == "notification_before":
        print(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}), flush=True)
    if mode == "server_request":
        response = {"jsonrpc": "2.0", "id": "server", "method": "sampling/createMessage"}
    print(json.dumps(response), flush=True)
