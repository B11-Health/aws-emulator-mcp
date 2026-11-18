"""Opt-in, trusted-local STS identity probe for an already-running AWS Emulator.

The only outbound request is a signed STS GetCallerIdentity sent to the
explicit loopback IPv4 address and selected port. This is never an MCP tool.
No user-provided service, operation, URL, source, or credentials are accepted.
Credentials come only from this run's official per-port emulator directory.
"""
from __future__ import annotations

from contextlib import contextmanager
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
from urllib.parse import urlsplit

MAX_INPUT = 4096
MAX_CA = 256 * 1024
MAX_CREDENTIALS = 8192
MAX_CONFIG = 16384
EMULATOR_ACCOUNT = "000000000000"
# Current *ephemeral emulator* key format, not an AWS credential. If the
# official format changes, fail closed rather than risk loading cloud keys.
EMULATOR_ACCESS = re.compile(r"EMULATOR[A-F0-9]{12}\Z")
EMULATOR_SECRET = re.compile(r"[A-F0-9]{40}\Z")
_EMULATOR_CREDENTIALS_READ = False
_SDK_INVOCATION_ATTEMPTED = False


class RejectedSession(ValueError):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def read_private_file(file: Path, limit: int) -> bytes:
    """Read one bounded regular file; reject symlinks and non-owner POSIX keys."""
    try:
        before = file.lstat()
        if (not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit or
                (os.name != "nt" and (before.st_mode & 0o077 or
                                        before.st_uid != os.geteuid()))):
            raise RejectedSession("session_file_untrusted")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(file, flags)
        try:
            current = os.fstat(fd)
            if not stat.S_ISREG(current.st_mode) or (before.st_dev, before.st_ino,
                    before.st_size) != (current.st_dev, current.st_ino, current.st_size):
                raise RejectedSession("session_file_changed")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(limit + 1)
            if not 0 < len(data) <= limit or len(data) != before.st_size:
                raise RejectedSession("session_file_changed")
            return data
        finally:
            os.close(fd)
    except RejectedSession:
        raise
    except (OSError, ValueError):
        raise RejectedSession("session_file_unavailable") from None


def checked_session(session_dir: Path, port: int, ca_sha256: str):
    """Read only the official per-run files, not real profiles or env credentials."""
    try:
        if (session_dir.name != str(port) or not session_dir.is_absolute() or
                any(part == ".." for part in session_dir.parts) or
                not session_dir.is_dir() or session_dir.is_symlink() or
                session_dir.parent.name != "emulator" or session_dir.parent.is_symlink() or
                session_dir.parent.parent.name != ".aws" or session_dir.parent.parent.is_symlink()):
            raise RejectedSession("session_directory_untrusted")
    except (OSError, ValueError):
        raise RejectedSession("session_directory_untrusted") from None
    ca_file = session_dir / "ca.pem"
    certificate = read_private_file(ca_file, MAX_CA)
    if hashlib.sha256(certificate).hexdigest() != ca_sha256:
        raise RejectedSession("session_certificate_changed")
    raw_config = read_private_file(session_dir / "config", MAX_CONFIG)
    try:
        config = configparser.RawConfigParser(interpolation=None)
        config.read_string(raw_config.decode("utf-8"))
        local = config["default"]
        if (local.get("endpoint_url") != f"https://127.0.0.1:{port}" or
                local.get("region") != "us-east-1"):
            raise RejectedSession("session_config_mismatch")
    except (UnicodeError, configparser.Error, KeyError):
        raise RejectedSession("session_config_mismatch") from None
    # The official config's CA path might be *inside its Docker container*.
    # Always override it with the verified host-side per-port CA path.
    global _EMULATOR_CREDENTIALS_READ
    raw_credentials = read_private_file(session_dir / "emulator_credentials", MAX_CREDENTIALS)
    _EMULATOR_CREDENTIALS_READ = True
    try:
        credentials = configparser.RawConfigParser(interpolation=None)
        credentials.read_string(raw_credentials.decode("utf-8"))
        defaults = credentials["default"]
        access = defaults["aws_access_key_id"]
        secret = defaults["aws_secret_access_key"]
        if not EMULATOR_ACCESS.fullmatch(access) or not EMULATOR_SECRET.fullmatch(secret):
            raise RejectedSession("emulator_credentials_unrecognized")
        # Reject inherited/stale credential provider options or extra profiles.
        if (set(credentials.sections()) != {"default"} or
                set(defaults) != {"aws_access_key_id", "aws_secret_access_key"}):
            raise RejectedSession("emulator_credentials_unrecognized")
    except (UnicodeError, configparser.Error, KeyError):
        raise RejectedSession("emulator_credentials_unrecognized") from None
    return ca_file, access, secret


