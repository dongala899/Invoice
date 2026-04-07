param(
  [int]$Port = 80,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$script:ShouldStop = $false
$script:ShutdownRequested = $false
$script:RegisteredClients = New-Object 'System.Collections.Generic.HashSet[string]'
$script:IdleShutdownDeadline = $null
$idleShutdownSeconds = 8

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8'; break }
    '.css' { 'text/css; charset=utf-8'; break }
    '.js' { 'application/javascript; charset=utf-8'; break }
    '.json' { 'application/json; charset=utf-8'; break }
    '.png' { 'image/png'; break }
    '.jpg' { 'image/jpeg'; break }
    '.jpeg' { 'image/jpeg'; break }
    '.gif' { 'image/gif'; break }
    '.svg' { 'image/svg+xml'; break }
    '.ico' { 'image/x-icon'; break }
    '.txt' { 'text/plain; charset=utf-8'; break }
    default { 'application/octet-stream' }
  }
}

function Read-JsonFile {
  param(
    [string]$Path,
    $Fallback
  )

  if (-not (Test-Path -LiteralPath $Path)) { return $Fallback }
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  if ([string]::IsNullOrWhiteSpace($raw)) { return $Fallback }

  try { return $raw | ConvertFrom-Json } catch { return $Fallback }
}

function ConvertTo-Hashtable {
  param($Value)

  if ($null -eq $Value) { return $null }

  if ($Value -is [System.Collections.IDictionary]) {
    $result = @{}
    foreach ($key in $Value.Keys) { $result[$key] = ConvertTo-Hashtable $Value[$key] }
    return $result
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $Value) { $items.Add((ConvertTo-Hashtable $entry)) }
    return ,$items.ToArray()
  }

  if ($Value.PSObject -and $Value.PSObject.Properties.Count -gt 0 -and -not ($Value -is [string])) {
    $result = @{}
    foreach ($property in $Value.PSObject.Properties) {
      $result[$property.Name] = ConvertTo-Hashtable $property.Value
    }
    return $result
  }

  return $Value
}

function Get-StorageFilePath {
  param([string]$ProjectRoot)
  Join-Path (Join-Path $ProjectRoot 'data') 'storage.json'
}

function Save-StorageSnapshot {
  param(
    [string]$ProjectRoot,
    [hashtable]$Storage
  )

  $storagePath = Get-StorageFilePath -ProjectRoot $ProjectRoot
  $dataDir = Split-Path -Parent $storagePath
  if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
  }

  $payload = @{
    savedAt = (Get-Date).ToString('o')
    storage = $Storage
  }

  ConvertTo-Json $payload -Depth 100 | Set-Content -LiteralPath $storagePath -Encoding UTF8
}

function Get-SeedStorage {
  return @{}
}

function Get-StorageSnapshot {
  param([string]$ProjectRoot)

  $storagePath = Get-StorageFilePath -ProjectRoot $ProjectRoot
  $existing = Read-JsonFile -Path $storagePath -Fallback $null
  if ($existing -and $existing.storage) { return ConvertTo-Hashtable $existing.storage }
  if ($existing -is [System.Collections.IDictionary]) { return ConvertTo-Hashtable $existing }

  $seed = Get-SeedStorage -DataDir (Join-Path $ProjectRoot 'data')
  Save-StorageSnapshot -ProjectRoot $ProjectRoot -Storage $seed
  return $seed
}

function Normalize-LocalPath {
  param(
    [string]$ProjectRoot,
    [string]$RequestPath
  )

  $relative = [System.Uri]::UnescapeDataString(($RequestPath -split '\?')[0]).TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
  if ($relative -eq 'login.html') { $relative = 'index.html' }

  $candidate = Join-Path $ProjectRoot $relative.Replace('/', '\')
  if ((Test-Path -LiteralPath $candidate) -and -not (Get-Item -LiteralPath $candidate).PSIsContainer) {
    return $candidate
  }

  Join-Path $ProjectRoot 'index.html'
}

function Write-HttpResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [byte[]]$Body,
    [string]$ContentType = 'application/octet-stream'
  )

  if ($null -eq $Body) { $Body = [byte[]]::new(0) }
  $headerLines = @(
    "HTTP/1.1 $StatusCode $StatusText",
    "Content-Type: $ContentType",
    "Content-Length: $($Body.Length)",
    'Cache-Control: no-store',
    'Connection: close',
    ''
  )
  $headerText = ($headerLines -join "`r`n") + "`r`n"
  $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($headerText)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

