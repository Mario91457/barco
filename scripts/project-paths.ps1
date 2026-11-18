$script:BarcoProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-AndroidProject {
  $wrappers = @(Get-ChildItem -LiteralPath $script:BarcoProjectRoot -Recurse -File -Filter 'gradlew.bat' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '[\\/](\.gradle|build|node_modules|docs)[\\/]' })

  $projects = @(
    foreach ($wrapper in $wrappers) {
      $gradleRoot = $wrapper.Directory.FullName
      $appRoot = Split-Path -Parent $gradleRoot
      $required = @('package.json', 'capacitor.config.json', 'src\index.html')
      if (@($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $appRoot $_)) }).Count -eq 0) {
        [pscustomobject]@{ AppRoot = $appRoot; AndroidRoot = $gradleRoot; GradleWrapper = $wrapper.FullName }
      }
    }
  )

  if ($projects.Count -ne 1) {
    throw "Se esperaba encontrar una sola app Capacitor con Gradle dentro de '$script:BarcoProjectRoot'; encontré $($projects.Count)."
  }
  return $projects[0]
}

function Get-DebugApk {
  param([Parameter(Mandatory)][string]$AndroidRoot)

  $apks = @(Get-ChildItem -LiteralPath $AndroidRoot -Recurse -File -Filter '*.apk' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]outputs[\\/]apk[\\/]debug[\\/]' })
  if ($apks.Count -ne 1) {
    throw "Se esperaba un solo APK de depuración bajo '$AndroidRoot'; encontré $($apks.Count)."
  }
  return $apks[0].FullName
}

function Get-AndroidSdkRoot {
  param([Parameter(Mandatory)][string]$AndroidRoot)

  if ($env:ANDROID_SDK_ROOT) { return $env:ANDROID_SDK_ROOT }
  if ($env:ANDROID_HOME) { return $env:ANDROID_HOME }

  $localProperties = Join-Path $AndroidRoot 'local.properties'
  if (Test-Path -LiteralPath $localProperties) {
    $sdkLine = Get-Content -LiteralPath $localProperties | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
    if ($sdkLine) {
      return (($sdkLine -replace '^sdk\.dir=', '').Replace('\\', '\').Replace('\:', ':'))
    }
  }

  if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'Android\Sdk') }
  throw 'No encontré la ruta del Android SDK. Define ANDROID_SDK_ROOT.'
}

function Get-ActiveFirmwareSketch {
  $sketches = @(Get-ChildItem -LiteralPath $script:BarcoProjectRoot -Recurse -File -Filter '*.ino' -ErrorAction SilentlyContinue |
    Where-Object {
      $source = Get-Content -LiteralPath $_.FullName -Raw
      $source -match '#include\s*<NeoSWSerial\.h>' -and $source -match 'PIN_ESC'
    })

  if ($sketches.Count -ne 1) {
    throw "Se esperaba un único sketch Arduino fuera de pruebas y ejemplos; encontré $($sketches.Count)."
  }
  if ($sketches[0].BaseName -ne $sketches[0].Directory.Name) {
    throw "Arduino requiere que el archivo y su carpeta coincidan: '$($sketches[0].FullName)'."
  }
  return $sketches[0]
}
