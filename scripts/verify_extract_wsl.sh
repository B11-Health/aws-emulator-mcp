#!/usr/bin/env bash
set -euo pipefail
BASE="$HOME/.local/share/aws-emulator-mcp"
cd "$BASE"
[ "$(stat -c %s aws-emulator.deb)" -eq 170938884 ] || { echo 'Package size incomplete'; exit 2; }
DEB_URL="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb"
curl --retry 3 --fail --silent --show-error --location "$DEB_URL.sig" -o aws-emulator.deb.sig
curl --retry 3 --fail --silent --show-error --location https://downloads.aws.com/keys/gpg/current.asc -o aws-publishing.asc
gpg --batch --no-default-keyring --keyring "$BASE/aws-publishing.gpg" --import aws-publishing.asc >/dev/null 2>&1
FPR="$(gpg --batch --no-default-keyring --keyring "$BASE/aws-publishing.gpg" --with-colons --fingerprint ssm-publishing@amazon.com | awk -F: '$1=="fpr" {print $10; exit}')"
[ "$FPR" = "98BCF336A3BE53B734E967C52E5BF49BD940F624" ] || { echo "AWS key fingerprint mismatch $FPR"; exit 3; }
gpg --batch --no-default-keyring --keyring "$BASE/aws-publishing.gpg" --verify aws-emulator.deb.sig aws-emulator.deb
mkdir -p "$BASE/package" "$HOME/.local/bin"
dpkg-deb -x aws-emulator.deb "$BASE/package"
BIN="$(find "$BASE/package" -type f -name aws-emulator -print -quit)"
[ -n "$BIN" ] || { echo 'Binary not found in signed Debian package'; exit 4; }
chmod u+x "$BIN"
ln -sfn "$BIN" "$HOME/.local/bin/aws-emulator"
"$HOME/.local/bin/aws-emulator" --version
echo "OFFICIAL_AWS_EMULATOR_READY"
