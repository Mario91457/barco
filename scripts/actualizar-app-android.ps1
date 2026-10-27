param(
  [string]$Serial
)

$ErrorActionPreference = 'Stop'
$projectPaths = Join-Path $PSScriptRoot 'project-paths.ps1'
. $projectPaths
$androidProject = Get-AndroidProject
$appRoot = $androidProject.AppRoot
$androidRoot = $androidProject.AndroidRoot
$apkPath = $null
$capacitorConfig = Get-Content -LiteralPath (Join-Path $appRoot 'capacitor.config.json') -Raw | ConvertFrom-Json
$packageId = $capacitorConfig.appId
if (-not $packageId) { throw 'No encontré appId en capacitor.config.json.' }

function Invoke-CheckedCommand {
  param([string]$Name, [string[]]$Arguments)
  & $Name @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Name terminó con código $LASTEXITCODE" }
}

$sdkRoot = Get-AndroidSdkRoot -AndroidRoot $androidRoot
$adb = Join-Path $sdkRoot 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw "No encontré adb en '$adb'. Revisa el Android SDK." }

$javaExecutable = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { $null }
if ($javaExecutable -and (Test-Path -LiteralPath $javaExecutable)) {
  $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
}
$javaCommand = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCommand) { throw 'No encontré Java. Configura JAVA_HOME con un JDK 17 o superior.' }
$javaInfo = [System.Diagnostics.ProcessStartInfo]::new()
$javaInfo.FileName = $javaCommand.Source
$javaInfo.Arguments = '-version'
$javaInfo.UseShellExecute = $false
$javaInfo.RedirectStandardOutput = $true
$javaInfo.RedirectStandardError = $true
$javaProcess = [System.Diagnostics.Process]::Start($javaInfo)
$javaStdout = $javaProcess.StandardOutput.ReadToEnd()
$javaStderr = $javaProcess.StandardError.ReadToEnd()
$javaProcess.WaitForExit()
if ($javaProcess.ExitCode -ne 0) { throw 'No pude consultar Java. Configura JAVA_HOME con un JDK 17 o superior.' }
$javaVersion = $javaStdout + $javaStderr
if ($javaVersion -notmatch 'version "(?:1\.(\d+)|(\d+))') { throw 'No pude determinar la versión de Java. Configura JAVA_HOME con un JDK 17 o superior.' }
$javaMajor = if ($Matches[1]) { [int]$Matches[1] } else { [int]$Matches[2] }
if ($javaMajor -lt 17) { throw "Java $javaMajor no sirve para este proyecto Android. Configura JAVA_HOME con un JDK 17 o superior." }

Push-Location $appRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\vite\bin\vite.js'))) {
    Write-Host 'Instalando dependencias de la app (solo hace falta en la primera ejecución)...' -ForegroundColor Cyan
    Invoke-CheckedCommand 'npm.cmd' @('install')
  }

  Write-Host 'Compilando la app web...' -ForegroundColor Cyan
  Invoke-CheckedCommand 'npm.cmd' @('run', 'build')
  Write-Host 'Sincronizando Capacitor con Android...' -ForegroundColor Cyan
  Invoke-CheckedCommand 'npx.cmd' @('cap', 'sync', 'android')
  Write-Host 'Preparando la compatibilidad del plugin Bluetooth...' -ForegroundColor Cyan
  Invoke-CheckedCommand 'node.exe' @((Join-Path $PSScriptRoot 'patch-bluetooth-gradle.mjs'))
  Write-Host 'Generando APK de depuración...' -ForegroundColor Cyan
  Invoke-CheckedCommand (Join-Path $androidRoot 'gradlew.bat') @('-p', $androidRoot, 'assembleDebug')
}
finally {
  Pop-Location
}

$apkPath = Get-DebugApk -AndroidRoot $androidRoot

Write-Host "`nConecta el teléfono por USB, activa Depuración USB y acepta la autorización en Android." -ForegroundColor Yellow
$devices = @()
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  $deviceLines = & $adb devices
  if ($LASTEXITCODE -ne 0) { throw 'adb no pudo enumerar dispositivos.' }
  $devices = @($deviceLines | Select-Object -Skip 1 | ForEach-Object {
    $parts = $_.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq 'device') { $parts[0] }
  } | Where-Object { $_ })

  $unauthorized = @($deviceLines | Where-Object { $_ -match '\sunauthorized$' })
  if ($unauthorized.Count -gt 0) {
    Write-Host 'Acepta el aviso de depuración USB en la pantalla del teléfono.' -ForegroundColor Yellow
  }
  if ($devices.Count -gt 0) { break }
  if ($attempt -eq 0) { Write-Host 'Esperando a que Android aparezca en adb...' -ForegroundColor Yellow }
  Start-Sleep -Seconds 1
}

if ($devices.Count -eq 0) { throw 'No apareció ningún teléfono autorizado en 60 segundos.' }
if ($Serial) {
  if ($Serial -notin $devices) { throw "El dispositivo '$Serial' no está conectado o no está autorizado." }
}
elseif ($devices.Count -eq 1) {
  $Serial = $devices[0]
}
else {
  Write-Host 'Hay varios dispositivos conectados:'
  for ($i = 0; $i -lt $devices.Count; $i++) { Write-Host "[$($i + 1)] $($devices[$i])" }
  $selection = [int](Read-Host 'Elige el número del teléfono')
  if ($selection -lt 1 -or $selection -gt $devices.Count) { throw 'Selección de dispositivo no válida.' }
  $Serial = $devices[$selection - 1]
}

Write-Host "Instalando en $Serial..." -ForegroundColor Cyan
Invoke-CheckedCommand $adb @('-s', $Serial, 'install', '-r', '-d', $apkPath)
Invoke-CheckedCommand $adb @('-s', $Serial, 'shell', 'am', 'force-stop', $packageId)
Invoke-CheckedCommand $adb @('-s', $Serial, 'shell', 'monkey', '-p', $packageId, '-c', 'android.intent.category.LAUNCHER', '1')
Write-Host "App actualizada y abierta en $Serial." -ForegroundColor Green


