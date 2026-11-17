# Review AWS architecture changes in a pull request

**Architecture Review** turns a small, checked-in AWS blueprint change into
a before/after diagram, an evidence table and a GitHub Actions status check
**without querying AWS or executing application code**.

The official AWS Emulator already supports local SDK and CLI tests. This
independent tool adds something different: *a reproducible source-level review
of the infrastructure a developer proposes*, including an explanation of
which changes warrant human attention.

[**See the actual before/after diagram**](../examples/architecture/review/reference/architecture-diff.svg) ·
[Inspect its evidence](../examples/architecture/review/reference/report.json) ·
[Read the sample PR summary](../examples/architecture/review/reference/summary.md).

## What a reviewer sees

The bundled example starts with a receipts S3 bucket and an orders DynamoDB
table. The proposal adds a fulfillment SQS queue **and changes DynamoDB's
partition key**:

| Resource | Local blueprint status | Why it matters |
| :-- | :-- | :-- |
| `FulfillmentQueue` | Added | A new queue is proposed |
| `OrdersTable` | Modified / high review priority | Changing a key may require replacement in a real CloudFormation deployment |
| `ReceiptsBucket` | Unchanged | No generated resource-property change |

The review artifacts include the **combined SVG**, individual before/after
SVG and editable draw.io diagrams, both generated CloudFormation YAML drafts,
canonical JSON blueprints, a machine-readable report with SHA-256 provenance,
and a Markdown summary. You can inspect all 11 files in GitHub Actions without
opening or funding an AWS account.

These are **not actual AWS CloudFormation change-set actions**. A high-priority
flag doesn't prove that AWS will replace or delete anything. Actual impact
requires reviewing a CloudFormation change set in the target account. In
particular, removing a bucket or table from a template with a Retain policy
may leave data and billing behind rather than delete them.

## Install the action in another repository

1. Commit an
   [Architecture Studio manifest](../examples/architecture/order-intake.json)
   at `.aws-emulator/architecture.json` in your repository.
2. Create `.github/workflows/aws-architecture-review.yml`:

```yaml
name: AWS architecture review
on: [pull_request]

permissions:
  contents: read

jobs:
  blueprint-review:
    runs-on: ubuntu-24.04
    timeout-minutes: 12
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          fetch-depth: 0 # Required to read the base commit; don't execute PR code
          persist-credentials: false
      - uses: B11-Health/aws-emulator-mcp@v0.4.0-beta.15
        with:
          manifest: .aws-emulator/architecture.json
          fail-on-risk: high
```

The repository-root Action above is the shortest installation path. For a
production integration, pin the **exact 40-character source commit SHA**
instead of a movable version tag. The original nested Action path remains
available for existing consumers.

**Verify in a separate repository:** the project-maintained
[add-only consumer PR](https://github.com/B11-Health/aws-emulator-mcp-action-demo/pull/1)
passed with 11 independently verified evidence files; the
[intentionally blocked DynamoDB-key PR](https://github.com/B11-Health/aws-emulator-mcp-action-demo/pull/2)
exited code 2 by policy while still uploading the review evidence. These
are **project-maintained regression demonstrations, not independent third-party
endorsements**.

3. Open a PR that changes your JSON blueprint. The Action compares the
   proposed file with the **actual base commit version**, produces the
   visual diff and its sanitized evidence artifact, and fails if
   `fail-on-risk: high` finds a resource removal, a resource-type change,
   or a DynamoDB partition-key change. To display warnings without
   blocking a PR, choose `fail-on-risk: never`.

The Action has a repository-root `action.yml` metadata file so GitHub can
evaluate it for Marketplace publication, but Marketplace listing status
depends on a separate publication workflow and required publisher agreement.
The Action being available by `uses:` does not prove it is listed in the
Marketplace.

The action uses a **pinned version of the trusted compiler** from this
repository. It consumes your PR's JSON as *data*, never imports code from
the PR, does not execute the workflow being reviewed, and does not comment
or write back to the repository. It uses `pull_request` (not
`pull_request_target`) with read-only permissions. The only shell
invocation is a safe, bounded read of a known Git blob by SHA, with no
textconv or shell evaluation. A PR introducing this manifest for the first
time is marked as *no baseline* rather than silently fabricating one.

### Trust boundaries

- The architecture language is limited to a conceptual actor and up to
  three resources: S3 bucket, DynamoDB table and SQS queue.
- Both manifest files must fit the 24 KiB bound and pass the strict schema,
  identifier, resource and secret-like-input validator.
- Unrecognized services, arbitrary CloudFormation/IAM, links, traversal
  paths, scripts and unexpected fields are rejected.
- All diagrams are escaped XML/SVG with no remote images or executable code.
- The job never receives AWS access keys. A successful check is **not**
  authorization to deploy anything and does not test IAM fidelity.
- The GitHub job summary and seven-day artifact contain only the proposed
  source-level comparison; there are no AWS API results from this action.

## Run it before opening a PR

Requires Node.js 20+ and Git, but **no Docker or AWS account**:

```bash
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.15"

aws-emulator-mcp architecture review \
  examples/architecture/review/before.json \
  examples/architecture/review/after.json --json
```

By default this writes `reports/architecture-review/` and exits
successfully with an informational report. Add `--fail-on-risk` to make
high-priority changes return a nonzero exit status. The action's
`fail-on-risk` setting controls the same policy.

**Want to test the resulting SDK lifecycle too?** Use the separate
[PR contract gate](CI_CONTRACT_GATE.md) and local [AWS Emulator](CONTRACT_TESTING.md).
Architecture Review itself makes no claim that an app has been tested.

## Next steps

This feature is a **preview of declared architecture**, not a scanner of an
existing AWS account. Future work in
[Architecture Studio RFC #27](https://github.com/B11-Health/aws-emulator-mcp/issues/27)
would use a separate, opt-in, least-privilege AWS identity for real
CloudFormation change-set previews. Actual AWS execution would require a
distinct explicit authorization. It is not part of this Action or release.

This is an independent project and not an official AWS-endorsed integration.
