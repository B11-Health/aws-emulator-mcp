#!/usr/bin/env bash
# Rootless installer for the official AWS Emulator Debian package (Ubuntu WSL2).
# Fails closed: no binary executes before signature verification.
set -euo pipefail
for name in curl gpg dpkg-deb sha256sum find; do
  command -v "$name" >/dev/null || { echo "Missing $name" >&2; exit 2; }
done
BASE="$HOME/.local/share/aws-emulator-mcp"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BASE" "$BIN_DIR"
WORK="$(mktemp -d "$BASE/.install.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
URL="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb"
EXPECTED="98BCF336A3BE53B734E967C52E5BF49BD940F624"
# A unique fresh download prevents mixing bytes across mutable "latest" releases.
curl --fail --location --silent --show-error --retry 6 --retry-all-errors \
  --connect-timeout 30 "$URL" --output "$WORK/emulator.deb"
curl --fail --location --silent --show-error --retry 6 --retry-all-errors \
  --connect-timeout 30 "$URL.sig" --output "$WORK/emulator.deb.sig"
curl --fail --location --silent --show-error --retry 6 --retry-all-errors \
  --connect-timeout 30 "https://downloads.aws.com/keys/gpg/current.asc" \
  --output "$WORK/publishing.asc"
gpg --batch --no-default-keyring --keyring "$WORK/publisher.gpg" \
  --import "$WORK/publishing.asc" >/dev/null 2>&1
FPR="$(gpg --batch --no-default-keyring --keyring "$WORK/publisher.gpg" \
  --with-colons --fingerprint ssm-publishing@amazon.com \
  | awk -F: '$1=="fpr" {print $10;exit}')"
if [[ "$FPR" != "$EXPECTED" ]]; then
  echo "AWS signing key fingerprint mismatch. Refusing package." >&2
  exit 3
fi
gpg --batch --no-default-keyring --keyring "$WORK/publisher.gpg" \
  --verify "$WORK/emulator.deb.sig" "$WORK/emulator.deb"
VERSION="$(dpkg-deb -f "$WORK/emulator.deb" Version)"
if [[ ! "$VERSION" =~ ^[a-zA-Z0-9.+~_-]+$ ]]; then
  echo "Unsafe package version string" >&2; exit 4
fi
dpkg-deb -x "$WORK/emulator.deb" "$WORK/unpacked"
SOURCE="$(find "$WORK/unpacked" -type f -name aws-emulator -print -quit)"
if [[ -z "$SOURCE" ]]; then
  echo "Signed package lacks aws-emulator" >&2; exit 5
fi
# Side-by-side install avoids overwriting a running instance.
DEST="$BASE/release-$VERSION-$(date +%s)"
mv "$WORK/unpacked" "$DEST"
BIN="$(find "$DEST" -type f -name aws-emulator -print -quit)"
chmod u+x "$BIN"
ln -sfn "$BIN" "$BIN_DIR/aws-emulator"
echo "Verified official AWS Emulator package: $VERSION"
echo "SHA256: $(sha256sum "$WORK/emulator.deb" | awk '{print $1}')"
"$BIN_DIR/aws-emulator" --version
