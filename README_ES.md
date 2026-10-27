# Barco V2 — proyecto organizado

Este es el espacio de trabajo nuevo. Las carpetas anteriores en Descargas y en `C:\Users\PC\projects` permanecen intactas.

## Estructura

- `app/`: app Capacitor 8, fuente activa en `src/` y plataforma Android nativa en `android/`.
- `firmware/arduino/`: firmware y pruebas del controlador.
- `docs/`: documentación del firmware y referencia de la app web estable V1.
- `scripts/`: automatizaciones del proyecto.
- `AGENTS.md`: restricciones de hardware y protocolo que deben respetarse.

La fuente Android en `app/src/` y la app web V1 en `docs/referencia-app-web-v1/` son versiones distintas. La app Android es la fuente activa para generar APK; la V1 se conserva como referencia.

## Actualizar la app Android

Conecta el teléfono por USB, activa Depuración USB y acepta el aviso de autorización. Luego haz doble clic en `scripts/actualizar-app-android.cmd`. El script encuentra el proyecto Capacitor y Gradle, instala dependencias si hacen falta, compila la web, sincroniza Capacitor, genera el APK, lo instala encima de la app existente y la abre. Si hay varios teléfonos conectados, te deja elegir uno.

También puedes abrir una terminal en la carpeta de la app y ejecutar `npm run deploy:android`. El APK queda en la carpeta de salidas de depuración del módulo Android.

## Cargar el firmware Arduino

Conecta el Arduino Uno por USB y haz doble clic en `scripts/cargar-firmware.cmd`. El script encuentra el sketch activo por sus inclusiones de NeoSWSerial y la señal del ESC, detecta el puerto USB cuando es posible, compila para Arduino Uno y carga el firmware. Si hay varios puertos, podrás elegir uno. Confirma escribiendo `SI` después de retirar la hélice; sin esa confirmación, no carga nada.

El sketch ahora se llama `barco_control.ino` y está dentro de una carpeta con el mismo nombre, como requiere Arduino.

Para compilar y cargar el firmware, consulta [la guía de firmware](docs/GUIA_FIRMWARE.md).

## Compilación automática mientras editas

En `app/`, `npm run watch:android` compila el APK al iniciar y después de cada cambio en `app/src/`. Este modo deja el APK actualizado en disco; para instalarlo en el teléfono, usa el acceso `scripts/actualizar-app-android.cmd`.

Los scripts usan el Android SDK y Arduino CLI configurados en este PC. El teléfono y la placa no estaban conectados al preparar estos accesos, así que la instalación y la carga física quedan pendientes de ejecutarse con los dispositivos conectados.
