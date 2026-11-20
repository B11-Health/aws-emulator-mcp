# Testcontainers + AWS Emulator: safe first-run TLS decision guide

**Audience:** a developer testing their **own, trusted** app with a locally
managed AWS Emulator. This is a boundary checklist and **offline synthetic
certificate test**, **not an emulator integration test**, Docker/Compose recipe,
production AWS comparison, or proof that a third-party Testcontainers setup
works. No new runner or network access is enabled by this documentation.

Two reports motivate the distinction: [upstream issue #23](https://github.com/aws/aws-emulator/issues/23)
describes a certificate with SANs for `localhost`, `127.0.0.1`, and `::1`
but **not** a Docker service name; [issue #566](https://github.com/aws/aws-emulator/issues/566)
describes the per-start emulator-issued credential lifecycle in a Compose
stack. Those issues are **upstream reports**, not fixes made by this MCP
adapter. Verify current upstream release behavior before relying on this
layout. The upstream [SDK instructions](https://docs.aws.amazon.com/emulator/latest/userguide/point-sdk-to-emulator.html)
and [Docker instructions](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html)
are authoritative for actual setup details.

## Choose where the **test code** runs

| Layout | Endpoint visible to the SDK | Why it works / fails | Safe next action |
| --- | --- | --- | --- |
| **host-run Testcontainers**: test process runs on your laptop/CI host and starts the emulator container | `https://127.0.0.1:9297`, using an **explicit localhost-only published port** | Host loopback addresses the published container port; the reported certificate has an IP SAN for `127.0.0.1`. The host must trust the **current run**'s `ca.pem` and use its emulator-issued credentials for SigV4. | Preferred opt-in path. Follow the official Docker and SDK setup, then exercise the trusted app and assert independent local emulator state. |
| **separate test container**: application/test runner and emulator are different containers on a private Compose/Testcontainers network | `https://aws:9297` (or another service DNS name) | Network DNS may resolve the service, and a shared CA can establish certificate **trust**, but the reported TLS SAN does **not** cover `aws`. Hostname verification still fails. | **Stop, do not downgrade TLS**. Do not represent this layout as supported until its identity and per-run credential provisioning are resolved and independently verified. |
| Test code inside a sibling container, pointed to `https://127.0.0.1:9297` | Loopback **inside the test container** | `127.0.0.1` addresses the test container's own network namespace, **not** its sibling emulator. Certificate SAN alone cannot make the server reachable. | Move the test runner to the host, or redesign the test topology after review. |

**Important:** this repo's normal MCP Docker labs use `--network none`,
**no ports**, and no host mounts. They are **not** an AWS Emulator endpoint
published for host-run Testcontainers, and `aws-emulator-mcp mcp` does not
create or share a Compose service. To exercise a trusted application via an
SDK on the host, use a **separately approved upstream Docker configuration**
with an explicit host loopback binding. Never silently change the MCP runtime
isolation to make a demo appear to work.

## Five-minute dry run: prove CA trust is not hostname verification

Prerequisites: a checked-out copy of this repository, Python 3.10+ and
OpenSSL 1.1.1+ available locally. This timebox begins **after** installing
those tools and obtaining the checkout. No emulator, Docker, ports, network,
AWS account or credentials are used.

From the repository root:

```sh
openssl version
python3 -m unittest tests.test_testcontainers_tls_first_run -v
```

The test creates **synthetic one-day self-signed certificates in a private
temporary directory**; keys and certificates disappear at test cleanup. It
invokes local `openssl req` and `openssl verify` with the same small SAN set
reported in issue #23; it does not read the emulator's real CA or key.
Expect these results, not an emulator success claim:

- **Trusted CA + `localhost` / `127.0.0.1` / `::1` SAN:** X.509 identity
  verification passes for the matching name/address.
- **The exact same trusted CA + `aws` service DNS name:** X.509 verification
  fails with **hostname mismatch**. Reusing a CA cannot add missing SANs.
- **A new synthetic certificate + previous run's CA:** trust verification
  fails even for `localhost`; the new certificate trusts itself instead.

The failure is intentional, not a failing test suite. This demonstrates the
two *independent* checks: certificate trust and identity matching. It does
**not** prove network reachability, real emulator TLS behavior, SDK request
signing or AWS API compatibility.

## First-run checklist for a host SDK and Testcontainers

1. **Keep the test runner on the host.** Review the trusted application source.
   Allow only a vetted emulator image/build; do not put Docker's socket inside
   an untrusted test container. The Testcontainers library can manage an
   emulator container while the app tests execute as a host process.
2. **Require an actual loopback-only port publication.** The upstream Docker
   guide's explicit form is `127.0.0.1:9297:9297`, not a wildcard host
   publication. Some Testcontainers helpers choose a random host port or
   wildcard binding; inspect their **actual published binding** and stop if
   it is broader than localhost. Keep the emulator's internal port and its
   per-port file directory consistent with the official instructions.
3. **Wait for this emulator run to be ready.** Authentication-on starts
   generate fresh `emulator_credentials`, `config`, `ca.pem` and (for Java)
   `truststore.p12`, generally under `~/.aws/emulator/9297/` on the host when
   the official private directory mapping is in place. These files are
   per-run (and normally permission-protected); do **not** copy credentials
   to Compose environment variables, GitHub logs, shared images, or sibling
   containers. Wait for their generation and refresh them after a restart.
4. **Use the host loopback URL and verify both TLS checks.** Configure your
   SDK's emulator endpoint as `https://127.0.0.1:9297`. For the AWS CLI,
   Boto3 and Go v2, use the current `AWS_CA_BUNDLE` path. For JavaScript
   SDK v3, AWS documents `NODE_EXTRA_CA_CERTS` read when the Node process
   starts; for Java use this run's `truststore.p12`. These trust settings
   **cannot fix** a wrong service-name SAN. Don't disable certificate or
   hostname verification.
5. **Keep SigV4 authentication enabled.** SDK requests require the
   **emulator-issued credentials for this run**, not fixed `test`/`test`
   values, IAM keys from your AWS account, or credentials copied from an old
   emulator instance. Scope `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`,
   region and endpoint to the **host test process only**. Clear preexisting
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and
   `AWS_PROFILE`; prevent fallback to instance metadata. For AWS CLI and Boto3 host-run
   tests, set `AWS_ENDPOINT_URL=https://127.0.0.1:9297`,
   `AWS_EC2_METADATA_DISABLED=true`, and
   `AWS_DISABLE_HOST_PREFIX_INJECTION=true` in that process. Other SDKs may
   need explicit endpoint or host-prefix settings; consult the linked per-SDK
   documentation. Never carry emulator-only settings into a real AWS
   deployment. Do not print any secrets or copy the credential file into
   another service.
6. **Prove the endpoint before invoking a trusted app.** From the host,
   use the current CA with a normal TLS-verified loopback health check, and
   confirm SDK identity is the emulator's **synthetic** account (`000000000000`)
   before executing state-changing tests. If the SDK ignores the configured
   endpoint or identity, TLS or credentials cannot be verified, **stop**
   rather than fall back to AWS.
7. **Then and only then run app assertions.** Prefer unique synthetic buckets,
   queues and tables, independent SDK readback, and scoped resource cleanup.
   A 200 response or successful handshake alone does not prove the app is
   correct. Revalidate CA and credentials after **every emulator restart**.

### Separate container: what remains unresolved

Sharing only `ca.pem` with a sibling test container does **not** solve an
endpoint named `aws`: the hostname SAN check still fails. A sibling container
also needs safely provisioned **new per-start emulator credentials** for
SigV4. [Upstream issue #566](https://github.com/aws/aws-emulator/issues/566)
requests a different lifecycle; as of the linked report this is **not an
assumed supported fixed-key feature**. Do not substitute a static credential
pair, turn off signature checking, disable HTTPS verification, add a
plaintext-forwarding proxy, mount all of `~/.aws`, or expose port 9297 on a
host's external interface. Private Compose networking alone does not fix
certificate identity or credential lifecycle.

If a future upstream release supports a verified service-name SAN plus
narrowly scoped run credentials, review and test that release separately.
**This guide does not claim to resolve either upstream issue, nor to have
run an independent Docker/Compose/Testcontainers integration test.**
