param(
  [int]$Port = 80,
  [string]$HostName = 'digidatinfosystems'
)

$hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
$entry = "127.0.0.1 $HostName"
$existing = if (Test-Path -LiteralPath $hostsPath) { Get-Content -LiteralPath $hostsPath -ErrorAction Stop } else { @() }
if ($existing -contains $entry) {
  Write-Host "Hosts entry already present: $entry"
} else {
  Add-Content -LiteralPath $hostsPath -Value $entry -Encoding ASCII
  Write-Host "Added hosts entry: $entry"
}
Write-Host "Open: http://$HostName/"
Write-Host "Launcher uses port $Port"
