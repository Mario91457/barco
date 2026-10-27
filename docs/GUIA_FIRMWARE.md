# Compilar y cargar el firmware

Esta guía sirve para preparar y cargar el firmware del Barco RC desde Windows. El sketch activo es `firmware/arduino/barco_control/barco_control.ino`. La carpeta y el archivo se llaman igual porque Arduino lo requiere.

## Hardware y seguridad

El firmware está preparado para Arduino Uno / ATmega328P a 16 MHz:

- Bluetooth HC-06: D5 (RX) y D6 (TX), a 9600 baudios.
- ESC: D9. Servo del timón: D10.
- MPU6500: SDA=A4, SCL=A5, dirección I²C `0x68`.
- El firmware usa NeoSWSerial. La biblioteca `Wire` viene con el núcleo AVR.

Retira la hélice antes de conectar la batería o hacer pruebas del motor. Comprueba que el ESC está detenido y que el servo no fuerza los topes mecánicos. No uses `Servo.h` ni cambies Timer1: el firmware lo reserva para las señales PWM de D9 y D10.

## Preparar Arduino CLI

Instala Arduino CLI y asegúrate de que `arduino-cli` se pueda ejecutar desde PowerShell. Después instala el núcleo AVR y NeoSWSerial una sola vez:

```powershell
arduino-cli core update-index
arduino-cli core install arduino:avr
arduino-cli lib install NeoSWSerial
```

Comprueba que quedaron instalados:

```powershell
arduino-cli core list
arduino-cli lib list
```

Debe aparecer `arduino:avr` y `NeoSWSerial`.

## Forma rápida: compilar y cargar con un clic

1. Conecta el Arduino Uno al PC con un cable USB que transmita datos.
2. Cierra el Monitor Serie del IDE u otro programa que esté usando el puerto.
3. Desde el Explorador, haz doble clic en `scripts/cargar-firmware.cmd`.
4. El script localiza el sketch activo y trata de detectar el puerto USB. Si aparecen varios, elige el de la placa. Si no detecta ninguno, introduce el puerto, por ejemplo `COM3`.
5. El script compila para Arduino Uno. Antes de cargar, retira la hélice y escribe `SI` para confirmar.
6. Espera el mensaje de carga correcta; no desconectes el cable mientras se programa la placa.

La carga reinicia el Arduino. El firmware vuelve a realizar la secuencia de armado del ESC y la calibración del giroscopio, que dura unos 7 segundos.

## Compilar y cargar desde PowerShell

Abre PowerShell en la carpeta raíz del proyecto. Para revisar qué puertos están conectados:

```powershell
arduino-cli board list
```

Asigna el puerto real de la placa, compila y luego carga:

```powershell
$sketch = Resolve-Path '.\firmware\arduino\barco_control'
arduino-cli compile --fqbn arduino:avr:uno $sketch
arduino-cli upload --fqbn arduino:avr:uno --port COM3 $sketch
```

Sustituye `COM3` por el puerto que muestre tu PC. La carga manual no incluye la confirmación de seguridad del acceso rápido: retira la hélice antes de conectar la batería o probar el motor.

## Si algo falla

- **No se encuentra `arduino-cli`:** instala Arduino CLI o añade su ubicación al `PATH` de Windows; abre una terminal nueva.
- **Falta el núcleo `arduino:avr`:** ejecuta los comandos de instalación de la sección anterior.
- **No encuentra `NeoSWSerial.h`:** instala NeoSWSerial con `arduino-cli lib install NeoSWSerial`.
- **No aparece ningún puerto:** usa un cable USB de datos, prueba otro puerto USB y revisa el Administrador de dispositivos. Algunos clones necesitan el controlador de su conversor USB-serie.
- **Puerto ocupado o acceso denegado:** cierra Arduino IDE, Monitor Serie, terminales serie y cualquier otra app que tenga abierto ese COM.
- **La carga empieza y falla:** confirma que la placa seleccionada sea Arduino Uno, vuelve a elegir el COM correcto y pulsa RESET cuando el cargador solicite sincronización.

## Después de cargar

Haz la primera prueba sin hélice. Verifica parada del ESC, respuesta del timón y calibración antes de activar el motor. Para validar sensores, signos de actitud, PID, failsafe y watchdog, sigue la prueba de banco descrita en `docs/README_ESTABLE_V1.md`. El firmware no se ha validado en hardware solo por compilar o cargar; las pruebas físicas siguen siendo necesarias.
