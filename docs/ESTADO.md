# Estado compartido del proyecto

Actualizado: 2026-10-27

## Fuente activa

- App Android: `app/src/` y el proyecto nativo `app/android/`.
- Firmware Arduino Uno: `firmware/arduino/barco_control/barco_control.ino`.
- La app web en `docs/referencia-app-web-v1/` se conserva como referencia V1; no se sincroniza con Android.

## Automatizaciones

- `scripts/actualizar-app-android.cmd` compila, instala y abre la app en un teléfono conectado.
- `scripts/cargar-firmware.cmd` compila y carga el firmware; solicita confirmar que se retiró la hélice.
- `app/` contiene `watch:android` para reconstruir el APK después de cambios en `app/src/`.
- `scripts/patch-bluetooth-gradle.mjs` adapta la dependencia Bluetooth a la configuración ProGuard que acepta Gradle actual; se ejecuta durante la instalación y antes de compilar.

## Última verificación conocida

- El despliegue Android había fallado al evaluar la dependencia Bluetooth por `proguard-android.txt`. Se añadió la corrección automática a `proguard-android-optimize.txt`.
- La compilación posterior no quedó confirmada: el intento desde el entorno de Codex se detuvo porque Gradle no pudo comunicarse con su daemon.
- No hay confirmación de instalación en teléfono ni de pruebas físicas del Arduino/ESC.

## Pendientes para retomar

1. Ejecutar `npm run deploy:android` desde `app/` y registrar el resultado de compilación e instalación.
2. Cuando se conecte el hardware, seguir `docs/GUIA_FIRMWARE.md` y las precauciones de `AGENTS.md`; probar sin hélice.

## Registro de tareas

Al completar trabajo significativo, añadir una entrada breve con fecha, resumen, rama/PR, verificaciones y pendientes. No copiar aquí conversaciones completas.
