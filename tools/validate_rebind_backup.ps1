param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Path
)

$ErrorActionPreference = "Stop"

function Require-BackupCondition([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Backup validation failed: $Message" }
}

function Convert-ReportHex([string]$HexText, [string]$Context) {
  $compactHex = $HexText -replace '\s', ''
  Require-BackupCondition ($compactHex -match '^(?:[0-9a-fA-F]{2}){64}$') `
    "$Context must be exactly 64 HID data bytes encoded as 128 hex digits (spaces are allowed)"
  $bytes = [byte[]]::new(64)
  for ($i = 0; $i -lt 64; $i++) {
    $bytes[$i] = [Convert]::ToByte($compactHex.Substring($i * 2, 2), 16)
  }
  return ,$bytes
}

try {
  $resolved = Resolve-Path -LiteralPath $Path
  $document = Get-Content -LiteralPath $resolved.Path -Raw | ConvertFrom-Json -AsHashtable
  Require-BackupCondition ($document -is [System.Collections.IDictionary]) "root JSON must be an object"
  Require-BackupCondition ($document.layers.Count -eq 3) "editor profile must contain three layers"

  $backup = $document.deviceBackup
  Require-BackupCondition ($backup -is [System.Collections.IDictionary]) "deviceBackup object is missing"
  Require-BackupCondition ($backup.format -eq "macropad-rebind-device-backup") "unknown backup format"
  Require-BackupCondition ($backup.version -eq 1) "unsupported backup version"
  Require-BackupCondition ($backup.protocol -eq "ch57x-3") "protocol must be ch57x-3"
  Require-BackupCondition ($backup.device.vendorId -eq 0x514C -and $backup.device.productId -eq 0x8850) `
    "backup device must be USB 514C:8850"
  Require-BackupCondition ($backup.layout.keys -eq 16 -and $backup.layout.knobs -eq 3 -and
    $backup.layout.slotsPerLayer -eq 25 -and $backup.layout.layers -eq 3) `
    "layout must describe 16 keys, 3 encoders, 25 slots, and 3 layers"
  Require-BackupCondition ($backup.slotMap.keys.first -eq 1 -and $backup.slotMap.keys.last -eq 16 -and
    $backup.slotMap.keys.order -in @("column-major-bottom-to-top", "row-major") -and $backup.slotMap.encoders.first -eq 17 -and
    $backup.slotMap.encoders.count -eq 3 -and
    (@($backup.slotMap.encoders.actions) -join ",") -eq "ccw,press,cw") `
    "slot map metadata is incomplete or inconsistent"
  Require-BackupCondition ($backup.coverage.expectedReplies -eq 75 -and
    $backup.coverage.receivedReplies -eq 75) "coverage metadata must report 75 replies"
  Require-BackupCondition (@($backup.bindings).Count -eq 3) "decoded backup must contain three binding maps"
  Require-BackupCondition (@($backup.queryReports).Count -eq 3) "expected three layer query reports"
  Require-BackupCondition (@($backup.responseReports).Count -eq 75) "expected 75 raw reply reports"

  $queryLayers = @{}
  foreach ($query in $backup.queryReports) {
    $layer = [int]$query.layer
    Require-BackupCondition ($query.reportId -eq 3 -and $layer -ge 1 -and $layer -le 3) `
      "query report must use report ID 3 and layer 1, 2, or 3"
    Require-BackupCondition (-not $queryLayers.ContainsKey($layer)) "duplicate query for layer $layer"
    $queryLayers[$layer] = $true
    $data = Convert-ReportHex $query.dataHex "layer $layer query"
    Require-BackupCondition ($data[0] -eq 0xFA -and $data[1] -eq 25 -and
      $data[2] -eq 0 -and $data[3] -eq $layer -and $data[4] -eq 0) `
      "layer $layer query header does not match the captured XZKJ read"
    Require-BackupCondition (@($data[5..63] | Where-Object { $_ -ne 0 }).Count -eq 0) `
      "layer $layer query tail is expected to be zero-padded by this app"
  }

  $seen = @{}
  $types = @{}
  $boundCount = 0
  $macroCount = 0
  foreach ($record in $backup.responseReports) {
    $layer = [int]$record.layer
    $slot = [int]$record.slot
    Require-BackupCondition ($record.reportId -eq 3 -and $layer -ge 1 -and $layer -le 3 -and
      $slot -ge 1 -and $slot -le 25) "reply metadata has an invalid report ID, layer, or slot"
    $key = "$layer`:$slot"
    Require-BackupCondition (-not $seen.ContainsKey($key)) "duplicate reply for layer $layer slot $slot"
    $seen[$key] = $true

    $data = Convert-ReportHex $record.dataHex "layer $layer slot $slot reply"
    Require-BackupCondition ($data[0] -eq 0xFA -and $data[1] -eq $slot -and $data[2] -eq $layer) `
      "layer $layer slot $slot reply bytes disagree with their metadata"
    $type = [int]$data[3]
    $typeKey = [string]$type
    if (-not $types.ContainsKey($typeKey)) { $types[$typeKey] = 0 }
    $types[$typeKey]++

    $isEmpty = $type -eq 0
    if ($type -eq 1) {
      $count = [int]$data[5]
      if ($count -eq 0) { $isEmpty = $true }
      elseif ($count -gt 18) { $isEmpty = $false } # the app preserves over-limit entries as raw
      else {
        $isEmpty = $true
        for ($i = 0; $i -lt $count; $i++) {
          $at = 6 + (3 * $i)
          if ($data[$at] -ne 0 -or $data[$at + 1] -ne 0 -or $data[$at + 2] -ne 0) {
            $isEmpty = $false
            break
          }
        }
      }
      if ($count -gt 1) { $macroCount++ }
    }

    $bindingMap = $backup.bindings[$layer - 1]
    $slotKey = [string]$slot
    $hasBinding = $bindingMap.Contains($slotKey)
    Require-BackupCondition ($hasBinding -eq (-not $isEmpty)) `
      "decoded layer $layer slot $slot presence disagrees with its raw record"
    if ($hasBinding) {
      $raw = @($bindingMap[$slotKey]._raw)
      Require-BackupCondition ($raw.Count -eq 64) "layer $layer slot $slot decoded binding lacks its raw record"
      for ($i = 0; $i -lt 64; $i++) {
        Require-BackupCondition ([int]$raw[$i] -eq [int]$data[$i]) `
          "layer $layer slot $slot decoded raw bytes differ from the captured reply"
      }
      $boundCount++
    }
  }

  Require-BackupCondition ($seen.Count -eq 75) "only $($seen.Count) unique layer/slot replies were found"
  foreach ($layer in 1..3) {
    foreach ($slot in 1..25) {
      Require-BackupCondition ($seen.ContainsKey("$layer`:$slot")) "missing layer $layer slot $slot reply"
    }
  }

  [pscustomobject]@{
    valid = $true
    capturedAt = $backup.capturedAt
    device = "514C:8850"
    protocol = "ch57x-3"
    layers = 3
    slotsPerLayer = 25
    rawReplies = $seen.Count
    boundSlots = $boundCount
    recordTypes = $types
    keyboardSequencesWithMultipleEntries = $macroCount
    includesGlobalSettings = $false
  } | ConvertTo-Json -Depth 5
  exit 0
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
