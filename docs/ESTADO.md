# Estado del proyecto

Actualizado: 2026-11-18

## Fuentes activas

- App Android: `app/src/` y el proyecto Capacitor `app/android/`.
- El ID de la app es `com.mario.barco`.
- Firmware Arduino Uno: `firmware/arduino/barco_control.ino`.
- Pruebas del firmware: `firmware/tests/`; guía: `docs/GUIA_FIRMWARE.md`.
- Documentación para usuarios y colaboradores: `README.md` y `AGENTS.md`.

## Automatizaciones

- `scripts/actualizar-app-android.cmd` o `npm run deploy:android` compila, instala y abre el APK de depuración en un teléfono conectado.
- `npm run watch:android` genera un APK al inicio y al detectar cambios en `app/src/`, sin instalarlo.
- `scripts/cargar-firmware.cmd` lista `.ino` de la carpeta configurada, compila el seleccionado y exige confirmación antes de cargarlo.
- `scripts/patch-bluetooth-gradle.mjs` adapta el plugin Bluetooth a la configuración ProGuard que requiere el Gradle actual.
- `.github/workflows/android-release.yml` compila y publica el APK firmado y un ZIP del sketch en Releases cuando se sube una etiqueta `v*`; necesita secretos de firma en GitHub Actions.
