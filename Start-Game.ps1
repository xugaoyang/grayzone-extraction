$ErrorActionPreference = 'Stop'
$gameRoot = $PSScriptRoot
Set-Location -LiteralPath $gameRoot
try {
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $npmCommand = Get-Command npm.cmd -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $gameRoot 'node_modules'))) {
    & $npmCommand.Source install --loglevel error
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $gameRoot 'dist\index.html'))) {
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw 'Game build failed.' }
  }
  $chosenPort = $null
  $candidatePorts = @(4173..4183)
  $recordPath = Join-Path $gameRoot 'work\server-process.json'
  if (Test-Path -LiteralPath $recordPath) {
    try {
      $previous = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
      $previousPort = [int]$previous.port
      if ($previousPort -ge 4173 -and $previousPort -le 4183) { $candidatePorts = @($previousPort) + @($candidatePorts | Where-Object { $_ -ne $previousPort }) }
    } catch {}
  }
  foreach ($candidate in $candidatePorts) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$candidate/health" -TimeoutSec 1
      if ($health.app -eq 'grayzone-extraction') { Start-Process "http://127.0.0.1:$candidate"; exit 0 }
    } catch {}
  }
  foreach ($candidate in $candidatePorts) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $chosenPort = $candidate; break } catch {} finally { $listener.Stop() }
  }
  if ($null -eq $chosenPort) { throw 'Ports 4173-4183 are busy. Close another game server and retry.' }
  $workPath = Join-Path $gameRoot 'work'
  New-Item -ItemType Directory -Path $workPath -Force | Out-Null
  $serverScript = Join-Path $gameRoot 'server.mjs'
  $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $serverScript + '"'), "$chosenPort") -WorkingDirectory $gameRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $workPath 'server.log') -RedirectStandardError (Join-Path $workPath 'server-error.log')
  @{ pid = $serverProcess.Id; port = $chosenPort; script = $serverScript } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workPath 'server-process.json')
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$chosenPort/health" -TimeoutSec 1; if ($health.app -eq 'grayzone-extraction') { $ready = $true; break } } catch {}
  }
  if (-not $ready) { throw 'Server did not start. See work/server-error.log.' }
  Start-Process "http://127.0.0.1:$chosenPort"
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
