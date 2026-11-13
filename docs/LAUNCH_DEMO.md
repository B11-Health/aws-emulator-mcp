# Launch demonstration: make the laboratory tangible

**Objective:** In 75–90 seconds, a new developer should understand *what they can do*, *why the emulator matters*, and *why adding MCP is useful*.

**The one sentence to earn:** “I can ask my AI assistant to run AWS-style experiments on my own machine without opening an AWS account.”

This is a production brief, **not a claim that this version of the video has been recorded or released**.

## Shoot only real execution

Record the installed local MCP client interacting with the actual AWS Emulator. Keep a terminal or results view that shows real tool names, returned data, error states and cleanup evidence. Never fake tool calls, resource names, response bodies or screenshots. Hide private host paths, credentials and unrelated browser tabs. Use synthetic data.

| Time | Picture | Narration | Evidence to show |
| --- | --- | --- | --- |
| 0–10s | Chat prompt: “Make an order flow in my local AWS lab.” | “What if your AI could **use AWS-style services** without deploying to AWS?” | Actual AI-client prompt |
| 10–20s | Emulator doctor succeeds | “AWS Emulator runs the APIs locally. AWS Emulator MCP connects an assistant to them.” | Loopback endpoint and isolated emulated account; redact credentials |
| 20–43s | Order is stored and message is sent | “Store an order in DynamoDB, queue work in SQS, and create an S3 receipt.” | Real tool trace or actual scenario report |
| 43–57s | Missing receipt returns expected 404; then upload/get succeeds | “We can even make the receipt fail on purpose and prove the recovery.” | Both expected error and verified content |
| 57–72s | Cleanup report with only run-specific names | “When we're done, delete only what this experiment created.” | Four cleanup checks and final inventory |
| 72–90s | Local source and simple installation commands | “Your own AWS playground, controlled by your AI. Get the open-source MCP from B11-Health.” | Actual verified repo URL, install/demo commands; no private placeholder |

**Lower-third disclaimer:** “Local API emulator for development. Not real AWS, complete AWS fidelity, or production IAM validation.”

## A shorter plain-language voiceover

> “Want to experiment with AWS without setting up an AWS account? AWS Emulator brings supported AWS APIs onto your computer. AWS Emulator MCP connects your AI assistant to them with MCP. Ask it to create a bucket, store records, send messages or run an entire synthetic order workflow. Watch the actual API results. Make a mistake. Fix it. Verify the result. Clean up. Real AWS-style experiments, no production cloud resources, no AWS service charge for the local lab. The emulator is the workshop. Your AI is the operator.”

## QA checklist for an honest launch

- [ ] Open the source repository from a **logged-out** browser; no GitHub permissions required.
- [ ] Install on a clean supported computer and complete the example using the published instructions.
- [ ] Source code, commit SHA, test evidence, video, version, and link all match.
- [ ] Record a **real write-capable local MCP** session; do **not** substitute the remote three-tool Secure QA plugin.
- [ ] No live credentials, personal IDs, nonpublic URLs or secret tokens appear in the video.
- [ ] Correct attribution: AWS created AWS Emulator and its official agent skill; The AWS Emulator MCP project independently created this MCP adapter.
- [ ] No false claims about Lambda triggers, payments, production security, auto code repair or all AWS services.
- [ ] Mobile-readable captions and the resource cleanup outcome remain visible.

**Demo command:** After the Windows install, run **demo.cmd**; on Debian/Ubuntu run **bash scripts/order_demo_linux.sh**. The same scenario is callable as **emulator_order_demo** from a compatible local MCP client. See [example](../examples/order_workflow.md).
