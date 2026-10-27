# Instrucciones para Claude Code

Antes de modificar el proyecto, lee `AGENTS.md`, `README_ES.md`, `docs/GUIA_FIRMWARE.md` y `docs/ESTADO.md`.

## Mapa del proyecto

- `app/`: aplicación Capacitor activa y proyecto Android.
- `firmware/arduino/barco_control/barco_control.ino`: firmware activo del barco.
- `firmware/arduino/tests/`: pruebas del firmware.
- `docs/referencia-app-web-v1/`: código antiguo de referencia; no es la fuente de la app Android actual.
- `scripts/`: compilación, instalación Android y carga del firmware.

## Trabajo entre agentes

- Usa una rama propia para cada tarea; no trabajes directamente en `main`.
- Entrega los cambios mediante un pull request y describe qué cambiaste y qué verificaste.
- Antes de empezar, consulta `docs/ESTADO.md`. Al terminar una tarea significativa, actualízalo con los cambios, pruebas, decisiones y pendientes para que otro agente pueda continuar.
- No asumas que el contexto de una conversación se comparte entre agentes: deja en el repositorio la información necesaria para retomar el trabajo.

## Límites de seguridad

- Respeta las restricciones de hardware y protocolo de `AGENTS.md`, especialmente los pines, Timer1 y las reglas del ESC.
- No cargues firmware en una placa física ni instales la app en un teléfono sin que el usuario lo pida expresamente.
- Las compilaciones no demuestran que el hardware esté probado. No afirmes que se validó físicamente sin evidencia.
- No agregues al repositorio cachés, salidas de compilación, credenciales ni configuración local.
