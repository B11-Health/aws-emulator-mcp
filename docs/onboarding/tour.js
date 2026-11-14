(function () {
  "use strict";
  // Recorded measurements from docs/evidence/app-debug-aws-emulator-1.0.365.json
  // and an isolated 20-operation coverage run on AWS Emulator v1.0.365.
  // This interface is an interactive explanation, NOT a live terminal.
  const scenes = [
    {
      eyebrow: "01 / GET STARTED", name: "Connect", title: "One install. An AWS lab for your agent.",
      subtitle: "Run the emulator locally and connect your preferred MCP client.",
      tag: "LOCAL DOCKER", file: "quick-start.sh",
      terminal: '<span class="dim"># Install from the GitHub repository</span>\n<span class="cmd">$</span> npm install -g "github:B11-Health/aws-emulator-mcp#master"\n\n<span class="dim"># Verify your local development lab</span>\n<span class="cmd">$</span> aws-emulator-mcp doctor\n<span class="good">✓</span> Local AWS Emulator ready\n\n<span class="dim"># Connect a compatible editor or agent</span>\n<span class="cmd">$</span> aws-emulator-mcp config vscode',
      result: "Your workspace", status: "READY", metrics: [["1", "Local runtime", "green"], ["0", "AWS accounts needed", "blue"]],
      note: "The first runtime command builds the local Docker image. Your agent can then run supported AWS-style workflows."
    },
    {
      eyebrow: "02 / REPRODUCE", name: "Find the bug", title: "One order. Two fulfillment events.",
      subtitle: "A client retries an order. The application publishes the same fulfillment work again.",
      tag: "DYNAMODB · S3 · SQS", file: "recorded / buggy run",
      terminal: '<span class="cmd">$</span> aws-emulator-mcp app-debug buggy\n\n<span class="dim"># Submit the order, then retry it</span>\n<span class="good">✓</span> DynamoDB order saved\n<span class="good">✓</span> S3 receipt validated\n<span class="good">✓</span> SQS message received\n\n<span class="bad">✕</span> Duplicate retry accepted\n<span class="bad">✕</span> Fulfillment events received: <span class="bad">2</span>\n<span class="dim"># 3 application assertions failed</span>',
      result: "Before the fix", status: "BUG FOUND", metrics: [["2", "Accepted submissions", "red"], ["2", "Queue events", "red"]],
      note: "The duplicate was independently observed in SQS—not inferred from a successful publish response."
    },
    {
      eyebrow: "03 / VERIFY", name: "Verify the fix", title: "Same order. Exactly one event.",
      subtitle: "A conditional DynamoDB write rejects the duplicate before another message is published.",
      tag: "PATCH VERIFIED", file: "recorded / fixed run",
      terminal: '<span class="cmd">$</span> aws-emulator-mcp app-debug fixed\n\n<span class="dim"># PutItem with conditional write</span>\n<span class="yellow">ConditionExpression:</span>\n<span class="yellow">  attribute_not_exists(#pk)</span>\n\n<span class="good">✓</span> First submission accepted\n<span class="good">✓</span> Duplicate request suppressed\n<span class="good">✓</span> One SQS fulfillment event\n<span class="good">✓</span> Seven application assertions pass\n<span class="good">✓</span> Seven cleanup checks pass',
      result: "After the fix", status: "VERIFIED", metrics: [["1", "Accepted submission", "green"], ["1", "Queue event", "green"]],
      note: "The broken and fixed versions each had seven successful cleanup checks on separate resources."
    },
    {
      eyebrow: "04 / EXPLORE", name: "Explore", title: "Explore more than one workflow.",
      subtitle: "Use guided service experiments and inspect which selected API operations respond.",
      tag: "SERVICE LABS", file: "recorded / local probes",
      terminal: '<span class="cmd">$</span> aws-emulator-mcp experiments\n<span class="good">✓</span> SNS → SQS message delivery\n<span class="good">✓</span> EC2 VPC and subnet lifecycle\n<span class="good">✓</span> EventBridge event bus\n<span class="good">✓</span> SSM parameter round trip\n<span class="good">✓</span> S3, DynamoDB and Secrets Manager\n\n<span class="cmd">$</span> aws-emulator-mcp coverage\n<span class="good">✓</span> 20 / 20 selected read-only probes responded',
      result: "Keep building", status: "8 LABS", metrics: [["8", "Guided experiments", "blue"], ["20/20", "Selected API probes", "green"]],
      note: "Explore API models, test supported operations and read scoped cleanup reports. Service coverage varies."
    }
  ];
  let index = 0, timer = null;
  const $ = id => document.getElementById(id);
  function render(nextIndex) {
    index = Math.max(0, Math.min(scenes.length - 1, nextIndex));
    const s = scenes[index];
    $("eyebrow").textContent = s.eyebrow;
    $("title").textContent = s.title;
    $("subtitle").textContent = s.subtitle;
    $("tag").textContent = s.tag;
    $("terminal-title").textContent = s.file;
    $("terminal").innerHTML = s.terminal;
    $("result-name").textContent = s.result;
    $("status").textContent = s.status;
    $("status").classList.toggle("warning", index === 1);
    $("metrics").replaceChildren();
    s.metrics.forEach(function (item) {
      const card = document.createElement("div");
      card.className = "metric " + item[2];
      const value = document.createElement("div");
      value.className = "value"; value.textContent = item[0];
      const label = document.createElement("div");
      label.className = "label"; label.textContent = item[1];
      card.append(value, label); $("metrics").append(card);
    });
    $("result-note").textContent = s.note;
    $("progress-text").textContent = "STEP " + (index + 1) + " OF " + scenes.length;
    $("progress-name").textContent = s.name;
    $("bar-fill").style.width = ((index + 1) / scenes.length * 100) + "%";
    $("back").disabled = index === 0;
    $("next").textContent = index === scenes.length - 1 ? "Start again ↺" : "Next step →";
    document.querySelectorAll(".step").forEach(function (element) {
      const active = Number(element.dataset.step) === index;
      element.classList.toggle("active", active);
      if (active) element.setAttribute("aria-current", "step");
      else element.removeAttribute("aria-current");
    });
    document.body.dataset.step = String(index);
  }
  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null; $("play").textContent = "▶ Play tour";
  }
  function next() { render((index + 1) % scenes.length); }
  $("next").addEventListener("click", function () { stop(); next(); });
  $("back").addEventListener("click", function () { stop(); render(index - 1); });
  $("play").addEventListener("click", function () {
    if (timer !== null) return stop();
    timer = setInterval(next, 3800);
    $("play").textContent = "Ⅱ Pause";
  });
  document.querySelectorAll(".step").forEach(function (element) {
    element.addEventListener("click", function () { stop(); render(Number(element.dataset.step)); });
  });
  let x = 0, y = 0;
  function point(x2, y2) {
    x = x2; y = y2;
    document.body.classList.add("pointer-on");
    $("pointer").style.left = x + "px"; $("pointer").style.top = y + "px";
    $("pointer-halo").style.left = x + "px"; $("pointer-halo").style.top = y + "px";
    $("pointer-ring").style.left = x + "px"; $("pointer-ring").style.top = y + "px";
  }
  document.addEventListener("pointermove", function (event) {
    if (event.pointerType !== "touch") point(event.clientX, event.clientY);
  });
  document.addEventListener("pointerdown", function () {
    const ring = $("pointer-ring");
    ring.classList.remove("ping"); void ring.offsetHeight; ring.classList.add("ping");
  });
  window.tour = { go: render, next: next, point: point, stop: stop };
  render(0);
})();
