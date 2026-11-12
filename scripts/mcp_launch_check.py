#!/usr/bin/env python3
"""Dependency-free, read-only MCP stdio launch smoke checks (Python 3.10+).

Checks legacy and modern protocol basics. This is NOT full MCP certification,
an emulator integration test, or a sandbox for an untrusted server executable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
from datetime import datetime, timezone

VERSION = "0.1.0"
PROTOCOL = "2025-11-25"
MODERN = "2026-07-28"
MAX_FRAME = 1024 * 1024


class CheckError(Exception):
    """A bounded diagnostic that never includes server-supplied data."""


def require(condition, message):
    if not condition:
        raise CheckError(message)


def strict_json(raw):
    def invalid_constant(_):
        raise ValueError("Non-JSON numeric constant")
    return json.loads(raw, parse_constant=invalid_constant)


class StdioClient:
    def __init__(self, command, timeout=5.0, protocol=PROTOCOL):
        self.timeout = timeout
        self.protocol = protocol
        self.events = queue.Queue(maxsize=64)
        self.overflow = threading.Event()
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, shell=False,
        )
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _put(self, event):
        try:
            self.events.put_nowait(event)
        except queue.Full:
            self.overflow.set()

    def _read(self):
        try:
            while True:
                raw = self.process.stdout.readline(MAX_FRAME + 1)
                if not raw:
                    self._put(("error", "Server closed stdout"))
                    return
                if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                    self._put(("error", "Oversized or unterminated stdout frame"))
                    return
                try:
                    value = strict_json(raw.decode("utf-8"))
                except (ValueError, UnicodeError, RecursionError):
                    self._put(("error", "Stdout contains invalid JSON or non-protocol output"))
                    return
                self._put(("message", value))
        except (OSError, ValueError):
            self._put(("error", "Cannot read server stdout"))

    def send(self, message):
        self.send_raw(json.dumps(message, allow_nan=False).encode() + b"\n")

    def send_raw(self, raw):
        try:
            self.process.stdin.write(raw)
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise CheckError("Server input pipe closed") from None

    def response(self, expected_id):
        deadline = time.monotonic() + self.timeout
        notifications = 0
        while True:
            require(not self.overflow.is_set(), "Server flooded the bounded receive queue")
            try:
                kind, message = self.events.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                raise CheckError("Response deadline exceeded") from None
            if kind == "error":
                raise CheckError(message)
            require(isinstance(message, dict), "Response is not a JSON object")
            require(message.get("jsonrpc") == "2.0", "Invalid JSON-RPC version")
            if "method" in message and "id" not in message:
                require(isinstance(message["method"], str), "Invalid notification method")
                require("result" not in message and "error" not in message,
                        "Notification contains response fields")
                notifications += 1
                require(notifications <= 32, "Too many notifications before response")
                continue
            require("method" not in message, "Unexpected server request")
            omitted_error_id = (self.protocol == MODERN and expected_id is None
                                and "id" not in message and "error" in message)
            require(omitted_error_id or ("id" in message
                    and type(message["id"]) is type(expected_id)
                    and message["id"] == expected_id), "Response ID mismatch")
            require(("result" in message) != ("error" in message),
                    "Response must contain exactly one of result or error")
            if "error" in message:
                err = message["error"]
                require(isinstance(err, dict) and type(err.get("code")) is int
                        and isinstance(err.get("message"), str), "Malformed JSON-RPC error")
            elif self.protocol == MODERN:
                require(isinstance(message["result"], dict)
                        and message["result"].get("resultType") == "complete",
                        "Modern smoke-check response needs resultType complete")
            return message

    def request(self, request_id, method, params=None):
        msg = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if self.protocol == MODERN:
            params = dict(params or {})
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                    "name": "aws-emulator-launch-check", "version": VERSION},
            }
        if params is not None:
            msg["params"] = params
        self.send(msg)
        return self.response(request_id)

    def close(self):
        try:
            self.process.stdin.close()
        except (OSError, ValueError):
            pass
        forced = False
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            forced = True
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        self.reader.join(timeout=1)
        self.process.stdout.close()
        return {"exited_on_stdin_close": not forced, "exit_code": self.process.returncode}


def result_of(response):
    require("result" in response and isinstance(response["result"], dict),
            "Expected an object result")
    return response["result"]


def inspect_catalog(client, min_tools):
    all_tools = []
    names = set()
    cursors = set()
    cursor = None
    for page in range(100):
        result = result_of(client.request(f"catalog-{page}", "tools/list",
                                         {"cursor": cursor} if cursor else {}))
        tools = result.get("tools")
        require(isinstance(tools, list), "Catalog has no tools array")
        for tool in tools:
            require(isinstance(tool, dict), "Tool entry is not an object")
            name = tool.get("name")
            require(isinstance(name, str) and bool(name), "Tool has no valid name")
            require(name not in names, "Duplicate tool name across catalog pages")
            names.add(name)
            schema = tool.get("inputSchema")
            require(isinstance(schema, dict) and schema.get("type") == "object",
                    "Tool inputSchema must describe an object")
            require(isinstance(tool.get("description", ""), str), "Invalid tool description")
            all_tools.append(tool)
        cursor = result.get("nextCursor")
        if cursor is None:
            break
        require(isinstance(cursor, str) and bool(cursor), "Invalid pagination cursor")
        require(cursor not in cursors, "Catalog pagination repeated a cursor")
        cursors.add(cursor)
    else:
        raise CheckError("Catalog exceeded 100-page limit")
    require(len(all_tools) >= min_tools, "Catalog contains fewer tools than required")
    normalized = json.dumps(sorted(all_tools, key=lambda x: x["name"]),
                            sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return {
        "tool_count": len(all_tools), "catalog_utf8_bytes": len(normalized),
        "catalog_sha256": hashlib.sha256(normalized).hexdigest(),
        "tools_missing_description": sum(not t.get("description") for t in all_tools),
        "tools_missing_annotations": sum(not t.get("annotations") for t in all_tools),
        "schema_check": "top-level object shape only; not full JSON Schema validation",
    }


def run(command, timeout=5.0, min_tools=1, protocol=PROTOCOL):
    report = {
        "checker_version": VERSION,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": f"MCP {protocol} stdio smoke checks; no tool calls",
        "server_tested": True, "checks": [],
        "limitations": ["Not full protocol conformance or security certification",
                        "Does not test HTTP, cancellation, subscriptions, or all capability semantics",
                        "Does not test emulator service behavior or cleanup",
                        "Does not record server output, command arguments, or credentials"],
    }
    client = None

    def check(name, operation):
        start = time.perf_counter()
        try:
            details = operation()
        except CheckError as exc:
            report["checks"].append({"name": name, "status": "fail", "reason": str(exc)})
            raise
        report["checks"].append({"name": name, "status": "pass",
                                 "duration_ms": round((time.perf_counter() - start) * 1000, 2),
                                 "details": details})

    try:
        client = StdioClient(command, timeout, protocol)

        def initialize():
            r = result_of(client.request("init", "initialize", {
                "protocolVersion": PROTOCOL, "capabilities": {},
                "clientInfo": {"name": "aws-emulator-launch-check", "version": VERSION},
            }))
            require(r.get("protocolVersion") == PROTOCOL, "Requested legacy version not supported")
            require(isinstance(r.get("capabilities"), dict)
                    and isinstance(r["capabilities"].get("tools"), dict),
                    "Server did not advertise tools capability")
            info = r.get("serverInfo")
            require(isinstance(info, dict) and isinstance(info.get("name"), str)
                    and isinstance(info.get("version"), str), "Invalid server identity")
            client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            return {"protocol_version": PROTOCOL}

        def discover():
            r = result_of(client.request("discover", "server/discover"))
            require(isinstance(r.get("supportedVersions"), list)
                    and MODERN in r["supportedVersions"], "Modern version not advertised")
            require(isinstance(r.get("capabilities"), dict)
                    and isinstance(r["capabilities"].get("tools"), dict),
                    "Server did not advertise tools capability")
            return {"protocol_version": MODERN, "initialize_sent": False}

        check("modern_discovery" if protocol == MODERN else "legacy_initialization",
              discover if protocol == MODERN else initialize)
        check("tool_catalog", lambda: inspect_catalog(client, min_tools))

        def ping():
            response = client.request("ping", "ping")
            if protocol == MODERN:
                # MCP 2026-07-28 REMOVED ping (SEP-2575).
                require(response.get("error", {}).get("code") == -32601,
                        "Modern ping must return Method not found")
                return {"expected": "Method not found"}
            r = result_of(response)
            require(r == {}, "Legacy ping result must be empty")

        def expected_error(response, code):
            require(response.get("error", {}).get("code") == code, "Wrong JSON-RPC error code")

        check("ping", ping)
        check("unknown_method", lambda: expected_error(
            client.request("unknown", "launch_check/nonexistent"), -32601))

        def parse_error():
            client.send_raw(b'{"jsonrpc":\n')
            expected_error(client.response(None), -32700)

        check("malformed_json", parse_error)

        def invalid_envelope():
            client.send_raw(b'42\n')
            expected_error(client.response(None), -32600)

        check("invalid_request_envelope", invalid_envelope)

        def notification():
            client.send({"jsonrpc": "2.0", "method": "notifications/launch_check_unknown"})
            ping()

        check("unknown_notification_no_response", notification)
        check("recovers_after_invalid_input", ping)
        if protocol == MODERN:
            def unknown_version():
                client.send({"jsonrpc": "2.0", "id": "bad-version", "method": "server/discover",
                             "params": {"_meta": {
                                 "io.modelcontextprotocol/protocolVersion": "1900-01-01",
                                 "io.modelcontextprotocol/clientCapabilities": {}}}})
                response = client.response("bad-version")
                expected_error(response, -32022)
                data = response["error"].get("data")
                require(isinstance(data, dict) and isinstance(data.get("supported"), list)
                        and MODERN in data["supported"]
                        and data.get("requested") == "1900-01-01",
                        "Unsupported-version error lacks negotiation details")

            def missing_capabilities():
                client.send({"jsonrpc": "2.0", "id": "missing-meta", "method": "server/discover",
                             "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": MODERN}}})
                expected_error(client.response("missing-meta"), -32602)

            check("unsupported_version", unknown_version)
            check("missing_required_capabilities", missing_capabilities)
    except CheckError:
        pass
    except (OSError, ValueError):
        report["checks"].append({"name": "process_start_or_io", "status": "fail",
                                 "reason": "Could not execute server command or perform I/O"})
    except Exception as exc:
        report["checks"].append({"name": "checker_internal", "status": "fail",
                                 "reason": type(exc).__name__})
    finally:
        if client is not None:
            report["shutdown"] = client.close()
    report["passed"] = len(report["checks"]) == (10 if protocol == MODERN else 8) and all(
        c["status"] == "pass" for c in report["checks"])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--min-tools", type=int, default=1)
    parser.add_argument("--protocol", choices=[PROTOCOL, MODERN, "both"], default="both")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not 0 < args.timeout <= 120 or args.min_tools < 1:
        parser.error("Provide a server command, timeout in (0, 120], and positive min-tools")
    if args.protocol == "both":
        runs = [run(command, args.timeout, args.min_tools, protocol=p) for p in (PROTOCOL, MODERN)]
        report = {"scope": "Two fresh stdio processes; legacy and modern smoke checks",
                  "passed": all(r["passed"] for r in runs), "runs": runs}
    else:
        report = run(command, args.timeout, args.min_tools, args.protocol)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temp = args.out.with_name(args.out.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, args.out)
    print("PASS" if report["passed"] else "FAIL")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
