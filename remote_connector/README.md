# ChatGPT Secure Remote Connector

Optional, private diagnostic bridge for the official AWS Emulator MCP.
The core adapter still uses only the Python standard library and local stdio.

## Verified architecture

    ChatGPT Personal MCP plugin
       | HTTPS with OpenAI-managed mTLS client certificate
       v
    nginx dedicated HTTPS hostname + random capability path
       | strict client CA verification, independent edge secret
       v
    gateway.py on 127.0.0.1 only
       | emulator_status, emulator_doctor, emulator_identity ONLY
       | relay.py forwards approved calls using one authenticated agent
       v
    Dedicated WSS hostname, random 384-bit bearer secret
       | outbound connection initiated by Windows/WSL
       v
    windows_agent.py (systemd --user)
       | second read-only tool whitelist
       v
    AWS Emulator at https://127.0.0.1:9297

Live ChatGPT plugin tests verified Windows emulator version 1.0.322,
6/6 diagnostics passed and account 000000000000. Application security,
legacy/modern MCP and simulated mTLS tests passed 10/10 gates.

## Repository components

- gateway.py and relay.py: isolated HTTP gateway and WSS broker.
- windows_agent.py: reconnecting outbound WSL agent, no shell execution.
- qa_e2e.py: synthetic local certificate and real Windows-call test.
- requirements-gateway.txt / requirements-agent.txt: OPTIONAL packages.
- nginx.example.conf, gateway.service.example, windows-relay.service.example,
  relay.env.example: placeholder-only templates, never real credentials.

## Deployment checklist

1. Obtain valid TLS certificates for distinct MCP and relay hostnames, with
   automatic renewal. Verify OpenAI's published root and connectors client
   CA chain, then configure nginx ssl_verify_client on.
2. Generate TWO distinct strong random secrets: a private nginx-to-backend
   edge token and a private WSS agent bearer token. Both go in mode-0600
   files under a 0700 private directory. Never commit them.
3. Replace all placeholders in nginx.example.conf, including an independent
   unguessable capability path. Restrict final config file permissions.
   Never expose gateway.py or the Windows emulator directly to the internet.
4. Install gateway requirements into a dedicated venv. Configure gateway
   environment variables and start the service as a dedicated unprivileged
   account bound only to 127.0.0.1.
5. Install agent requirements in Windows Ubuntu WSL2. Configure its service
   using the example environment file (paths and URLs only), with bearer
   secret in a separate 0600 file. Enable systemctl --user service.
6. Confirm internal localhost /health shows Windows agent connected.
   Confirm public HTTPS without valid OpenAI client certificate is rejected.
7. In ChatGPT Plugins, create a Personal custom MCP server using Server URL
   and your private HTTPS MCP capability path. Choose No authentication in
   the UI BECAUSE nginx enforces OpenAI mTLS; do not disable mTLS.
8. Test ChatGPT's real plugin mention calling emulator_doctor and
   emulator_identity, confirming Windows version, port, six checks and account.

## Required gateway environment

CODEGYM_MCP_SOURCE = absolute path to repo/src
CODEGYM_GATEWAY_PORT = 8987 (local only)
CODEGYM_EDGE_SECRET_FILE = private edge secret file
CODEGYM_RELAY_SECRET_FILE = private relay secret file
CODEGYM_RELAY_ORIGIN = https://relay-hostname
CODEGYM_ROUTE_WINDOWS = 1
AWS_EMULATOR_PORT = optional isolated Linux test port

## Required Windows agent environment

CODEGYM_MCP_WINDOWS_SOURCE = WSL path to checkout
CODEGYM_RELAY_URL = wss://relay-hostname/agent
CODEGYM_RELAY_SECRET_FILE = private 0600 credential file
AWS_EMULATOR_PORT = 9297

## Validation and limitations

Optional QA on the gateway host, after setting env variables:

    python3 remote_connector/qa_e2e.py

It is a synthetic application-layer certificate test; nginx independently
validates real client TLS. Also verify by actual ChatGPT tool calls after
each gateway/agent change.

No OpenAI API key or inbound Windows port is required for this private route.
The mTLS certificate authenticates the OpenAI transport, NOT an individual
ChatGPT user. Before exposing remote write tools or multiple users, add
per-user OAuth 2.1, authorization checks and independent security review.
No real AWS credentials or IAM security assurance are provided. If Windows
is unavailable, the bridge must fail closed rather than switching emulators.

This is a private, non-production prototype. A passing test does not approve
a public GitHub release.
