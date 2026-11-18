# Guía técnica de compilación y publicación

Esta guía es para quienes mantienen el proyecto. La guía de instalación para participantes está en [`README.md`](../README.md).

## App Android en una computadora

Requisitos: Node.js 22, npm, JDK 17 o superior y Android SDK. El proyecto Android usa Gradle Wrapper y compila para SDK 36.

Desde PowerShell:

```powershell
cd app
npm ci
npm run build
npx cap sync android
node ..\scripts\patch-bluetooth-gradle.mjs
.\android\gradlew.bat -p .\android assembleDebug
```

El APK de depuración queda en `app/android/app/build/outputs/apk/debug/app-debug.apk`. Para instalarlo y abrirlo en un teléfono por USB, usa `npm run deploy:android`; para observar cambios de `app/src/` y reconstruir automáticamente, usa `npm run watch:android`.

La app web se edita en `app/src/`; `app/www/` es salida generada. El plugin Bluetooth necesita la corrección ProGuard que aplica `scripts/patch-bluetooth-gradle.mjs` después de `npm ci` y antes de compilar Android.

## APK de Releases con GitHub Actions

El flujo `.github/workflows/android-release.yml` se ejecuta al subir una etiqueta que empiece con `v`, por ejemplo `v1.0.0`. Compila la app web, sincroniza Capacitor, compila el APK Android firmado y crea un GitHub Release con `Barco-v1.0.0.apk` y `Barco-Firmware-v1.0.0.zip` (la carpeta de sketch lista para abrir). La app conserva el ID de prueba `com.mario.barco.test`; no reemplaza una app instalada con otro ID. El flujo no carga firmware en una placa.

### Preparar una vez la firma

La clave de firma debe mantenerse igual entre versiones para que Android permita actualizar una instalación existente. No guardes el keystore ni sus contraseñas en el repositorio.

1. En una computadora con JDK, crea un keystore de publicación y guarda el archivo fuera del repositorio:

   ```powershell
   keytool -genkeypair -v -keystore barco-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias barco
   ```

2. En GitHub abre **Settings → Secrets and variables → Actions** y crea estos secretos del repositorio:
   - `BARCO_KEYSTORE_BASE64`: contenido Base64 del archivo `barco-release.jks`.
   - `BARCO_KEYSTORE_PASSWORD`: contraseña del keystore.
   - `BARCO_KEY_ALIAS`: el alias usado al crearlo (en el ejemplo, `barco`).
   - `BARCO_KEY_PASSWORD`: contraseña de la clave.

   Para obtener el Base64 en PowerShell sin imprimir el contenido del keystore:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('.\barco-release.jks')) | Set-Clipboard
   ```

   Pega el resultado directamente en el formulario del secreto `BARCO_KEYSTORE_BASE64`. No lo pegues en el código, en un issue ni en este documento.

Si instalaste antes un APK de depuración de `com.mario.barco.test`, desinstálalo antes de instalar el primer APK firmado de Releases. A partir de esa primera versión, conserva el mismo keystore para que Android acepte las actualizaciones.

### Publicar una versión

Integra los cambios revisados en la rama principal. Luego crea y sube una etiqueta desde PowerShell:

```powershell
git switch main
git pull
git tag -a v1.0.0 -m "Barco RC v1.0.0"
git push origin v1.0.0
```

Usa un número nuevo para cada versión. La acción aparece en **Actions**; al terminar, abre **Releases** y confirma que incluya el APK y el ZIP del sketch. La versión de Android toma el nombre de la etiqueta y un código creciente del número de ejecución. La acción necesita `contents: write` para crear el Release ([permisos del workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)); limita ese permiso al flujo de etiquetas. El comando que adjunta los archivos es `gh release create` ([manual](https://cli.github.com/manual/gh_release_create)).

Si la acción falla, abre **Actions**, entra a la ejecución y revisa el paso rojo. Los secretos de firma son obligatorios. No vuelvas a usar una etiqueta publicada para otro APK; crea una etiqueta nueva.

## Qué hace cada script

| Archivo | Función |
| --- | --- |
| `scripts/actualizar-app-android.cmd` | Acceso de Windows que inicia el script PowerShell de despliegue. |
| `scripts/actualizar-app-android.ps1` | Comprueba Java/SDK, instala dependencias si faltan, compila la web, sincroniza Capacitor, adapta el plugin, compila el APK de depuración, encuentra el teléfono, instala la app de prueba y la abre. Acepta `-Serial` para elegir dispositivo. |
| `scripts/watch-android-build.ps1` | Compila APK de depuración al iniciar y después de cambios en `app/src/`; agrupa escrituras rápidas y deja el APK en disco. No instala el APK. |
| `scripts/cargar-firmware.cmd` | Acceso de Windows al cargador del firmware. |
| `scripts/cargar-firmware.ps1` | Busca `.ino` en `FirmwareFolder`, lista opciones, valida la selección, prepara una copia temporal aislada, solicita puerto si hace falta, compila para Uno y pide `SI` antes de cargar. Acepta `-Port COMx`. |
| `scripts/project-paths.ps1` | Encuentra la app Capacitor, Gradle Wrapper, SDK Android y sketch activo para los otros scripts. |
| `scripts/patch-bluetooth-gradle.mjs` | Cambia en la dependencia instalada el archivo ProGuard antiguo por el optimizado que acepta Gradle actual. Se puede ejecutar repetidamente. |

La carpeta de firmwares que lista el cargador se configura en la constante `FirmwareFolder` de `scripts/cargar-firmware.ps1`. El valor actual es `firmware\arduino\barco_control`.

## Validación local del firmware

La prueba del protocolo corre en PC con Bash, `g++`, Node.js y mocks:

```bash
bash firmware/arduino/tests/host_protocolo/run.sh
```

Después compila para Uno con Arduino CLI y ejecuta una prueba de banco sin hélice. Un resultado en PC no demuestra el comportamiento del ESC, la lectura física del MPU ni el failsafe real. Sigue [`GUIA_FIRMWARE.md`](GUIA_FIRMWARE.md) y las restricciones de [`AGENTS.md`](../AGENTS.md).
