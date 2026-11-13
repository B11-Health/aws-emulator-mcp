"""Fail-closed loopback boundaries for optional private gateway QA.

The QA tool sends a private edge authentication token. Never allow a request,
proxy or redirect to carry that token outside the exact local MCP endpoint.
"""
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


def validate_loopback_url(value):
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError("Gateway QA URL must be an exact local HTTP address")
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("Invalid gateway QA port") from exc
    if (parts.scheme != "http" or parts.hostname != "127.0.0.1"
            or parts.path != "/mcp" or parts.query or parts.fragment
            or parts.username or parts.password or not (port and 1024 <= port <= 65535)
            or parts.netloc != f"127.0.0.1:{port}"):
        raise ValueError("Refusing non-loopback gateway QA URL")
    return value


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def loopback_opener():
    return build_opener(ProxyHandler({}), RejectRedirects())
