> Archived, unapproved wording from an earlier campaign. This is not a product identity guide; use README.md for current product naming.

# AWS Emulator MCP community launch draft — ARCHIVAL

**Destination:** https://www.linkedin.com/company/codegympr/

Publish only after B11-Health repository is publicly accessible without login, a separate clean install succeeds, the release gates pass, and the video contains the actual write-capable local MCP demo. Replace the link with a verified real URL. Do not say this was released or tested publicly before it happens.

---

## Recommended launch post

What if you could **experiment with AWS simply by talking to your AI assistant**—without deploying anything to a real AWS account?

AWS has released its official local AWS Emulator. We built **AWS Emulator MCP**, an independent open-source bridge that lets compatible AI assistants operate supported AWS-style APIs on your computer.

Ask it to:

• Create an S3 bucket and save a sample file.
• Store a DynamoDB record and read it back.
• Send and receive an SQS work item.
• Run a synthetic order workflow across all three services.
• Trigger an expected error, verify the recovery, and clean up.

**The emulator is your workshop. MCP gives your AI the tools.**

It's not production AWS, and API coverage has limits. It's a practical way to learn, prototype, reproduce errors and validate supported workflows before deploying.

The source and runnable demo: **https://github.com/B11-Health/aws-emulator-mcp**

Project: AWS Emulator MCP. Source publisher: B11-Health GitHub account. Not affiliated with or endorsed by AWS.

What would you ask your AI to build in a local cloud lab?

#AWS #MCP #OpenSource #DeveloperTools

---

## Optional shorter opening

“Your own AWS playground. Controlled by an AI assistant. No AWS account needed.”

Use this as the **video title**, but accompany it with the actual S3/DynamoDB/SQS demonstration and clear scope. Do not advertise the remote ChatGPT read-only diagnostics as if they support infrastructure writes.

## Suggested first comment once live

The fastest way to see the idea is the included synthetic order demo. It creates a DynamoDB record, sends a message through SQS, intentionally fails and repairs an S3 receipt lookup, verifies the results, and removes the test resources it created. Try it from a compatible local MCP client after installation.

## Evidence and publication checks

- Public clone URL, release tag and license verified from a logged-out browser.
- Native client onboarding tested from clean Windows/WSL and Linux.
- Source tree and launch video correspond to the same approved commit.
- GitHub release notes distinguish **local 27-tool MCP** from **remote three-tool read-only ChatGPT Secure QA**.
- Do not claim all AWS APIs work, that no compute is consumed, or that this is a replacement for real AWS.
