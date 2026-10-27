param(
  [int]$DebounceMilliseconds = 900
)

$ErrorActionPreference = 'Stop'
$projectPaths = Join-Path $PSScriptRoot 'project-paths.ps1'
. $projectPaths
$androidProject = Get-AndroidProject
$projectRoot = $androidProject.AppRoot
$sourceRoot = Join-Path $projectRoot 'src'
$androidRoot = $androidProject.AndroidRoot
$gradleWrapper = $androidProject.GradleWrapper

foreach ($requiredPath in @($sourceRoot, $androidRoot, $gradleWrapper)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "No se encontró el elemento requerido: $requiredPath"
  }
}

function Invoke-AndroidBuild {
  Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Compilando la app web..." -ForegroundColor Cyan
  Push-Location $projectRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build terminó con código $LASTEXITCODE" }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Sincronizando Capacitor con Android..." -ForegroundColor Cyan
    & npx.cmd cap sync android
    if ($LASTEXITCODE -ne 0) { throw "npx cap sync android terminó con código $LASTEXITCODE" }

    Write-Host "Preparando compatibilidad del plugin Bluetooth..." -ForegroundColor Cyan
    & node.exe (Join-Path $PSScriptRoot 'patch-bluetooth-gradle.mjs')
    if ($LASTEXITCODE -ne 0) { throw "La preparación del plugin Bluetooth terminó con código $LASTEXITCODE" }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Generando APK de depuración..." -ForegroundColor Cyan
    & $gradleWrapper -p $androidRoot assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle terminó con código $LASTEXITCODE" }

    $apkPath = Get-DebugApk -AndroidRoot $androidRoot
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] APK listo: $apkPath" -ForegroundColor Green
  }
  finally {
    Pop-Location
  }
}

$watcher = [System.IO.FileSystemWatcher]::new($sourceRoot, '*')
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'
$watcher.EnableRaisingEvents = $true

Write-Host "Observando cambios en: $sourceRoot" -ForegroundColor Yellow
Write-Host 'Se generará el APK de depuración. Ctrl+C para detener.'

try {
  Invoke-AndroidBuild

  while ($true) {
    $change = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, -1)
    if ($change.TimedOut) { continue }

    # Agrupa las escrituras rápidas del editor en una sola compilación.
    do {
      $change = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, $DebounceMilliseconds)
    } while (-not $change.TimedOut)

    try {
      Invoke-AndroidBuild
    }
    catch {
      Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Falló la compilación: $_" -ForegroundColor Red
      Write-Host 'El observador sigue activo y volverá a compilar al detectar otro cambio.' -ForegroundColor Yellow
    }
  }
}
finally {
  $watcher.Dispose()
}

