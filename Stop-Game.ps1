$ErrorActionPreference = 'Stop'
$recordPath = Join-Path $PSScriptRoot 'work\server-process.json'
if (Test-Path -LiteralPath $recordPath) {
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $serverInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction SilentlyContinue
  $expectedScript = Join-Path $PSScriptRoot 'server.mjs'
  if ($serverInfo -and $serverInfo.Name -eq 'node.exe' -and $serverInfo.CommandLine.Contains($expectedScript)) {
    Stop-Process -Id $serverInfo.ProcessId
    Write-Host 'GRAYZONE server stopped.'
  }
}