function Write-JsonResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    $Payload
  )

  $json = ConvertTo-Json $Payload -Depth 100
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Write-HttpResponse -Stream $Stream -StatusCode $StatusCode -StatusText $StatusText -Body $bytes -ContentType 'application/json; charset=utf-8'
}

function Parse-QueryString {
  param([string]$RawPath)

  $result = @{}
  $query = ''
  if ($RawPath -match '\?') { $query = $RawPath.Split('?', 2)[1] }
  if ([string]::IsNullOrWhiteSpace($query)) { return $result }

  foreach ($pair in $query.Split('&')) {
    if ([string]::IsNullOrWhiteSpace($pair)) { continue }
    $parts = $pair.Split('=', 2)
    $name = [System.Uri]::UnescapeDataString($parts[0])
    $value = if ($parts.Length -gt 1) { [System.Uri]::UnescapeDataString($parts[1]) } else { '' }
    $result[$name] = $value
  }

  return $result
}

function Get-PathOnly {
  param([string]$RawPath)
  return ($RawPath -split '\?')[0]
}

function Get-ClientId {
  param([hashtable]$Query)
  return [string]($Query['clientId'])
}

function Open-AppBrowser {
  param([int]$Port)
  Start-Process "http://digidatinfosystems/index.html?forceLogin=1&source=shortcut" | Out-Null
}

$projectRoot = Split-Path -Parent $PSScriptRoot
try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
} catch {
  if ($OpenBrowser) {
    Open-AppBrowser -Port $Port
    exit 0
  }
  throw
}

if ($OpenBrowser) {
  Open-AppBrowser -Port $Port
}

Write-Host "Invoice localhost server running at http://digidatinfosystems/ (port $Port)"
Write-Host "Storage file: $(Get-StorageFilePath -ProjectRoot $projectRoot)"

