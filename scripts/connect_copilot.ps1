param(
    [switch]$Preview,
    [switch]$Replace,
    [string]$SourceFile = "",
    [string]$Destination = ""
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$version = "0.3.0"
$installed = Join-Path $env:LOCALAPPDATA "CodeGym\AWS-Emulator-MCP\v$version"
if ([string]::IsNullOrWhiteSpace($SourceFile)) {
    $SourceFile = Join-Path $installed "generated\copilot-mcp.windows-wsl.json"
}
if ([string]::IsNullOrWhiteSpace($Destination)) {
    if (-not [string]::IsNullOrWhiteSpace($env:COPILOT_HOME)) {
        $copilotRoot = $env:COPILOT_HOME
    } else {
        $copilotRoot = Join-Path $env:USERPROFILE ".copilot"
    }
    $Destination = Join-Path $copilotRoot "mcp-config.json"
}
$scriptFile = Join-Path $installed "scripts\connect_client.py"
if (-not (Test-Path -LiteralPath $scriptFile)) {
    throw "Stable Code Gym install not found. Run install.cmd first."
}
if (-not (Test-Path -LiteralPath $SourceFile)) {
    throw "Generated Copilot configuration missing. Run install.cmd first."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL unavailable; install Ubuntu WSL2 before connecting."
}

function Convert-ToWslPath([string]$WindowsPath) {
    $value = (& wsl.exe -e wslpath -a $WindowsPath 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value.StartsWith("/")) {
        throw "Could not resolve the Windows path inside WSL."
    }
    return $value
}

$sourceLinux = Convert-ToWslPath $SourceFile
$destinationLinux = Convert-ToWslPath $Destination
$scriptLinux = Convert-ToWslPath $scriptFile
$wslArguments = @("-e","python3",$scriptLinux,
                  "--source",$sourceLinux,"--destination",$destinationLinux)
if (-not $Preview) { $wslArguments += "--apply" }
if ($Replace) { $wslArguments += "--replace" }

Write-Host ""
Write-Host "Code Gym / Connect VS Code Copilot (native MCP)" -ForegroundColor Cyan
Write-Host "Destination: $Destination"
if ($Preview) {
    Write-Host "Preview mode: no client configuration will be changed."
} else {
    Write-Host "Explicit connect mode: existing configurations are backed up."
}
& wsl.exe @wslArguments
if ($LASTEXITCODE -ne 0) {
    throw "Could not safely connect the MCP server. Existing configuration was not replaced."
}
if ($Preview) {
    Write-Host "Preview passed. Run connect-copilot.cmd without -Preview to apply." -ForegroundColor Cyan
} else {
    Write-Host "Next: open VS Code Copilot, choose MCP Servers, and start aws-emulator-local." -ForegroundColor Green
}
