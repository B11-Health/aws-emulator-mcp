# AWS Emulator MCP — LinkedIn launch kit

**Publisher:** B11-Health GitHub project, AWS Emulator MCP.
**Format:** native LinkedIn video, with concise caption text.
**Video:** [LinkedIn launch cut (4:5)](assets/demos/linkedin-launch.mp4) · [Poster](assets/demos/linkedin-launch-poster.jpg)
**Repository:** https://github.com/B11-Health/aws-emulator-mcp

## Primary launch post

One order. One customer. Two fulfillment messages.

That's the kind of bug an AI coding assistant should catch before a deployment.

We built **AWS Emulator MCP** to give coding agents a local workspace for testing AWS-backed applications.

Our first application walkthrough uses DynamoDB, S3, and SQS:

• A duplicate retry sends two messages.
• A conditional DynamoDB write prevents the second send.
• The same tests confirm one message and clean up their resources.

Beyond that example, the project includes guided service experiments, AWS SDK discovery, and operation-level regression checks.

Open source, with an npm launcher you can install directly from GitHub.

**See the demo and try it:** https://github.com/B11-Health/aws-emulator-mcp

What AWS workflow would you want an agent to test locally?

#AWS #MCP #DeveloperTools #OpenSource

## Shorter cut

The interesting part isn't asking AI to write AWS code. It's giving it somewhere to test its assumptions.

We built AWS Emulator MCP around that idea. In our Python order-intake demo, a retry sends two SQS fulfillment messages. A conditional DynamoDB write brings that back to one—and we can rerun the test locally.

Guide, code, and demo: https://github.com/B11-Health/aws-emulator-mcp

#AWS #MCP #OpenSource

## Contextual comment — AWS Emulator announcement

**Priority 1:** Matt Wood's November 11, 2026 LinkedIn field note beginning **“AI field note: Today we’re introducing AWS Emulator”**. He specifically discusses duplicate-order handling. This is a strong, substantive fit; locate the original post within LinkedIn after signing in. Public visibility of the full post was confirmed through LinkedIn's indexed profiles; its exact post permalink has not been confirmed.

**Comment to publish on that post:**

> This is exactly the testing loop that caught our attention. We used AWS Emulator to reproduce the duplicate-order case in a small DynamoDB/S3/SQS application: an identical retry published two fulfillment messages. With a conditional DynamoDB write, the same test received one. We added the workflow to an open-source MCP adapter so coding assistants can inspect the failing source and rerun the check. The next challenge I'm interested in is the crash window between the database write and queue publication. Are cross-service fault-injection scenarios on the emulator roadmap?

**Priority 2:** AWS Developers' November 11, 2026 LinkedIn launch post beginning **“You can build and test AWS applications on your own machine or in your CI pipelines”**. A shorter comment is appropriate:

> We've been exploring the application-feedback side of this launch. A small local order-intake test exposed a duplicate SQS publish on retry; the patched DynamoDB conditional write passed the same test with one event. The interesting opportunity is making these feedback loops easy to run from an MCP-capable coding assistant. Excited to see the fidelity coverage grow.

**Do not post the same wording on multiple threads.** Lead with a useful observation, not a link. Include the GitHub link only when it adds context or someone asks for the source. Do not imply AWS endorsed, built, or reviewed the independent MCP adapter.

## Publishing order

1. Upload [the 4:5 video](assets/demos/linkedin-launch.mp4) as native video and use the **primary launch post**. The clip is caption-first and has no voiceover. The first frame presents the problem rather than a list of services.
2. Review the post after publishing and verify the actual clickable project link.
3. Comment once on the relevant AWS announcement with the contextual text above. Don't spray generic launch comments across unrelated posts.
4. Reply to genuine questions with specific example commands or limitations. If someone asks about full AWS compatibility, link to [the measured coverage guide](COVERAGE.md).

**Status:** Prepared. No LinkedIn post or comment is claimed as published. Authenticated Shell browser access must be restored and the correct signed-in account verified before posting.

## Why this wording

The message centers on a developer problem, an observable before/after outcome, and a clear next action. It leaves implementation details, test counts, historical branding, and lengthy qualifiers in the repository documentation rather than the social post.

## Relevant primary sources

- AWS launch article (November 11, 2026): https://aws.amazon.com/blogs/aws/test-your-applications-against-aws-locally-with-aws-emulator/
- AWS insights from Matt Wood (November 11, 2026): https://aws.amazon.com/blogs/aws-insights/better-feedback-for-building-with-agents/
- AWS Emulator source: https://github.com/aws/aws-emulator
