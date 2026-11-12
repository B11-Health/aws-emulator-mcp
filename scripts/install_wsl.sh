#!/usr/bin/env bash
set -euo pipefail
BASE="$HOME/.local/share/aws-emulator-mcp"
mkdir -p "$BASE" "$HOME/.local/bin"
cd "$BASE"
DEB_URL="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb"
curl --retry 3 --retry-delay 2 --fail --location --silent --show-error -C - "$DEB_URL" -o aws-emulator.deb
curl --fail --location --silent --show-error "$DEB_URL.sig" -o aws-emulator.deb.sig
curl --fail --location --silent --show-error "https://downloads.aws.com/keys/gpg/current.asc" -o aws-publishing.asc
gpg --batch --no-default-keyring --keyring "$BASE/aws-publishing.gpg" --import aws-publishing.asc >/dev/null 2>&1
FINGERPRINT="$(gpg --batch --no-default-keyring --keyring "$BASE/aws-publishing.gpg" --with-colons --fingerprint ssm-publishing@amazon.com | awk -F: '$1=="fpr" {print $10; exit}')"
if [ "$FINGERPRINT" != "98BCF336A3BE53B734E967C52E5BF49BD940F624" ]; then echo "Unexpected AWS signing fingerprint: $FINGERPRINT" >&2; exit 3; fi
gpg --batch --no-default-keyring --keyring "$BASE/aws-publishing.gpg" --verify aws-emulator.deb.sig aws-emulator.deb
mkdir -p "$BASE/package"
dpkg-deb -x aws-emulator.deb "$BASE/package"
BIN="$(find "$BASE/package" -type f -name aws-emulator -print -quit)"
if [ -z "$BIN" ]; then echo 'Emulator binary absent from package' >&2; exit 4; fi
chmod u+x "$BIN"
ln -sfn "$BIN" "$HOME/.local/bin/aws-emulator"
echo "INSTALLED_BIN=$BIN"
"$HOME/.local/bin/aws-emulator" --version
