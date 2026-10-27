param(
  [string]$Port
)

$ErrorActionPreference = 'Stop'
$projectPaths = Join-Path $PSScriptRoot 'project-paths.ps1'
. $projectPaths
$sketch = Get-ActiveFirmwareSketch
$fqbn = 'arduino:avr:uno'

if (-not (Get-Command arduino-cli -ErrorAction SilentlyContinue)) {
  throw 'No encontré arduino-cli. Instala Arduino CLI y vuelve a ejecutar este acceso.'
}
if (-not $Port) {
  $usbPorts = @()
  try {
    $usbPorts = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop |
      Where-Object { $_.PNPDeviceID -like 'USB*' -and $_.Name -match '\((COM\d+)\)' } |
      ForEach-Object { [regex]::Match($_.Name, '\((COM\d+)\)').Groups[1].Value } |
      Sort-Object -Unique)
  }
  catch {
    Write-Host 'No pude detectar los puertos USB automáticamente.' -ForegroundColor Yellow
  }

  if ($usbPorts.Count -eq 1) {
    $Port = $usbPorts[0]
  }
  elseif ($usbPorts.Count -gt 1) {
    Write-Host 'Detecté varios puertos USB:'
    for ($i = 0; $i -lt $usbPorts.Count; $i++) { Write-Host "[$($i + 1)] $($usbPorts[$i])" }
    $selection = [int](Read-Host 'Elige el puerto de la placa Arduino')
    if ($selection -lt 1 -or $selection -gt $usbPorts.Count) { throw 'Selección de puerto no válida.' }
    $Port = $usbPorts[$selection - 1]
  }
  else {
    $Port = Read-Host 'Escribe el puerto de la placa (por ejemplo COM3)'
  }
}

if ($Port -notmatch '^COM\d+$') { throw "Puerto '$Port' no válido. Usa un puerto como COM3." }

Write-Host "Compilando firmware para Arduino Uno en $Port..." -ForegroundColor Cyan
$sketchPath = $sketch.Directory.FullName
& arduino-cli compile --fqbn $fqbn $sketchPath
if ($LASTEXITCODE -ne 0) { throw "La compilación del firmware falló (código $LASTEXITCODE)." }

Write-Host "`nSEGURIDAD: retira la hélice antes de energizar el barco. Confirma que está retirada para cargar el firmware." -ForegroundColor Yellow
$confirmation = Read-Host 'Escribe SI para continuar con la carga'
if ($confirmation -cne 'SI') { Write-Host 'Carga cancelada; la placa no fue modificada.' -ForegroundColor Yellow; exit 0 }

Write-Host "Cargando firmware en $Port..." -ForegroundColor Cyan
& arduino-cli upload --fqbn $fqbn --port $Port $sketchPath
if ($LASTEXITCODE -ne 0) { throw "La carga del firmware falló (código $LASTEXITCODE)." }
Write-Host "Firmware cargado correctamente en $Port." -ForegroundColor Green
