#!/usr/bin/env bash
set -euo pipefail
SRC=/mnt/c/Users/codeg/mcp-shell-auth/workspace/aws-emulator-mcp/scripts
for attempt in $(seq 1 50); do
    if python3 "$SRC/parallel_download_wsl.py"; then
        echo "Download completed on attempt $attempt"
        exec bash "$SRC/verify_extract_wsl.sh"
    fi
    sleep 2
done
echo "AWS Emulator package download incomplete" >&2
exit 6
