#!/usr/bin/env python3
"""Record a guided tour of the static, evidence-backed onboarding page.

Developer asset-production script (not part of runtime). Requires Playwright
and a local Chromium installation. It does not connect to AWS or the network.
"""
from pathlib import Path
import json
import math
import os
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = (ROOT / "docs/onboarding/index.html").as_uri()
OUT = ROOT / "docs/assets/demos"
OUT.mkdir(parents=True, exist_ok=True)
SCENES = {
    "product-tour": [
        ("start", 3100), ("next", 4800), ("next", 5000),
        ("next", 4650), ("end", 2300)
    ],
    "fix-the-bug": [
        ("bug", 4800), ("fixed", 5500), ("bug", 2600),
        ("fixed", 3450)
    ],
    "getting-started": [
        ("start", 5500), ("explore", 4600), ("start", 2800)
    ],
}


def glide(page, x, y, steps=18):
    cur = page.evaluate("({x:parseInt(document.getElementById('pointer').style.left)||100,y:parseInt(document.getElementById('pointer').style.top)||100})")
    sx, sy = cur["x"], cur["y"]
    for i in range(1, steps + 1):
        t = i / steps
        t = t * t * (3 - 2 * t)
        page.mouse.move(sx + (x - sx) * t, sy + (y - sy) * t)
        page.wait_for_timeout(28)


def click(page, selector):
    target = page.locator(selector)
    rect = target.bounding_box()
    if not rect:
        raise RuntimeError("No visible selector: " + selector)
    x, y = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
    glide(page, x, y)
    page.mouse.down()
    page.wait_for_timeout(110)
    page.mouse.up()
    page.wait_for_timeout(440)


def capture(name, steps):
    with tempfile.TemporaryDirectory(prefix="aws-mcp-tour-") as tmp, sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            executable_path="/usr/bin/google-chrome",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 720},
            device_scale_factor=1,
            record_video_dir=tmp,
            record_video_size={"width": 1280, "height": 720},
            reduced_motion="no-preference",
        )
        page = ctx.new_page()
        page.goto(URL, wait_until="load")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.mouse.move(1070, 615)
        page.wait_for_timeout(450)
        for command, hold in steps:
            if command == "next":
                click(page, "#next")
            elif command == "bug":
                click(page, '[data-step="1"]')
            elif command == "fixed":
                click(page, '[data-step="2"]')
            elif command == "explore":
                click(page, '[data-step="3"]')
            elif command == "start":
                if page.locator("body").get_attribute("data-step") != "0":
                    click(page, '[data-step="0"]')
            elif command == "end":
                glide(page, 1110, 631)
            page.wait_for_timeout(hold)
        if errors:
            raise RuntimeError("Browser JS error: " + "; ".join(errors))
        video = page.video
        page.close()
        ctx.close()
        source = Path(tmp) / "capture.webm"
        video.save_as(str(source))
        browser.close()

        target = OUT / (name + ".mp4")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-an", "-c:v", "libx264", "-preset", "slow",
            "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-r", "30", str(target)
        ], check=True)
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", "00:00:04", "-i", str(target), "-frames:v", "1",
            "-q:v", "2", str(OUT / (name + "-poster.jpg"))
        ], check=True)
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration,size", "-of", "json", str(target)],
            capture_output=True, text=True, check=True,
        )
        print(name, result.stdout.strip())


if __name__ == "__main__":
    for key, value in SCENES.items():
        capture(key, value)
