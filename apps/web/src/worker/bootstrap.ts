type BootstrapOptions = {
  binaryBaseURL: string;
  checksumsURL: string;
  serverOrigin: string;
  sessionId?: string | null;
};

export function renderShellBootstrap({
  binaryBaseURL,
  checksumsURL,
  serverOrigin,
  sessionId,
}: BootstrapOptions) {
  return `#!/bin/sh
set -eu

SERVER_URL="${serverOrigin}"
BINARY_BASE_URL="${binaryBaseURL}"
CHECKSUMS_URL="${checksumsURL}"
SESSION_ID="${sessionId ?? ""}"
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="\${1:-}"
fi
TMP_DIR="\${TMPDIR:-/tmp}/ttys"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux) ;;
  *)
    echo "unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

mkdir -p "$TMP_DIR"
ASSET_NAME="ttys-agent-zig-$OS-$ARCH"
AGENT_PATH="$TMP_DIR/$ASSET_NAME"
DOWNLOAD_URL="$BINARY_BASE_URL/$ASSET_NAME"
CHECKSUMS_PATH="$TMP_DIR/ttys-agent-checksums.txt"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$AGENT_PATH"
  curl -fsSL "$CHECKSUMS_URL" -o "$CHECKSUMS_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$AGENT_PATH" "$DOWNLOAD_URL"
  wget -qO "$CHECKSUMS_PATH" "$CHECKSUMS_URL"
else
  echo "curl or wget is required to download ttys-agent" >&2
  exit 1
fi

EXPECTED_CHECKSUM="$(awk "/  $ASSET_NAME$/ { print \\$1 }" "$CHECKSUMS_PATH" | head -n 1)"
if [ -z "$EXPECTED_CHECKSUM" ]; then
  echo "missing checksum for $ASSET_NAME" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(shasum -a 256 "$AGENT_PATH" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(sha256sum "$AGENT_PATH" | awk '{print $1}')"
else
  echo "shasum or sha256sum is required to verify ttys-agent" >&2
  exit 1
fi

if [ "$ACTUAL_CHECKSUM" != "$EXPECTED_CHECKSUM" ]; then
  echo "checksum mismatch for $ASSET_NAME" >&2
  exit 1
fi

chmod +x "$AGENT_PATH"

TTY_DEVICE="/dev/tty"
if [ ! -r "$TTY_DEVICE" ] || [ ! -w "$TTY_DEVICE" ]; then
  echo "ttys-agent requires an interactive terminal (/dev/tty not available)" >&2
  exit 1
fi

if [ -n "$SESSION_ID" ]; then
  exec "$AGENT_PATH" -server "$SERVER_URL" -session "$SESSION_ID" <"$TTY_DEVICE" >"$TTY_DEVICE" 2>"$TTY_DEVICE"
fi

exec "$AGENT_PATH" -server "$SERVER_URL" <"$TTY_DEVICE" >"$TTY_DEVICE" 2>"$TTY_DEVICE"
`;
}

export function renderPowerShellBootstrap({
  binaryBaseURL,
  checksumsURL,
  serverOrigin,
  sessionId,
}: BootstrapOptions) {
  return `param(
  [string]$Session = "${sessionId ?? ""}"
)

$Server = "${serverOrigin}"
$BinaryBaseUrl = "${binaryBaseURL}"
$ChecksumsUrl = "${checksumsURL}"
$Os = "windows"

switch ($env:PROCESSOR_ARCHITECTURE.ToLower()) {
  "amd64" { $Arch = "amd64" }
  "arm64" { $Arch = "arm64" }
  default {
    Write-Error "unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
    exit 1
  }
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) "ttys"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$AssetName = "ttys-agent-zig-$Os-$Arch.exe"
$AgentPath = Join-Path $Tmp $AssetName
$DownloadUrl = "$BinaryBaseUrl/$AssetName"
$ChecksumsPath = Join-Path $Tmp "ttys-agent-checksums.txt"

Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $AgentPath
Invoke-WebRequest -UseBasicParsing -Uri $ChecksumsUrl -OutFile $ChecksumsPath

$ExpectedChecksum = $null
foreach ($line in Get-Content $ChecksumsPath) {
  if ($line -match "^(?<hash>[0-9a-fA-F]+)\\s{2}(?<name>.+)$" -and $Matches["name"] -eq $AssetName) {
    $ExpectedChecksum = $Matches["hash"].ToLower()
    break
  }
}

if (-not $ExpectedChecksum) {
  Write-Error "missing checksum for $AssetName"
  exit 1
}

$ActualChecksum = (Get-FileHash -Algorithm SHA256 $AgentPath).Hash.ToLower()
if ($ActualChecksum -ne $ExpectedChecksum) {
  Write-Error "checksum mismatch for $AssetName"
  exit 1
}

$AgentArgs = @("-server", $Server)
if ($Session) {
  $AgentArgs += @("-session", $Session)
}

$AgentProcess = Start-Process -FilePath $AgentPath -ArgumentList $AgentArgs -NoNewWindow -Wait -PassThru
exit $AgentProcess.ExitCode
`;
}
