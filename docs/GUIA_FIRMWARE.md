# Guía de compilación y prueba del firmware

Sketch activo: `firmware/arduino/barco_control/barco_control.ino`. Esta guía está dirigida al Arduino Uno/ATmega328P a 16 MHz.

## Hardware y seguridad

- HC-06: RX de NeoSWSerial en D5, TX en D6, 9600 baudios.
- ESC D9/OC1A, servo D10/OC1B.
- MPU6500 SDA=A4, SCL=A5, dirección I²C `0x68`.
- Timer1 genera PWM de 50 Hz en D9 y D10. No uses `Servo.h` ni reconfigures Timer1.
- Retira la hélice antes de alimentar o probar el motor. Confirma el pulso de parada y el ajuste `ESC_BIDIRECTIONAL` para el ESC real.

## Instalar Arduino CLI y dependencias

Instala Arduino CLI y agrega `arduino-cli` al `PATH`. Instala el core AVR y NeoSWSerial una sola vez:

```powershell
arduino-cli core update-index
arduino-cli core install arduino:avr
arduino-cli lib install NeoSWSerial
```

Verifica con `arduino-cli core list` y `arduino-cli lib list`.

## Compilar y cargar

La carga manual compila el sketch activo así:

```powershell
arduino-cli compile --fqbn arduino:avr:uno .\firmware\arduino\barco_control
arduino-cli board list
arduino-cli upload --fqbn arduino:avr:uno --port COM3 .\firmware\arduino\barco_control
```

Sustituye `COM3` por el puerto real. Cierra el Monitor Serie y cualquier programa que use ese puerto.

En Windows también puedes ejecutar `scripts/cargar-firmware.cmd`. El cargador lista los `.ino` de la carpeta indicada por la constante `FirmwareFolder` en `scripts/cargar-firmware.ps1`; por defecto es `firmware/arduino/barco_control`. Selecciona el número, verifica el nombre mostrado y confirma la carga escribiendo `SI`. Para pasar el puerto: `scripts/cargar-firmware.ps1 -Port COM3`.

El cargador prepara el `.ino` elegido en una carpeta temporal para que sketches de una misma carpeta no se mezclen durante la compilación. La carga reinicia la placa; el arranque y calibración tardan varios segundos.

## Prueba de escritorio del protocolo

Desde Git Bash o WSL, en la raíz del proyecto:

```bash
bash firmware/arduino/tests/host_protocolo/run.sh
```

Se requiere Bash, `g++` y Node.js. Los mocks ejercitan el parser y el comportamiento del protocolo en PC; no sustituyen la prueba de hardware.

## Prueba de banco

Después de cambiar el firmware, compila para Uno y verifica con la hélice retirada:

1. Confirma que el ESC permanece detenido al encender, tras `S` y cuando vence el failsafe avanzado (`FAILSAFE_MS`, 1,6 s sin órdenes avanzadas de control).
2. Verifica servo, centro y límites de ángulo; el brazo no debe forzar los topes.
3. Gira el barco a mano en sentido horario: yaw debe aumentar. Eleva la proa: pitch positivo. Inclina estribor hacia abajo: roll positivo.
4. Activa crucero con el barco inmóvil; al girarlo a mano, el timón debe oponerse al giro. No navegues si la corrección va en el mismo sentido.
5. Comprueba `CAL` con el barco inmóvil y que el watchdog reinicie la placa si el loop deja de avanzar.

No afirmes que el hardware está verificado solo por compilar o pasar los mocks. El ESC concreto, el sentido real del timón, los signos del MPU y el failsafe requieren pruebas físicas controladas.

## Errores comunes

- **`arduino-cli` no se encuentra:** instala Arduino CLI y actualiza el `PATH`.
- **Falta `NeoSWSerial.h`:** instala la biblioteca con `arduino-cli lib install NeoSWSerial`.
- **No aparece el puerto:** usa un cable USB de datos, revisa el Administrador de dispositivos y el driver del conversor USB-serie.
- **Puerto ocupado:** cierra Arduino IDE, Monitor Serie y otras aplicaciones serie.
- **Falla al cargar:** confirma `arduino:avr:uno`, el puerto y el cable; vuelve a intentar RESET si la placa no sincroniza.