@contextmanager
def loopback_guard(port: int):
    """Deny every socket target except this explicit loopback IPv4 endpoint."""
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def allowed(address):
        if (not isinstance(address, tuple) or len(address) != 2 or
                address[0] != "127.0.0.1" or address[1] != port):
            raise RejectedSession("network_target_blocked")

    def guarded_connect(sock, address):
        allowed(address)
        return original_connect(sock, address)

    def guarded_connect_ex(sock, address):
        allowed(address)
        return original_connect_ex(sock, address)

    def guarded_getaddrinfo(host, number, *args, **kwargs):
        allowed((host, number))
        return original_getaddrinfo(host, number, *args, **kwargs)

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    socket.getaddrinfo = guarded_getaddrinfo
    try:
        yield
    finally:
        socket.socket.connect = original_connect
        socket.socket.connect_ex = original_connect_ex
        socket.getaddrinfo = original_getaddrinfo


def check_identity(reply):
    """Never expose account/ARN returned by an unverified endpoint."""
    if (not isinstance(reply, dict) or reply.get("Account") != EMULATOR_ACCOUNT or
            reply.get("Arn") != "arn:aws:iam::000000000000:user/emulator"):
        raise RejectedSession("unexpected_account")


def probe_identity(port: int, session_dir: Path, ca_sha256: str, sdk_call=None):
    if type(port) is not int or not 1 <= port <= 65535:
        raise RejectedSession("invalid_port")
    if not re.fullmatch(r"[a-f0-9]{64}", ca_sha256):
        raise RejectedSession("invalid_certificate_digest")
    ca_file, access, secret = checked_session(session_dir, port, ca_sha256)
    if sdk_call is None:
        try:
            from botocore.config import Config
            from botocore.session import get_session
        except ImportError:
            raise RejectedSession("botocore_unavailable") from None

        def sdk_call():
            # Never invoke any credential provider chain: credentials and
            # endpoint are explicit. Empty config/credentials providers and
            # sanitized environment prevent real AWS fallback.
            session = get_session()
            client = session.create_client(
                "sts", endpoint_url=f"https://127.0.0.1:{port}",
                region_name="us-east-1", aws_access_key_id=access,
                aws_secret_access_key=secret, verify=str(ca_file),
                config=Config(connect_timeout=2, read_timeout=2,
                              retries={"total_max_attempts": 1},
                              inject_host_prefix=False))
            # Botocore cannot be permitted to turn a service redirect into
            # another endpoint. A socket-level guard protects against future
            # SDK endpoint redirects as well.
            original_send = client._endpoint.http_session.send

            def guarded_send(request):
                endpoint = urlsplit(request.url)
                if (endpoint.scheme != "https" or endpoint.hostname != "127.0.0.1" or
                        endpoint.port != port or endpoint.username or endpoint.password):
                    raise RejectedSession("network_target_blocked")
                return original_send(request)
            client._endpoint.http_session.send = guarded_send
            return client.get_caller_identity()

    global _SDK_INVOCATION_ATTEMPTED
    try:
        with loopback_guard(port):
            _SDK_INVOCATION_ATTEMPTED = True
            check_identity(sdk_call())
        # Detect a session replaced during the actual SDK operation.
        if hashlib.sha256(read_private_file(ca_file, MAX_CA)).hexdigest() != ca_sha256:
            raise RejectedSession("session_certificate_changed")
    except RejectedSession:
        raise
    except Exception:
        # No request/response values, endpoints, tracebacks or secret text.
        raise RejectedSession("sdk_request_failed") from None
    return {"schemaVersion": 1, "status": "verified", "accountVerified": True,
            "operation": "sts.GetCallerIdentity", "sdkCallAttempted": True}


def main():
    global _EMULATOR_CREDENTIALS_READ, _SDK_INVOCATION_ATTEMPTED
    _EMULATOR_CREDENTIALS_READ = False
    _SDK_INVOCATION_ATTEMPTED = False
    # This process must not inherit credentials, metadata URLs, proxy endpoints,
    # ~/.aws profiles, or provider commands from the launching shell.
    os.environ.clear()
    os.environ.update({"AWS_CONFIG_FILE": os.devnull,
                       "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                       "AWS_EC2_METADATA_DISABLED": "true", "AWS_DISABLE_HOST_PREFIX_INJECTION": "true"})
    try:
        if sys.version_info < (3, 10):
            raise RejectedSession("python_unsupported")
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise RejectedSession("invalid_input")
        req = json.loads(raw.decode("utf-8"))
        if (not isinstance(req, dict) or
                set(req) != {"schemaVersion", "port", "sessionDir", "caSha256"} or
                type(req["schemaVersion"]) is not int or req["schemaVersion"] != 1 or
                type(req["sessionDir"]) is not str or len(req["sessionDir"]) > 2048):
            raise RejectedSession("invalid_input")
        report = probe_identity(req["port"], Path(req["sessionDir"]), req["caSha256"])
        exit_code = 0
    except RejectedSession as error:
        report = {"schemaVersion": 1, "status": error.reason,
                  "accountVerified": False, "operation": "sts.GetCallerIdentity"}
        exit_code = 1
    except Exception:
        report = {"schemaVersion": 1, "status": "probe_unverified",
                  "accountVerified": False, "operation": "sts.GetCallerIdentity"}
        exit_code = 2
    report["credentialFilesRead"] = _EMULATOR_CREDENTIALS_READ
    report["sdkCallAttempted"] = _SDK_INVOCATION_ATTEMPTED
    print(json.dumps(report, separators=(",", ":")))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
