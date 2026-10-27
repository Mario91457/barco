# AGENTS.md — Barco RC V1 estable

## Fuente de verdad
- Firmware activo: `firmware/arduino/barco_control/barco_control.ino`.
- App: `app/src/index.html`, `app/src/main.js`, `app/src/instrumentos.js`, `app/src/assets/barco.svg`.
- Test que se debe conservar: `firmware/arduino/tests/prueba_pwm_hardware_vs_servo/prueba_pwm_hardware_vs_servo.ino`.
- Prueba de escritorio del protocolo: `firmware/arduino/tests/host_protocolo/` (mocks; no sustituye al hardware).
- Diagnóstico histórico: `docs/firmware/diagnostico_tirones_mpu6500.md`.

## Hardware/pines que no se deben cambiar sin autorización
- Arduino Uno / ATmega328P a 16 MHz.
- HC-06: D5 RX y D6 TX de NeoSWSerial a 9600 baudios.
- ESC D9 (OC1A), servo D10 (OC1B), MPU6500 SDA=A4/SCL=A5/I²C `0x68`.
- Timer1 hace PWM de 50 Hz y está reservado; no reintroducir `Servo.h` ni usar otra función que configure Timer1.
- Muestreo MPU: `MPU_SAMPLE_DIVIDER=0x04` (~200 Hz); la actualización de yaw está en `5000UL`. Gyro a ±500 °/s (`MPU_GYRO_CONFIG_VALUE=0x08`, `GYRO_LSB_PER_DPS=65.5`).
- Watchdog del AVR activo tras `setup()` (500 ms): `loop()` debe llamar a `wdt_reset()` y cualquier bloqueo largo (como `CAL`) también. Si se añade código bloqueante, alimentar el watchdog dentro del bucle.

## Protocolo app ↔ Arduino
- Simple (bytes sueltos, sin LF/CR y sin checksum, compatibilidad con Arduino Bluetooth Control): `F`, `S`, `L`, `G`, `R`, `H`; `C` centra. `F` avanza a potencia 20 y centra; `S` detiene; `L/G` babor y `R/H` estribor con potencia 20. Los comandos de línea no deben empezar por `F S L G R H C` salvo `HOLD`, `CAL` y `CRU`, porque esos bytes se interceptan al inicio de línea.
- Avanzado: líneas `<orden>*<HH>\n` (HH = XOR hex de la orden; `enviarLinea()` de `main.js` lo añade a toda orden de más de un carácter). Órdenes: `P<n>`, `D<n>`, `PID,0/1`, `CRU,0/1`, `HOLD`, `KP/KI/KD,<n>`, `CAL`, `TEL,0/1`. El firmware descarta líneas sin checksum válido.
- Configuración app→firmware, reenviada cada 5 s y sin renovar el failsafe: `ANG,centro,babor,estribor` (calibración del servo; el firmware la usa en C/F/L/R/HOLD/failsafe/PID) y `PMAX,n` (tope de potencia).
- Telemetría: `TEL,0/1`; paquete único `T,yaw,pitch,roll,velocidad_decimas_m_s`. No se implementan los formatos antiguos `Y<n>`/`V<n>`.
- Al conectar la app apaga siempre `PID,0` y `CRU,0`.

## Estimación inercial
- Convención: yaw>0 = proa a estribor (horario), pitch>0 = proa arriba, roll>0 = estribor abajo. `MPU_YAW_SIGN`/`MPU_PITCH_SIGN`/`MPU_ROLL_SIGN` (1 o −1) adaptan el montaje sin tocar las fórmulas; confirmar con la prueba de banco del README antes de cambiarlos.
- Yaw se integra del gyro Z y deriva al no haber magnetómetro.
- Pitch/roll usan únicamente las fórmulas del acelerómetro del firmware anterior proporcionado por el usuario; no añadir fusión complementaria gyro X/Y sin pedirlo.
- La velocidad integra la aceleración longitudinal filtrada y NO compensa la proyección de gravedad: inclinar el casco la altera y puede dispararla. Es una limitación conocida y pendiente, no un criterio de aceptación.
- El eje longitudinal y su signo se configuran con `MPU_FORWARD_ACCEL_AXIS` y `MPU_FORWARD_ACCEL_SIGN`. Confirmar orientación física antes de cambiar los ejes.

## Seguridad y validación
- Pruebas del motor siempre sin hélice hasta confirmar señales de parada. `ESC_BIDIRECTIONAL` debe coincidir con el variador real.
- No afirmar que el firmware está probado en hardware: se compiló con avr-gcc 7.3 contra ArduinoCore-avr 1.8.8 y NeoSWSerial, y el protocolo se ejecutó en PC con mocks, pero la ausencia de tirones, los signos y el failsafe reales requieren pruebas físicas.
- Después de cambiar firmware, compilar para Uno y repetir la prueba de banco del README (signos, PID, parada, reinicio por watchdog).
- Documentación operativa en `README_ES.md`; mantenerla concisa y actual.

## Convención de signos de actitud (versión restaurada)
- Se restauró el sketch anterior proporcionado por el usuario. Pitch/roll usan directamente las fórmulas del acelerómetro de ese archivo.
- No añadir compensación de gravedad ni fusionar pitch/roll con el giroscopio como parte de esta reversión.

