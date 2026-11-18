# Guía de trabajo para Barco RC

## Fuentes activas

- App: `app/src/index.html`, `app/src/main.js`, `app/src/instrumentos.js` y `app/src/assets/barco.svg`.
- Proyecto Android/Capacitor: `app/android/` y `app/capacitor.config.json`.
- Firmware: `firmware/arduino/barco_control/barco_control.ino`.
- Prueba host del protocolo: `firmware/arduino/tests/host_protocolo/` (mocks; no sustituye hardware).
- Prueba PWM que debe conservarse: `firmware/arduino/tests/prueba_pwm_hardware_vs_servo/prueba_pwm_hardware_vs_servo.ino`.
- Documentación para participantes: `README.md`; mantenimiento/compilación: `docs/GUIA_TECNICA.md`; guía del firmware: `docs/GUIA_FIRMWARE.md`.
- `docs/referencia-app-web-v1/`, `docs/README_ESTABLE_V1.md` y `docs/firmware/diagnostico_tirones_mpu6500.md` son referencias históricas, no fuentes activas.

Antes de cambiar app o firmware, revisa este archivo y la documentación relacionada. Edita `app/src/`, no `app/www/`, que se genera al compilar.

## Restricciones de hardware

- Hardware objetivo: Arduino Uno / ATmega328P a 16 MHz.
- HC-06: D5 RX y D6 TX de NeoSWSerial a 9600 baudios.
- ESC: D9 / OC1A. Servo: D10 / OC1B. MPU6500: SDA=A4, SCL=A5, I²C `0x68`.
- Timer1 está reservado para PWM de 50 Hz. No reintroducir `Servo.h`, `analogWrite()` en D9/D10 ni otra función que configure Timer1.
- Muestreo MPU: `MPU_SAMPLE_DIVIDER=0x04` (~200 Hz); yaw se actualiza cada `5000UL`. Gyro a ±500 °/s (`MPU_GYRO_CONFIG_VALUE=0x08`, `GYRO_LSB_PER_DPS=65.5`).
- El watchdog AVR está activo tras `setup()` (500 ms). `loop()` debe llamar `wdt_reset()` y los bucles bloqueantes, como `CAL`, deben alimentarlo.
- No cambies pines, orientación/ejes del MPU ni signos sin autorización y sin seguir la prueba de banco del README.
- Pruebas del motor siempre sin hélice. `ESC_BIDIRECTIONAL` debe coincidir con el variador real.

## Protocolo que debe conservarse

- La app actual usa en ambos modos líneas `<orden>*<HH>\n`, con XOR hexadecimal de la orden; `enviarLinea()` añade el checksum. Control manual: `P<n>` y `D<n>`.
- Crucero actual: `CRU,1,KP=<n>,KI=<n>,KD=<n>` aplica ganancias y activa el mantenimiento de rumbo como una sola orden; `CRU,0` lo desactiva. El firmware valida checksum y valores antes de cambiar estado. Si ya está activo, actualizar ganancias conserva el rumbo objetivo.
- Configuración enviada al conectar y cada 5 s: `ANG,centro,babor,estribor` y `PMAX,n`. No renueva el failsafe.
- `HOLD` captura rumbo cuando se solicita. `CAL` detiene el motor y calibra bias gyro Z. Telemetría: `TEL,0/1`; trama `T,yaw,pitch,roll,velocidad_decimas_m_s`.
- Telemetría permanece separada del control y no activa, renueva ni desactiva el failsafe.
- Compatibilidad heredada obligatoria: bytes sueltos sin LF/CR/checksum `F`, `S`, `L`, `G`, `R`, `H`; `C` centra. `F` avanza a potencia 20 y centra; `S` detiene; `L/G` babor y `R/H` estribor con potencia 20. Son órdenes puntuales: no activan ni renuevan el failsafe avanzado. No se deben enviar esos bytes desde la app actual ni cambiar su significado. `S` siempre detiene el motor.
- No volver a introducir comandos avanzados antiguos `PID` o `KP/KI/KD` por separado como activación del controlador. Los bytes simples heredados no son esos comandos.

## Estimación inercial

- Signos: yaw positivo = proa a estribor/horario; pitch positivo = proa arriba; roll positivo = estribor abajo. Yaw integra gyro Z y deriva porque no hay magnetómetro.
- Pitch y roll usan las fórmulas restauradas del acelerómetro. No añadir fusión gyro X/Y ni compensación de gravedad sin autorización.
- La velocidad integra aceleración longitudinal filtrada y no compensa la gravedad; inclinar el casco puede alterarla. Es una estimación, no velocidad GPS.
- Los ejes/signos se adaptan con `MPU_FORWARD_ACCEL_AXIS`, `MPU_FORWARD_ACCEL_SIGN` y `MPU_*_SIGN`, previa verificación física.

## Cambios y validación

- Conserva la prueba PWM y los mocks de protocolo. No elimines compatibilidad heredada al limpiar/refactorizar.
- Tras cambios al firmware, ejecuta la prueba host y compila para Uno; después sigue la prueba de banco del README. Las pruebas de PC no prueban el hardware.
- No afirmes ausencia de tirones, signos correctos o failsafe real sin prueba física. La prueba del motor requiere hélice retirada.
- No incluyas cachés, APKs, salidas generadas, credenciales ni configuración local. Revisa `git status` antes de preparar un commit.
- La app usa el ID de prueba `com.mario.barco.test`. El flujo `.github/workflows/android-release.yml` crea el APK y adjunta el `.ino` activo y un ZIP de sketch en etiquetas `v*`; nunca guardes el keystore ni contraseñas de firma en el repositorio. El flujo no carga firmware a una placa.
- No publiques, subas firmware ni instales APK en dispositivos como parte de una tarea de documentación, salvo que el usuario lo solicite expresamente.
- Mantén `README.md`, `docs/GUIA_TECNICA.md` y `docs/GUIA_FIRMWARE.md` consistentes.
