# Barco RC — V1 estable (Arduino Uno + app Android)

> Documento histórico de la versión V1. Algunas rutas y comandos de protocolo aquí descritos ya no corresponden a la app/firmware activos. Usa `README.md`, `AGENTS.md` y `docs/GUIA_FIRMWARE.md` como fuentes actuales.

Proyecto para controlar el barco mediante Arduino Uno/ATmega328P, ESC, servo, MPU6500, HC-06 y una app Android hecha con Capacitor.

## Componentes esenciales

- `src/index.html`: interfaz y estilos.
- `src/main.js`: controles Simple/Avanzado, Bluetooth y recepción de telemetría.
- `src/instrumentos.js`: instrumentos SVG de yaw, velocidad y horizonte.
- `src/assets/barco.svg`: SVG del casco del instrumento de rumbo (proa hacia arriba en la GUI).
- `arduino/barco_control_PID_MPU6500_D5_D6/barco_control_PID_MPU6500_D5_D6.ino`: firmware activo.
- `arduino/tests/prueba_pwm_hardware_vs_servo/`: prueba A/B que permitió identificar los tirones con la librería `Servo` frente a PWM de Timer1.
- `arduino/tests/host_protocolo/`: prueba de escritorio del protocolo del firmware (opcional, ver abajo).
- `docs/diagnostico_tirones_mpu6500.md`: evidencia de diagnóstico y solución PWM.
- `AGENTS.md`: contexto breve para futuros agentes.

## Hardware

- Placa: Arduino Uno / ATmega328P a 16 MHz.
- HC-06: TXD → D5, RXD ← D6, 9600 baudios y GND común.
- ESC: D9 (OC1A). Servo: D10 (OC1B).
- MPU6500: SDA → A4, SCL → A5, dirección habitual `0x68`.
- Timer1 está reservado para PWM a 50 Hz. No usar `Servo.h` ni reconfigurar Timer1.

## Compilar la app

```bash
npm install
npm run build
# Solo la primera vez, si el proyecto aún no tiene la plataforma Android:
npx cap add android
npx cap sync android
```

Después abre `android/` en Android Studio para generar el APK. Si ya tienes una carpeta `android/` con personalizaciones, consérvala, omite `npx cap add android` y solo reemplaza `src/`. La actividad principal debe mantener `android:screenOrientation="landscape"`.

## Protocolo

- **Modo Simple** (compatible con Arduino Bluetooth Control): bytes sueltos sin salto de línea ni checksum. `F` avanza a potencia fija 20 y centra el timón; `S` detiene; `L`/`G` giran a babor y `R`/`H` a estribor (también con potencia 20); `C` centra.
- **Modo Avanzado**: líneas `<orden>*<HH>\n`, donde `HH` es el XOR de los bytes de `<orden>` en dos hexadecimales mayúsculas (p. ej. `D90*4D`). El firmware descarta toda línea sin checksum válido (`REQUIRE_LINE_CHECKSUM`). Órdenes: `P<n>` potencia, `D<n>` servo, `PID,0/1`, `CRU,0/1`, `HOLD`, `KP/KI/KD,<n>`, `CAL`, `TEL,0/1`.
- **Configuración que la app envía al conectar, al cambiarla y cada 5 s** (no renuevan el failsafe): `ANG,<centro>,<babor>,<estribor>` (calibración del servo de Ajustes) y `PMAX,<n>` (velocidad máxima de Ajustes). El firmware usa `ANG` en `C`, `F`, `L`/`R`, `HOLD`, el failsafe y el PID, y recorta el PID a esos límites; `PMAX` es un tope de potencia en el firmware. Sin `ANG`/`PMAX` (p. ej. con la app clásica) rigen 90°/120°/60° y potencia máxima 20.
- **Telemetría**: `TEL,1` activa el paquete `T,yaw,pitch,roll,velocidad_en_décimas_de_m_s` (p. ej. `T,-12,4,-7,12`), como máximo 4 por segundo y un latido por segundo si no cambia nada. La app marca la telemetría como interrumpida a los 3,2 s sin paquetes.

Al conectar, la app apaga siempre `PID` y `CRU` (el Arduino no se reinicia al reconectar el Bluetooth), también en modo Simple.

## Convención de signos

