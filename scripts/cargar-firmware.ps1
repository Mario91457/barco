param(
  [string]$Port
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'project-paths.ps1')

# Cambia esta constante para listar los .ino de otra carpeta de firmwares.
Set-Variable -Name FirmwareFolder -Option Constant -Scope Script -Value 'firmware\arduino'
$firmwarePath = Join-Path $script:BarcoProjectRoot $script:FirmwareFolder
$fqbn = 'arduino:avr:uno'

if (-not (Get-Command arduino-cli -ErrorAction SilentlyContinue)) {
  throw 'No encontré arduino-cli. Instala Arduino CLI y vuelve a ejecutar este acceso.'
}

if (-not (Test-Path -LiteralPath $firmwarePath -PathType Container)) {
  throw "No existe la carpeta de firmwares configurada: '$firmwarePath'. Revisa la constante FirmwareFolder en scripts/cargar-firmware.ps1."
}

try {
  $sketches = @(Get-ChildItem -LiteralPath $firmwarePath -File -Filter '*.ino' -ErrorAction Stop |
    Sort-Object -Property Name)
}
catch {
  throw "No pude buscar archivos .ino en '$firmwarePath': $($_.Exception.Message)"
}

if ($sketches.Count -eq 0) {
  throw "No hay archivos .ino compatibles en '$firmwarePath'. Añade allí un sketch y vuelve a intentarlo."
}

Write-Host 'Firmwares disponibles:' -ForegroundColor Cyan
for ($i = 0; $i -lt $sketches.Count; $i++) {
  Write-Host "$($i + 1). $($sketches[$i].Name)"
}

$seleccionTexto = Read-Host 'Escribe el número del firmware que quieres cargar'
$seleccion = 0
if (-not [int]::TryParse($seleccionTexto, [ref]$seleccion) -or
    $seleccion -lt 1 -or $seleccion -gt $sketches.Count) {
  throw "Selección '$seleccionTexto' no válida. Elige un número entre 1 y $($sketches.Count)."
}
$seleccionado = $sketches[$seleccion - 1]
Write-Host "`nFirmware seleccionado para compilar y cargar: $($seleccionado.Name)" -ForegroundColor Green
Write-Host "Archivo de origen: $($seleccionado.FullName)"

# Arduino compila una carpeta de sketch. Se prepara una copia temporal con solo el .ino
# elegido y sus archivos auxiliares, sin mezclar otros sketches de la carpeta configurable.
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("barco-firmware-" + [guid]::NewGuid().ToString('N'))
$sketchPath = Join-Path $tempRoot $seleccionado.BaseName
try {
  New-Item -ItemType Directory -Path $sketchPath -Force | Out-Null
  Get-ChildItem -LiteralPath $seleccionado.DirectoryName -File -ErrorAction Stop |
    Where-Object { $_.Extension -ne '.ino' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $sketchPath -ErrorAction Stop }
  Copy-Item -LiteralPath $seleccionado.FullName -Destination (Join-Path $sketchPath ($seleccionado.BaseName + '.ino')) -ErrorAction Stop

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
      $portText = Read-Host 'Elige el puerto de la placa Arduino'
      $portSelection = 0
      if (-not [int]::TryParse($portText, [ref]$portSelection) -or
          $portSelection -lt 1 -or $portSelection -gt $usbPorts.Count) {
        throw "Selección de puerto '$portText' no válida."
      }
      $Port = $usbPorts[$portSelection - 1]
    }
    else {
      $Port = Read-Host 'Escribe el puerto de la placa (por ejemplo COM3)'
    }
  }

  if ($Port -notmatch '^COM\d+$') { throw "Puerto '$Port' no válido. Usa un puerto como COM3." }

  Write-Host "Compilando '$($seleccionado.Name)' para Arduino Uno en $Port..." -ForegroundColor Cyan
  & arduino-cli compile --fqbn $fqbn $sketchPath
  if ($LASTEXITCODE -ne 0) { throw "La compilación falló para '$($seleccionado.Name)' (código $LASTEXITCODE)." }

  Write-Host "`nSe cargará: $($seleccionado.Name)" -ForegroundColor Green
  Write-Host 'SEGURIDAD: retira la hélice antes de energizar el barco.' -ForegroundColor Yellow
  $confirmation = Read-Host 'Escribe SI para cargar este firmware'
  if ($confirmation -cne 'SI') {
    Write-Host 'Carga cancelada; la placa no fue modificada.' -ForegroundColor Yellow
    exit 0
  }

  Write-Host "Cargando '$($seleccionado.Name)' en $Port..." -ForegroundColor Cyan
  & arduino-cli upload --fqbn $fqbn --port $Port $sketchPath
  if ($LASTEXITCODE -ne 0) { throw "La carga de '$($seleccionado.Name)' falló (código $LASTEXITCODE)." }
  Write-Host "Firmware '$($seleccionado.Name)' cargado correctamente en $Port." -ForegroundColor Green
}
catch {
  throw "No se pudo cargar '$($seleccionado.Name)': $($_.Exception.Message)"
}
finally {
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $tempFull = [IO.Path]::GetFullPath($tempRoot)
  if ($tempFull.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $tempFull -PathType Container)) {
    Remove-Item -LiteralPath $tempFull -Recurse -Force -ErrorAction SilentlyContinue
  }
}
