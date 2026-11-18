# Estado del proyecto

Actualizado: 2026-11-17

## Fuentes activas

- App Android: `app/src/` y el proyecto Capacitor `app/android/`.
- El ID de la instalación de prueba es `com.mario.barco.test`.
- Firmware Arduino Uno: `firmware/arduino/barco_control/barco_control.ino`.
- Pruebas del firmware: `firmware/arduino/tests/`; guía: `docs/GUIA_FIRMWARE.md`.
- Documentación para usuarios y colaboradores: `README.md` y `AGENTS.md`.

## Automatizaciones

- `scripts/actualizar-app-android.cmd` o `npm run deploy:android` compila, instala y abre el APK de depuración en un teléfono conectado.
- `npm run watch:android` genera un APK al inicio y al detectar cambios en `app/src/`, sin instalarlo.
- `scripts/cargar-firmware.cmd` lista `.ino` de la carpeta configurada, compila el seleccionado y exige confirmación antes de cargarlo.
- `scripts/patch-bluetooth-gradle.mjs` adapta el plugin Bluetooth a la configuración ProGuard que requiere el Gradle actual.
- `.github/workflows/android-release.yml` compila y publica el APK firmado, el `.ino` y un ZIP del sketch en Releases cuando se sube una etiqueta `v*`; necesita los secretos de firma descritos en `docs/GUIA_TECNICA.md`.

## Validación conocida

- La app web/Android se ha compilado y el APK de prueba se ha instalado y abierto en un teléfono.
- La compilación automática para Releases está preparada, pero no se ha ejecutado en GitHub ni se han configurado allí los secretos de firma.
- El firmware se ha compilado para Uno y el protocolo se ha ejecutado en PC con mocks. Los mocks no sustituyen al hardware.
- No hay verificación física de ESC, servo, signos del MPU, ausencia de tirones ni failsafe real.

## Antes de publicar

- Revisa `git status` y los cambios previos de app/firmware antes de crear commits; excluye configuración local, credenciales y artefactos.
- Ejecuta las instrucciones de validación de `README.md` y `docs/GUIA_FIRMWARE.md` que correspondan a los cambios.
- La publicación a GitHub y la validación física del barco siguen siendo tareas separadas.
