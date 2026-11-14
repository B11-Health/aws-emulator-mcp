"""Quality gates for the product onboarding and short-form demo assets."""
import json
from pathlib import Path
import shutil
import sys
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
VIDEOS = {
    "product-tour": ("1280", "720", 24, 27),
    "fix-the-bug": ("1280", "720", 20, 24),
    "getting-started": ("1280", "720", 14, 18),
    "linkedin-launch": ("1080", "1350", 18, 24),
}


class LaunchMediaTests(unittest.TestCase):
    def test_asset_structure_and_bounded_file_sizes(self):
        for name in VIDEOS:
            video = ROOT / "docs/assets/demos" / (name + ".mp4")
            poster = ROOT / "docs/assets/demos" / (name + "-poster.jpg")
            with self.subTest(video=name):
                self.assertTrue(video.is_file())
                self.assertEqual(video.read_bytes()[4:8], b"ftyp")
                self.assertLess(video.stat().st_size, 5_000_000)
                self.assertTrue(poster.is_file())
                self.assertEqual(poster.read_bytes()[:2], bytes.fromhex("ffd8"))
        preview = ROOT / "docs/assets/demos/tour-preview.gif"
        self.assertTrue(preview.read_bytes().startswith((b"GIF89a", b"GIF87a")))
        self.assertLess(preview.stat().st_size, 3_000_000)

    @unittest.skipIf(sys.platform == "win32", "Codec validation runs on the Linux CI media gate")
    @unittest.skipUnless(shutil.which("ffprobe"), "ffprobe not available")
    def test_clip_dimensions_duration_and_silent_delivery(self):
        for name, (w, h, minimum, maximum) in VIDEOS.items():
            path = ROOT / "docs/assets/demos" / (name + ".mp4")
            result = subprocess.run(
                ["ffprobe", "-v", "error", "-show_streams", "-show_format",
                 "-of", "json", str(path)],
                text=True, capture_output=True, check=True, timeout=20)
            obj = json.loads(result.stdout)
            video = [s for s in obj["streams"] if s["codec_type"] == "video"]
            audio = [s for s in obj["streams"] if s["codec_type"] == "audio"]
            with self.subTest(video=name):
                self.assertEqual(len(video), 1)
                self.assertEqual(video[0]["codec_name"], "h264")
                self.assertEqual((str(video[0]["width"]), str(video[0]["height"])), (w, h))
                self.assertEqual(len(audio), 0, "Caption-led demos have no soundtrack")
                duration = float(obj["format"]["duration"])
                self.assertGreater(duration, minimum)
                self.assertLess(duration, maximum)

    def test_onboarding_site_is_self_contained(self):
        html = (ROOT / "docs/onboarding/index.html").read_text(encoding="utf-8")
        js = (ROOT / "docs/onboarding/tour.js").read_text(encoding="utf-8")
        css = (ROOT / "docs/onboarding/style.css").read_text(encoding="utf-8")
        self.assertIn('src="./tour.js"', html)
        self.assertIn('href="./style.css"', html)
        self.assertIn('pointermove', js)
        self.assertIn("const scenes", js)
        self.assertIn("prefers-reduced-motion", css)
        self.assertNotIn("https://fonts.googleapis", html + css)
        self.assertNotIn("<iframe", html)

    def test_launch_copy_is_brand_consistent(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        linkedin = (ROOT / "docs/linkedin-draft.md").read_text(encoding="utf-8")
        for artifact in (readme, linkedin):
            self.assertIn("AWS Emulator MCP", artifact)
            for banned in (
                "Code Gym / independent developer preview",
                "Real tools. Real emulator.",
                "Kokoro voice", "84-second continuous screen recording",
            ):
                self.assertNotIn(banned, artifact)
        self.assertIn("ONE RETRY. TWO EVENTS.", (ROOT / "scripts/render_launch_social.py").read_text(encoding="utf-8"))
        self.assertIn("not yet published on npm", readme.lower())


if __name__ == "__main__":
    unittest.main()
