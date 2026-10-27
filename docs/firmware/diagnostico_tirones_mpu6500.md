# Diagnóstico de los tirones del motor y estado V1

## Hardware relevante
- Arduino Uno / ATmega328P a 16 MHz.
- ESC en D9, servo en D10; HC-06 en D5/D6; MPU6500 por I²C.

## Evidencia que identificó los tirones
El usuario realizó una prueba A/B con el mismo hardware y patrón de lectura del MPU6500:

- `PWM_BACKEND 0` (biblioteca `Servo`): aparecían tirones pequeños periódicos en el motor.
- `PWM_BACKEND 1` (PWM por hardware Timer1): no aparecían tirones durante esa prueba.
- En pruebas posteriores el usuario informó que, tras adoptar PWM Timer1, los tirones desaparecieron.

La evidencia apunta a una interacción entre la temporización de `Servo` y la actividad del programa/I²C. No demuestra un mecanismo eléctrico único, pero justifica mantener el firmware integrado con Timer1.

## Solución integrada
- D9 = OC1A para el ESC y D10 = OC1B para el servo.
- Fast PWM Timer1 modo 14, prescaler 8, TOP=39999: periodo de 20 ms (50 Hz), resolución 0,5 µs a 16 MHz.
- No usar `Servo.h` ni permitir que otra biblioteca reconfigure Timer1.
- MPU sample divider `0x04` con filtro DLPF activo (~200 Hz); control yaw nominal a intervalos de `5000UL` (5 ms).
- Watchdog del AVR (500 ms) y timeout de 25 ms en I²C: como Timer1 mantiene el último pulso aunque el programa se cuelgue, el watchdog reinicia la placa y el pulso vuelve a parada.

## Velocidad al inclinar el barco (estado actual)
Una versión intermedia intentó resolver que la velocidad subía al inclinar el casco con un filtro complementario gyro X/Y + acelerómetro y restando la gravedad proyectada sobre el eje longitudinal. **Esa versión se revirtió**: el firmware actual vuelve a calcular pitch/roll solo con el acelerómetro y a integrar la aceleración longitudinal sin compensar la gravedad.

Consecuencia conocida y pendiente: un pitch estático de más de ~0,7° respecto al reposo calibrado supera la zona muerta (0,12 m/s²) y la velocidad estimada puede subir hasta el límite de 5 m/s; con el motor encendido no hay decaimiento. La velocidad es solo orientativa.

## Test conservado
`arduino/tests/prueba_pwm_hardware_vs_servo/prueba_pwm_hardware_vs_servo.ino` reproduce el caso comparativo Servo frente a Timer1. Mantenerlo para diagnosticar regresiones de PWM.

## Validación
- Hecho: compilación del firmware integrado con avr-gcc 7.3 para ATmega328P a 16 MHz (ArduinoCore-avr 1.8.8 y NeoSWSerial) sin warnings, y ejecución del protocolo en PC con mocks.
- Pendiente en hardware: armado del ESC, servo y Bluetooth sin hélice; prueba de banco de signos del README; reinicio por watchdog con el bus I²C cortado.
- Pendiente: la velocidad no está validada (ver arriba); la ausencia de tirones y la calidad de la telemetría requieren confirmación física.
