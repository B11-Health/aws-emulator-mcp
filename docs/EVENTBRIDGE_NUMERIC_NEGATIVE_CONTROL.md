# EventBridge numeric precision: a negative control, not just a green send

A successful \`PutEvents\` acknowledgement does **not** tell you whether an
EventBridge rule selected the correct event. A historical AWS Emulator issue,
[aws/aws-emulator#477](https://github.com/aws/aws-emulator/issues/477),
described an integer pattern for \`2^53\` also matching \`2^53+1\`.

This maintained, synthetic, **read-only** contract calls
\`events.TestEventPattern\` three times with the **same** literal rule:

| Event \`detail.orderId\` | Assertion |
| --- | --- |
| \`9007199254740992\` | \`Result == true\` |
| \`9007199254740993\` | \`Result == false\` |
| \`42\` | \`Result == false\` |

The numbers are serialized as distinct exact JSON integer literals (not JS
Number values), and the request is carried inside JSON *strings* to the SDK.

## Inspect before executing

From an already reviewed local checkout with Python 3.10+:

\`\`\`sh
PYTHONPATH=src python3 -m unittest tests.test_eventbridge_numeric_contract -v
\`\`\`

That test checks the bundled contract's structure, literal integer values,
three assertions, and absence of writing operations. It **does not** contact
Docker, AWS or the emulator and is not runtime proof.

## Optional local emulator run

After reviewing the contract and ensuring you have a safe Docker Engine,
Linux containers, sufficient free disk and the signed local image you intend
to use, check the environment first:

\`\`\`sh
node bin/aws-emulator-mcp.mjs preflight --json
\`\`\`

**Separate opt-in step (can build a large signed image if absent):**

\`\`\`sh
node bin/aws-emulator-mcp.mjs contract examples/contracts/eventbridge-numeric-boundary.json --json
\`\`\`

The contract runner uses an isolated local emulator, synthetic data and
emulator-issued credentials. It returns redacted step/assertion evidence,
not request payloads or a test of production AWS. This contract does **not**
create a rule, attach SQS, put events or prove delivery semantics. Test
EventBridge-to-SQS delivery separately using an owned disposable rule and queue,
and check both expected delivery **and expected non-delivery** with cleanup.

## Reproducibility and limitations

On **November 20, 2026**, a project-maintained offline Docker test using a
cached local AWS Emulator **v1.0.523** observed the expected \`true,false,false\`
for the three literal integer values. A *separate* temporary EventBridge →
SQS local test observed target counts \`1,0,0\`, all \`PutEvents\` calls had
\`FailedEntryCount=0\`, and its owned rule/target/queue cleanup passed \`3/3\`.
The upstream issue originally reproduced on older versions. This is not
independent customer adoption or a guarantee of correctness across versions,
regions, rules, JSON encodings, all EventBridge behavior or live AWS.

A negative assertion proves more than a successful \`PutEvents\` acknowledgement,
but a green \`TestEventPattern\` contract still does not establish application
execution, target delivery or AWS parity. If this fixture fails on your own
reviewed emulator version, report the version, \`Result\` observations, and
sanitized evidence; no credentials, private endpoints or customer event data.
