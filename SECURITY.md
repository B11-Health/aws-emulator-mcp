# Security Policy

AWS Emulator MCP is a **local testing tool**, not a production security boundary.

## Trust boundary

The bridge always signs requests with emulator-issued credentials for an HTTPS
loopback endpoint. It refuses real AWS credentials, rejects outbound redirects,
disables proxies for emulator requests, and verifies the emulator CA.

The optional Streamable HTTP server listens only on 127.0.0.1, is disabled by
default, and requires a long bearer token. Its Host and Origin checks defend
against unauthorized browsers and accidental reverse-proxy exposure. Do not
tunnel it directly to the public internet.

A model or connected agent invoking this MCP server has access to create and
delete emulated resources. Review tool calls and run the emulator against
synthetic, non-sensitive data. Do not run the server elevated.

## What this does not prove

AWS Emulator does not enforce IAM or resource-based policies as AWS does. Its
service fidelity and persistence are incomplete. Passing the local integration
tests is **not** evidence of production cloud security or correctness.

## Sensitive data

Never commit the bearer token, emulator-generated credentials, CA private
keys, logs containing payloads, or SDK credentials to GitHub. The default
HTTP helper stores its token under the user's private config directory,
not inside the source repository. Source archives deliberately exclude it.

## Reporting

**Private vulnerability reporting is enabled for this public repository.**
Use the [Security Advisories page](https://github.com/B11-Health/aws-emulator-mcp/security/advisories)
and select **Report a vulnerability** to submit details privately through
GitHub's built-in reporting system. The maintainer can review the report
without first publishing an exploit or asking you to email credentials.

Provide a minimal synthetic proof, affected version, impact and suggested
mitigation. Never post live credentials, customer data or undisclosed
vulnerability details in a public issue or pull request. We do not promise a
fixed response time or a paid bug bounty.

For ordinary installation or API behavior questions, use [SUPPORT.md](SUPPORT.md)
and the public, sanitized issue forms instead. Interpersonal conduct
concerns belong under [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), **not** in a
security advisory.
