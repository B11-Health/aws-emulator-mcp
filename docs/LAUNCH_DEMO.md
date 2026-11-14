# AWS Emulator MCP — product walkthroughs

The launch media focuses on one question: **What can a developer do with this?**

The finished demos are collected in the [demo gallery](DEMO_GALLERY.md):

| Clip | Length | What it shows |
|:--|--:|:--|
| [Product tour](assets/demos/product-tour.mp4) | 25s | Install → reproduce → verify → explore |
| [Bug-fix walkthrough](assets/demos/fix-the-bug.mp4) | 22s | Two fulfillment events become one |
| [Getting started](assets/demos/getting-started.mp4) | 16s | Install and open a local development lab |
| [LinkedIn cut](assets/demos/linkedin-launch.mp4) | 21s | A caption-led introduction for social sharing |

The walkthrough clips are screen recordings of the interactive onboarding interface. Their numbers and outcomes come from the [versioned application evidence](evidence/app-debug-aws-emulator-1.0.365.json). They do not represent an active AI chat or an arbitrary agent-written patch being executed.

To reproduce the application test against your local AWS Emulator:

~~~bash
npm install -g "github:B11-Health/aws-emulator-mcp#master"
aws-emulator-mcp app-debug compare
~~~

For the guided interactive tour, see [onboarding](ONBOARDING.md). For the packaged Python application and patch, see [application debugging](APP_DEBUGGING.md).

The previous extended narrated cut is retired. New launch material is silent, caption-led, and focused on the developer outcome rather than narration or internal project history.
