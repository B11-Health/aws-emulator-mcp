# GitHub Pages launch gate — Proof Explorer

**Status, November 18, 2026: NOT DEPLOYED.** The [public Demo Studio](https://b11-health.github.io/aws-emulator-mcp/) is live; the planned Proof Explorer URL currently returns **HTTP 404**. This is a release checklist, **not a launch announcement**.

## How Pages publishes this repository

A read-only GitHub Pages configuration query on November 18 confirmed: legacy build mode; source branch **master**; directory **/docs**; public site [https://b11-health.github.io/aws-emulator-mcp/](https://b11-health.github.io/aws-emulator-mcp/). The repository has **no GitHub Actions Pages deployment workflow**. Draft PR #80 is not the Pages source until reviewed and merged.

**This gate does not deploy Pages, merge, start Docker, execute Python application code, call AWS, or contact anyone.**

## Step 1 — prelaunch static integrity, automatically in PR CI

With Node.js 20+ and a full **source checkout** of the exact candidate commit (not an installed npm package):

~~~sh
node scripts/pages_launch_gate.mjs --local
~~~

This runs `node scripts/pages_launch_gate.mjs --local`. Exit **0** requires the homepage to link to its Proof Explorer **relative to the GitHub Pages project prefix**, the referenced HTML/CSS/JS/video/poster files to exist under docs, and the Explorer JS to reference both real SQS/DynamoDB and S3 evidence files. Both recorded JSON files must also pass the existing fail-closed red/green comparison validation (named regression, independent assertions, hashes, same emulator version and cleanup).

**A local pass does not mean the site is published.** The Quality gates PR workflow runs the local test, with no deployment action.

## Step 2 — separate lead approval

The lead must review the exact PR, test outcomes and deployment decision. If approved, the established Pages source is **master /docs**. This document does not authorize a merge or publishing step.

Until the public Explorer passes a live test, preview it only on localhost using the instructions in [PROOF_WORKFLOW.md](PROOF_WORKFLOW.md#preview-the-proof-explorer-before-github-pages-publishes-it). **Do not advertise the public Explorer URL.**

## Step 3 — manual post-deployment smoke, only after approved release

After the reviewed Pages source deploys, in the full candidate source checkout run:

~~~sh
node scripts/pages_launch_gate.mjs --public
~~~

This fixed-origin, read-only HTTPS smoke tests the public homepage, its relative Explorer link, both HTML pages, JavaScript/CSS/media links, and **both JSON evidence files**. It checks HTTP success and MIME types; bounded GET reads HTML/JS/JSON and HEAD probes large media without downloading MP4 files. Redirects fail closed. No credentials, external arbitrary hosts, AWS calls or writes.

**Exit 0:** the deployed files are accessible and internally consistent, **not** proof of a new emulator test, production AWS fidelity, IAM or independent adoption.

**Exit 1:** public launch gate failed; preserve error details, stop promotion, and resolve through the approved source/deploy process. A **404 is a failure**, not an optional asset.

The evidence is project-maintained historical test data; this smoke does not attest production AWS behavior or independently certify it. Replacements require explicit case-path review and negative-test updates.

## Proposed consent-based first-use experiment — NOT run

After lead approval, invite **10 consenting developers who were not contributors** through one approved opt-in feedback channel. No unsolicited outreach. Give each a reviewed preview commit, Node.js 20+ and Git prerequisites and the same instruction: run `onboard --offline --json` *without help* and explain what passed.

Count **all consenting starts**, including failures and abandonments. Record OS, Node version, start-to-exit duration, command/exit status, whether help was needed, and whether the participant accurately says **seven local architecture artifacts validated, no AWS API or Python app executed**. Collect only redacted, non-sensitive diagnostics.

**Proposed success target: at least 8 of 10** finish unaided within five minutes *after Node/Git setup* **and** understand that limited proof. An incorrect AWS-parity interpretation is a failure even if the exit status was zero. Report counts and failure reasons, not stars or page views.

**Zero independent results have been measured.** No outreach is authorized or performed by this documentation.
