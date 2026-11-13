param()
Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"
$root=Join-Path $env:LOCALAPPDATA "AWS-Emulator-MCP\v0.3.0"
if (-not (Test-Path (Join-Path $root "scripts\order_demo_linux.sh"))) {
    $legacyRoot = Join-Path $env:LOCALAPPDATA "CodeGym\AWS-Emulator-MCP\v0.3.0"
    if (Test-Path (Join-Path $legacyRoot "scripts\order_demo_linux.sh")) { $root = $legacyRoot }
}
if (-not (Test-Path (Join-Path $root "scripts\order_demo_linux.sh"))) {
    Write-Error "AWS Emulator MCP is not installed. Double-click install.cmd first."
    exit 2
}
$wslRepo=(& wsl.exe -e wslpath -a "$root" 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRepo.StartsWith("/")) {
    Write-Error "Could not access installed project from WSL."
    exit 2
}
Write-Host "Running a fully local, synthetic order workflow..." -ForegroundColor Cyan
& wsl.exe -e bash "$wslRepo/scripts/order_demo_linux.sh" $wslRepo
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "DEMO VERIFIED" -ForegroundColor Green
