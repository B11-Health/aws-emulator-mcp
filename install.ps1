param(
    [switch]$Preview
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "AWS Emulator MCP - one-click local setup" -ForegroundColor Cyan
Write-Host "Publisher: B11-Health  |  Code Gym on LinkedIn"
Write-Host "No AWS account or cloud credentials required."
Write-Host ""

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Error "Windows Subsystem for Linux is missing. Install Ubuntu WSL2 with 'wsl --install -d Ubuntu', reboot if needed, and retry."
    exit 2
}
$version = "0.3.0"
$targetBase = Join-Path $env:LOCALAPPDATA "CodeGym\AWS-Emulator-MCP"
$target = Join-Path $targetBase "v$version"
$source = $PSScriptRoot
if ($Preview) {
    Write-Host "PREVIEW: source = $source"
    Write-Host "PREVIEW: stable installation = $target"
    Write-Host "PREVIEW: only application source, scripts, docs and tests are copied"
    Write-Host "PREVIEW: WSL bootstrap and local tests will run"
    exit 0
}

# Install to a stable per-user path. Deleting Downloads will not break MCP.
New-Item -ItemType Directory -Path $target -Force | Out-Null
if (-not [string]::Equals($source, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
    $entries = @(
        "src","scripts","tests","docs","examples",
        "README.md","LICENSE","SECURITY.md","RELEASE_QA.md","CHANGELOG.md","CONTRIBUTING.md",
        "pyproject.toml","install.ps1","install.cmd","install.sh","demo.ps1","demo.cmd"
    )
    foreach ($name in $entries) {
        $from = Join-Path $source $name
        $to = Join-Path $target $name
        if (-not (Test-Path -LiteralPath $from)) { continue }
        if (Test-Path -LiteralPath $to) {
            Remove-Item -LiteralPath $to -Recurse -Force
        }
        Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
    }
}

$wslRepo = (& wsl.exe -e wslpath -a "$target" 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRepo.StartsWith("/")) {
    Write-Error "Cannot reach the installed project in WSL. Confirm Ubuntu is your default WSL distro."
    exit 2
}

Write-Host "Installed project: $target" -ForegroundColor Cyan
Write-Host "Running emulator bootstrap and real local integration tests..."
& wsl.exe -e bash "$wslRepo/scripts/quickstart_linux.sh" $wslRepo
if ($LASTEXITCODE -ne 0) {
    Write-Error "Setup failed. Review the error above; current MCP client settings were not modified."
    exit 1
}

Write-Host "Generating ready-to-copy client configurations..." -ForegroundColor Cyan
& wsl.exe -e python3 "$wslRepo/scripts/generate_client_config.py" $wslRepo --target windows-wsl
if ($LASTEXITCODE -ne 0) {
    Write-Error "Emulator is ready but MCP configuration generation failed."
    exit 1
}
Write-Host ""
Write-Host "INSTALLATION VERIFIED" -ForegroundColor Green
Write-Host "MCP config: $target\generated\mcp-client.windows-wsl.json"
Write-Host "VS Code:   $target\generated\vscode-mcp.windows-wsl.json"
Write-Host "No client settings were modified. Copy the appropriate generated server entry."
Write-Host "ChatGPT web cannot connect directly to WSL's local loopback server."
