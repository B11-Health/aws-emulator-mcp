#!/usr/bin/env python3
"""Create a caption-led social cut from the guided tour's verified screen states.

Uses the existing static walkthrough and its measured AWS Emulator evidence.
No generative speech, mock CLI execution, or network access.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/assets/demos"
OUT.mkdir(exist_ok=True)
FONT = "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf"
BOLD = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"
BG = "#0a101d"
WHITE = "#f0f6ff"
MUTED = "#a7bad1"
MINT = "#75e4bf"
RED = "#f3a4a4"
BLUE = "#91c1ff"
CARDS = [
    ("YOUR AI, MEET A LOCAL CLOUD LAB.", "Test AWS-backed code before you deploy.", "/tmp/aws-tour-step-0.png", "WORKFLOW 01 / CONNECT"),
    ("ONE RETRY. TWO EVENTS.", "Catch the bug your integration test should catch.", "/tmp/aws-tour-step-1.png", "WORKFLOW 02 / REPRODUCE"),
    ("FIX THE CAUSE.", "Make the DynamoDB write conditional.", "/tmp/aws-tour-step-2.png", "WORKFLOW 03 / REPAIR"),
    ("ONE ORDER. ONE EVENT.", "Same test. Seven cleanup checks. Repeatable.", "/tmp/aws-tour-step-2.png", "WORKFLOW 04 / VERIFY"),
    ("BUILD. TEST. CLEAN UP.", "AWS Emulator MCP · github.com/B11-Health/aws-emulator-mcp", "/tmp/aws-tour-step-3.png", "START WITH THE SOURCE"),
]


def font(sz, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, sz)


def image_card(index, heading, sub, source, kicker, target):
    W, H = 1080, 1350
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    for y in range(H):
        frac = y / H
        d.line([(0, y), (W, y)], fill=(int(10+5*frac), int(16+16*frac), int(29+24*frac)))
    d.rounded_rectangle((56, 58, 110, 112), 17, fill=MINT)
    d.text((74, 64), "λ", font=font(36, True), fill="#12263d")
    d.text((127, 67), "AWS Emulator MCP", font=font(32, True), fill=WHITE)
    d.text((64, 174), kicker, font=font(23, True), fill=MINT, spacing=1)
    # Break headline on deliberate words if it would exceed available width
    words = heading.split(" ")
    lines = []; current = ""
    for word in words:
        candidate = (current + " " + word).strip()
        if d.textbbox((0, 0), candidate, font=font(62, True))[2] > 945 and current:
            lines.append(current); current = word
        else:
            current = candidate
    if current: lines.append(current)
    baseline = 238
    for line in lines:
        d.text((59, baseline), line, font=font(62, True), fill=WHITE)
        baseline += 88
    d.text((61, baseline+12), sub, font=font(26), fill=MUTED)
    # Inset screenshot captured from the working interactive tour.
    frame = Image.open(source).convert("RGB")
    frame = frame.resize((946, 532), Image.Resampling.LANCZOS)
    top = 510
    back = Image.new("RGBA", (970, 554), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (970, 554), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((13, 13, 955, 543), radius=18, fill=(0, 0, 0, 190))
    back.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    im.paste(back, (55, top-5), back)
    d.rounded_rectangle((65, top+5, 1015, top+543), radius=15, fill="#2b4057", outline="#50708d", width=2)
    im.paste(frame, (67, top+7))
    d.rounded_rectangle((60, 1127, 1020, 1228), 17, fill="#17263a", outline="#36536a", width=2)
    left = "BEFORE: 2 EVENTS" if index == 1 else "AFTER: 1 EVENT" if index in (2, 3) else "EXPLORE 8 GUIDED LABS"
    fill = RED if index == 1 else MINT
    d.text((85, 1151), left, font=font(29, True), fill=fill)
    d.text((65, 1290), "LOCAL DEVELOPMENT  •  OPEN SOURCE  •  B11-HEALTH / GITHUB",
           font=font(18, True), fill="#93aabe")
    im.save(target, optimize=True)


def make_video():
    with tempfile.TemporaryDirectory(prefix="aws-mcp-social-") as temp:
        tmp = Path(temp)
        for i, item in enumerate(CARDS):
            image_card(i, *item, tmp / f"slide-{i}.png")
        inputs = []
        for i in range(len(CARDS)):
            inputs += ["-loop", "1", "-t", "4.6", "-i", str(tmp / f"slide-{i}.png")]
        chains = []
        # Four fades, final 21 second LinkedIn-ready 4:5 video.
        for i in range(5):
            chains.append(f"[{i}:v]fps=24,format=yuv420p,setsar=1[v{i}]")
        chains.append("[v0][v1]xfade=transition=fade:duration=0.5:offset=4.1[x1]")
        chains.append("[x1][v2]xfade=transition=fade:duration=0.5:offset=8.2[x2]")
        chains.append("[x2][v3]xfade=transition=fade:duration=0.5:offset=12.3[x3]")
        chains.append("[x3][v4]xfade=transition=fade:duration=0.5:offset=16.4[out]")
        out = OUT / "linkedin-launch.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + inputs +
                       ["-filter_complex", ";".join(chains),
                        "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "medium",
                        "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                        str(out)], check=True)
        image_card(1, *CARDS[1], OUT / "linkedin-launch-poster.jpg")
        print(out.name, out.stat().st_size, "bytes")
        return out


if __name__ == "__main__":
    make_video()
