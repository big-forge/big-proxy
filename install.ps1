# Installs the latest Proxy App on Windows.
#   irm https://raw.githubusercontent.com/big-forge/big-proxy/main/install.ps1 | iex
#
# Options (environment): PROXY_APP_VERSION=0.1.0  PROXY_APP_NO_LAUNCH=1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'big-forge/big-proxy'

function Fail($message) {
  Write-Host ""
  Write-Host "  Could not install Proxy App: $message" -ForegroundColor Red
  Write-Host ""
  throw $message
}

if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'x86') -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  Fail "this build is for 64-bit Intel/AMD Windows (found $env:PROCESSOR_ARCHITECTURE)."
}

if ($env:PROXY_APP_VERSION) {
  $version = $env:PROXY_APP_VERSION.TrimStart('v')
} else {
  Write-Host "  Finding the latest version..."
  try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'proxy-app-installer' }
  } catch {
    Fail "couldn't read the latest release. Is there a published release at https://github.com/$repo/releases ?"
  }
  $version = $release.tag_name.TrimStart('v')
}

$file = "Proxy-App-$version-windows-x64.zip"
$url = "https://github.com/$repo/releases/download/v$version/$file"
$zip = Join-Path $env:TEMP $file
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Proxy App'

Write-Host "  Downloading Proxy App $version for Windows..."
try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Fail "download failed: $url" }

# Close the running copy so it can be replaced.
Get-Process -Name 'Proxy App' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "  Closing the running Proxy App..."
  $_.CloseMainWindow() | Out-Null
  if (-not $_.WaitForExit(8000)) { $_.Kill() }
}

Write-Host "  Installing (no administrator rights needed)..."
New-Item -ItemType Directory -Force -Path $dir | Out-Null
try { Expand-Archive -Path $zip -DestinationPath $dir -Force } catch { Fail "couldn't unpack the download: $($_.Exception.Message)" }
Remove-Item $zip -Force -ErrorAction SilentlyContinue

# Start menu entry
$exe = Join-Path $dir 'Proxy App.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Proxy App.lnk'
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = $exe
$link.WorkingDirectory = $dir
$link.Save()

if (-not (Test-Path $exe)) { Fail "installed, but couldn't find the app at $exe." }
Write-Host "  Installed: $exe"
if (-not $env:PROXY_APP_NO_LAUNCH) {
  Start-Process $exe
  Write-Host "  Proxy App is open. Look for its icon in the notification area."
}
