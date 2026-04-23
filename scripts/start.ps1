param(
  [string]$Server = "http://127.0.0.1:5173",
  [string]$Session = ""
)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location "$Root/agent"

if ($Session) {
  go run ./cmd/ttys-agent -server $Server -session $Session
  exit $LASTEXITCODE
}

go run ./cmd/ttys-agent -server $Server
exit $LASTEXITCODE