try {
  while (-not $script:ShouldStop) {
    if (-not $script:ShutdownRequested -and $script:RegisteredClients.Count -le 0 -and $null -ne $script:IdleShutdownDeadline) {
      if ([DateTime]::UtcNow -ge $script:IdleShutdownDeadline) {
        $script:ShouldStop = $true
        continue
      }
    }

    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 200
      continue
    }

    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $client.SendTimeout = 5000
      $stream = $client.GetStream()
      $headerBuffer = New-Object System.Collections.Generic.List[byte]
      $headerTerminator = [System.Text.Encoding]::ASCII.GetBytes("`r`n`r`n")

      while ($true) {
        $nextByte = $stream.ReadByte()
        if ($nextByte -lt 0) {
          break
        }

        $headerBuffer.Add([byte]$nextByte)
        if ($headerBuffer.Count -ge 4) {
          $count = $headerBuffer.Count
          if (
            $headerBuffer[$count - 4] -eq $headerTerminator[0] -and
            $headerBuffer[$count - 3] -eq $headerTerminator[1] -and
            $headerBuffer[$count - 2] -eq $headerTerminator[2] -and
            $headerBuffer[$count - 1] -eq $headerTerminator[3]
          ) {
            break
          }
        }
      }

      $headerBytes = $headerBuffer.ToArray()
      $headerText = [System.Text.Encoding]::ASCII.GetString($headerBytes)
      $headerLines = $headerText -split "`r`n"
      $requestLine = if ($headerLines.Length -gt 0) { $headerLines[0] } else { '' }
      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        $stream.Dispose(); $client.Close(); continue
      }

      $parts = $requestLine.Split(' ')
      $method = if ($parts.Length -gt 0) { $parts[0].ToUpperInvariant() } else { 'GET' }
      $rawPath = if ($parts.Length -gt 1) { $parts[1] } else { '/' }
      $pathOnly = Get-PathOnly -RawPath $rawPath
      $query = Parse-QueryString -RawPath $rawPath
      $contentLength = 0

      foreach ($line in $headerLines[1..($headerLines.Length - 1)]) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $idx = $line.IndexOf(':')
        if ($idx -lt 1) { continue }
        $name = $line.Substring(0, $idx).Trim().ToLowerInvariant()
        $value = $line.Substring($idx + 1).Trim()
        if ($name -eq 'content-length') { [int]::TryParse($value, [ref]$contentLength) | Out-Null }
      }

      $bodyText = ''
      if ($contentLength -gt 0) {
        $byteBuffer = New-Object byte[] $contentLength
        $readCount = 0
        while ($readCount -lt $contentLength) {
          $current = $stream.Read($byteBuffer, $readCount, $contentLength - $readCount)
          if ($current -le 0) { break }
          $readCount += $current
        }
        if ($readCount -gt 0) {
          $bodyText = [System.Text.Encoding]::UTF8.GetString($byteBuffer, 0, $readCount)
        }
      }

      if ($pathOnly -eq '/__shaker__/config') {
        Write-JsonResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Payload @{ managed = $true; fileBacked = $true; storagePath = 'data/storage.json'; clientCount = $script:RegisteredClients.Count }
      } elseif ($pathOnly -eq '/__shaker__/storage' -and $method -eq 'GET') {
        $snapshot = Get-StorageSnapshot -ProjectRoot $projectRoot
        Write-JsonResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Payload @{ ok = $true; fileBacked = $true; storage = $snapshot }
      } elseif ($pathOnly -eq '/__shaker__/storage' -and $method -eq 'POST') {
        $parsed = if ([string]::IsNullOrWhiteSpace($bodyText)) { @{} } else { $bodyText | ConvertFrom-Json }
        $storage = ConvertTo-Hashtable $parsed.storage
        if ($null -eq $storage) { $storage = @{} }
        Save-StorageSnapshot -ProjectRoot $projectRoot -Storage $storage
        Write-JsonResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Payload @{ ok = $true; fileBacked = $true; storage = $storage }
      } elseif ($pathOnly -eq '/__shaker__/register' -and $method -eq 'POST') {
        $clientId = Get-ClientId -Query $query
        if (-not [string]::IsNullOrWhiteSpace($clientId)) { [void]$script:RegisteredClients.Add($clientId) }
        $script:IdleShutdownDeadline = $null
        Write-JsonResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Payload @{ ok = $true; managed = $true; clientCount = $script:RegisteredClients.Count }
      } elseif ($pathOnly -eq '/__shaker__/release' -and $method -eq 'POST') {
        $clientId = Get-ClientId -Query $query
        if (-not [string]::IsNullOrWhiteSpace($clientId)) { [void]$script:RegisteredClients.Remove($clientId) }
        $shutdownScheduled = (-not $script:ShutdownRequested) -and ($script:RegisteredClients.Count -le 0)
        if ($shutdownScheduled) {
          $script:IdleShutdownDeadline = [DateTime]::UtcNow.AddSeconds($idleShutdownSeconds)
        } else {
          $script:IdleShutdownDeadline = $null
        }
        Write-JsonResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Payload @{ ok = $true; managed = $true; clientCount = $script:RegisteredClients.Count; stopping = $shutdownScheduled; shutdownDelaySeconds = $idleShutdownSeconds }
      } elseif ($pathOnly -eq '/__shaker__/shutdown' -and $method -eq 'POST') {
        $script:ShutdownRequested = $true
        $script:IdleShutdownDeadline = $null
        $script:ShouldStop = $true
        Write-JsonResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Payload @{ ok = $true; managed = $true; stopped = $true }
      } else {
        $filePath = Normalize-LocalPath -ProjectRoot $projectRoot -RequestPath $pathOnly
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        Write-HttpResponse -Stream $stream -StatusCode 200 -StatusText 'OK' -Body $bytes -ContentType (Get-ContentType -Path $filePath)
      }

      $stream.Dispose()
    } catch {
      try {
        if ($client.Connected) {
          $stream = $client.GetStream()
          $errorBytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @{ ok = $false; error = $_.Exception.Message }))
          Write-HttpResponse -Stream $stream -StatusCode 500 -StatusText 'Server Error' -Body $errorBytes -ContentType 'application/json; charset=utf-8'
          $stream.Dispose()
        }
      } catch {}
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}




