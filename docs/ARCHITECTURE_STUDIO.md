# Architecture Studio — CloudFormation and diagrams from one manifest

**Current scope: offline generation, not AWS deployment.**

Architecture Studio is an independent, deliberately small architecture compiler
built into AWS Emulator MCP. One reviewed JSON blueprint produces:

1. A canonical resource/flow manifest.
2. A CloudFormation YAML template and equivalent JSON template.
3. An SVG architecture diagram suitable for code review.
4. An **editable diagrams.net / draw.io** diagram (`.drawio`).
5. A separate, **synthetic** AWS SDK contract for the same service *types*.
6. A deterministic report with file hashes, service mappings and limitations.

These files are generated locally with Node.js 20+ built-ins only.
**No AWS account, credentials, Docker, browser, cloud mutations, or network
connection is required to generate them.**

## Try the built-in blueprint

```bash
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.12"

aws-emulator-mcp architecture demo
```

Seven files appear in `reports/architecture-studio/`:

```text
architecture.json
template.yaml
template.json
diagram.svg
diagram.drawio
contract.json
report.json
```

Open `diagram.svg` in a browser. Open `diagram.drawio` in
[diagrams.net](https://app.diagrams.net/) or a compatible desktop editor.
The diagrams show an application actor and **conceptual data-flow arrows**;
the actor and any integration wiring are **not** part of the generated stack.

[Preview the bundled SVG](../examples/architecture/reference/diagram.svg) ·
[Read the editable diagram source](../examples/architecture/reference/diagram.drawio) ·
[Inspect the generated template](../examples/architecture/reference/template.yaml) ·
[Inspect the matching local test](../examples/architecture/reference/contract.json)

## Generate a custom, reviewable blueprint

Copy the [sample JSON manifest](../examples/architecture/order-intake.json)
into your own repository and edit it:

```bash
aws-emulator-mcp architecture build my-architecture.json --json
# Or choose an explicit relative output directory:
aws-emulator-mcp architecture build my-architecture.json reports/my-design --json
```

Manifest version 1 supports **one conceptual application actor** and **one
resource of each selected type**, for a total of one to three resources:

| Manifest type | CloudFormation type | Default security measures |
| --- | --- | --- |
| `s3-bucket` | `AWS::S3::Bucket` | Block public access, AES256 at rest, versioning, Retain |
| `dynamodb-table` | `AWS::DynamoDB::Table` | Pay-per-request, explicit string hash key, SSE enabled, Retain |
| `sqs-queue` | `AWS::SQS::Queue` | SQS-managed SSE, 60-second visibility timeout |

A CloudFormation-created physical name is used—**not** a hard-coded global
bucket name. The template returns bucket/table names and queue URL through
CloudFormation Outputs. Bucket and DynamoDB Retain policies protect data,
but retained resources may continue accruing AWS charges until reviewed and
deleted separately.

Each resource must have exactly one conceptual flow from the actor. A flow
does **not** generate a Lambda function, service integration, notification,
IAM grant, API Gateway, or security group. The output represents resources,
not a complete deployable order-processing application.

The generator intentionally refuses arbitrary CloudFormation fragments,
IAM policies, user-provided shell scripts, unsupported types or extra fields.
Inputs, path lengths and output files are bounded. Symlinked and
workspace-escaping paths are rejected; existing output files with different
content cannot be overwritten. Identical builds are idempotent.

## Validate before using AWS

Generated resources and graphs are checked for consistent IDs and referenced
relationships. CI independently parses the SVG/draw.io XML, compares the
canonical template JSON with YAML, and runs **`cfn-lint`** over the sample
CloudFormation template.

If you modify a custom template, repeat that independent validation:

```bash
python -m pip install cfn-lint==1.46.0
cfn-lint reports/architecture-studio/template.yaml
```

Linting checks schema and properties. It does **not** prove your IAM controls,
AWS account quotas, Region support, future costs, or successful deployment.

## Test the supported AWS API behavior locally

The generated `contract.json` uses only synthetic fixtures and creates its
**own** S3 bucket, DynamoDB table and SQS queue inside the emulator. The
three-service demo contains 14 SDK steps, including deletion of its
synthetic test resources. The contract runner also waits (bounded) for an
emulated DynamoDB table to reach `ACTIVE` after successful `CreateTable`.

```bash
aws-emulator-mcp contract reports/architecture-studio/contract.json --json
```

This command **does** require a local Docker daemon and the signed emulator
image. The test is not CloudFormation execution and does not interact with
resources in a real AWS account. Actual CloudFormation deployment is not
supported in this milestone.

## Review architecture changes in GitHub

[Architecture Review](ARCHITECTURE_REVIEW.md) compares two manifests, renders
before/after SVG and draw.io diagrams, and marks additions, edits and removals
with conservative human-review flags. It can run as a read-only pull-request
check that requires no AWS account and never executes PR code. It is not a
CloudFormation change set.

## How to reason about provenance

| Artifact | What it means | What it does not establish |
| --- | --- | --- |
| `architecture.json` | Reviewed proposed resource/flow model | AWS account discovery |
| `template.yaml` | CloudFormation resources for the selected subset | Actual deployment or IAM wiring |
| `diagram.svg` / `.drawio` | Consistent model and conceptual flows | Live AWS topology |
| `contract.json` | Synthetic local SDK lifecycle tests | Tests of a deployed stack or application |
| `report.json` | Deterministic hashes and scope warnings | A security certification |

**Next stage: read-only cloud deployment planning, not immediate production
deployment.** The proposed [Architecture Studio RFC](https://github.com/B11-Health/aws-emulator-mcp/issues/27)
would add permission-scoped template validation against a chosen AWS account,
a CloudFormation change-set preview, account/Region and replacement/cost
warnings, then an entirely separate explicitly approved execution mechanism.
It must never reuse emulator credentials as real AWS permissions.

The project is independent and not endorsed by AWS.
