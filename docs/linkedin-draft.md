# Code Gym LinkedIn announcement — unpublished draft

Destination: https://www.linkedin.com/company/codegympr/

Use only after the B11-Health public release and demonstrated workflow are
verified. Replace the URL placeholder with the exact working release/repo link.
The wording below describes the intended demonstrated release, not a claim that
the inaccessible source passed fresh tests today.

---

Your AI agent should be able to test an AWS workflow before touching your AWS account.

AWS just launched its official local emulator. At Code Gym, we're building an
open-source MCP bridge that lets an agent work with it through a focused set of tools.

The demo shows one complete local workflow:

• Write an order to DynamoDB.
• Send and receive its ID through SQS.
• Store a receipt in S3 and read it back.
• Verify the results and clean up the resources created by the run.

The source, setup instructions, and reproducible test evidence are here:
[VERIFIED_PUBLIC_REPOSITORY_URL]

This is an independent community project, published on GitHub under B11-Health.
It is not endorsed by AWS. The emulator supports development testing; it does
not replace production or IAM security validation.

Try the example and tell us where it breaks. If it's useful, star the repo and
help shape the next workflow.

What would you want your agent to test locally first?

#AWS #MCP #OpenSource