`yaw > 0` = la proa gira a estribor (horario visto desde arriba), `pitch > 0` = proa arriba, `roll > 0` = estribor abajo. El yaw integra el gyro Z y deriva; pitch/roll salen solo del acelerómetro con `pitch = atan2(x, √(y²+z²))` y `roll = atan2(−y, √(x²+z²))`. Si el montaje del MPU invierte algún signo, cambia `MPU_YAW_SIGN`, `MPU_PITCH_SIGN` o `MPU_ROLL_SIGN` en el firmware (no las fórmulas). Verifícalo con la prueba de banco.

El sentido del servo del PID se deduce de la calibración: si «Servo a estribor» es un ángulo mayor que «Servo al centro» el servo sube al corregir hacia estribor; si es menor (por defecto 70 < 90) baja.

## Estimación de velocidad (limitación conocida)

La velocidad integra la aceleración longitudinal del eje `MPU_FORWARD_ACCEL_AXIS` con filtrado y zona muerta. **No compensa la gravedad**: inclinar el casco (pitch estático, proa levantada al planear) la altera y puede dispararla hasta el límite de 5 m/s; con el motor encendido tampoco decae. Es una indicación orientativa, no una medida; no usarla como criterio de aceptación.

## Opciones del firmware (`#define` al inicio del `.ino`)

| Opción | Efecto |
| --- | --- |
| `ESC_BIDIRECTIONAL` | 1 para ESC con neutro en 1500 µs (parada 1500, avance 1550–2000; nunca marcha atrás). Por defecto 0 (parada 1000 µs). |
| `MPU_YAW_SIGN` / `MPU_PITCH_SIGN` / `MPU_ROLL_SIGN` | Signo de la telemetría (1 o −1). |
| `WATCHDOG_TIMEOUT` | Watchdog del AVR (500 ms). Si `loop()` se cuelga (p. ej. bus I²C bloqueado) reinicia la placa y el pulso del ESC vuelve a parada. Un reinicio repite armado y calibración del gyro (~7 s). |
| `USE_WIRE_TIMEOUT` | Timeout de 25 ms en I²C (núcleo AVR ≥ 1.8.3). Poner 0 si el IDE antiguo no compila `setWireTimeout`. |
| `REQUIRE_LINE_CHECKSUM` | 0 solo para probar a mano desde un terminal serie sin calcular checksums. |
| `MPU_GYRO_CONFIG_VALUE` / `GYRO_LSB_PER_DPS` | Gyro a ±500 °/s (65,5 LSB/°/s) para no saturar en giros bruscos. |

## Pruebas y seguridad

1. Compila el sketch con Arduino Uno/ATmega328P a 16 MHz (necesita la librería NeoSWSerial).
2. Retira la hélice antes de energizar el ESC.
3. Verifica que el motor no arranque solo, que `S` y el failsafe (1,6 s sin órdenes) lo detengan y que D10 no fuerce topes mecánicos con la calibración de Ajustes.
4. **Prueba de banco de signos** (sin hélice, con telemetría activa):
   - Gira el barco a mano en sentido horario visto desde arriba: el yaw de la app debe subir y el bote girar en horario. Si baja, `MPU_YAW_SIGN = -1`.
   - Levanta la proa: pitch positivo. Si no, `MPU_PITCH_SIGN = -1`.
   - Inclina con estribor abajo: roll positivo. Si no, `MPU_ROLL_SIGN = -1`.
   - Activa PID y Crucero con el barco quieto y gíralo a mano hacia estribor: el timón debe ir hacia babor (contra el giro). Si va al mismo lado hay realimentación positiva: no navegar hasta corregir el signo del yaw o la calibración del servo.
5. Comprueba que pitch/roll responden a la inclinación. La velocidad **sí** cambiará al inclinar (ver limitación arriba).
6. Prueba la velocidad con aceleraciones cortas solo como referencia cualitativa.
7. Para simular un fallo del bus, desconecta SDA con el motor sin hélice: en ≤ 0,5 s la placa debe reiniciarse y el pulso del ESC volver a parada.
8. `arduino/tests/host_protocolo/run.sh` ejecuta en el PC el protocolo del firmware (checksum, `ANG`, `PMAX`, failsafe, PID, `CAL`) con mocks de Arduino; no sustituye las pruebas en hardware. Necesita `g++` y `node`.

Los valores de pulso del ESC deben comprobarse con el modelo concreto de variador. La ausencia de tirones y la calidad de la telemetría requieren pruebas físicas.
