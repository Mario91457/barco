# Compilar la app Android

Esta guía explica cómo generar una APK de prueba desde el código del proyecto. Para instalar una APK descargada de Releases mediante ADB, consulta el [README principal](../README.md).

## Requisitos

- Node.js 22 y npm.
- JDK 17 o posterior.
- Android SDK instalado y configurado.

## Generar una APK de prueba en Windows

Abre PowerShell en la carpeta del proyecto y ejecuta:

```powershell
cd app
npm ci
npm run build
npx cap sync android
node ..\scripts\patch-bluetooth-gradle.mjs
.\android\gradlew.bat -p .\android assembleDebug
```

La APK queda en `app/android/app/build/outputs/apk/debug/app-debug.apk`.

La app web se edita en `app/src/`. La carpeta `app/www/` se genera al compilar; no edites esos archivos directamente. El paso `patch-bluetooth-gradle.mjs` ajusta el plugin Bluetooth para el Gradle del proyecto.

## Scripts de desarrollo

- `npm run deploy:android`: compila la APK de depuración, la instala en un teléfono conectado y la abre. Acepta `-Serial` mediante el script PowerShell si hay varios dispositivos. Como usa el mismo ID `com.mario.barco` con una firma de depuración, no puede actualizar una APK de Releases firmada con otra clave; Android puede pedir desinstalarla primero, lo que borra sus datos.
- `npm run watch:android`: compila una APK de depuración al iniciar y vuelve a generarla cuando cambian archivos de `app/src/`; no instala la APK.
- `node ..\scripts\patch-bluetooth-gradle.mjs`: aplica la configuración ProGuard que necesita el plugin Bluetooth. Se puede ejecutar más de una vez.
