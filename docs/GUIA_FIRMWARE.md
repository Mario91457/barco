# Guía del firmware: cableado y Arduino IDE

Sketch activo en el repositorio: `firmware/arduino/barco_control.ino`. El hardware objetivo es Arduino Uno/ATmega328P a 16 MHz.

## Conexiones del cableado

| Módulo | Conexión al Arduino Uno | Detalle |
| --- | --- | --- |
| HC-06 | TXD → D5; RXD ← D6 | D5 es RX y D6 TX de NeoSWSerial; 9600 baudios. |
| ESC | Señal → D9 (OC1A) | Salida PWM de control del motor. |
| Servo del timón | Señal → D10 (OC1B) | Salida PWM de dirección. |
| MPU6500 | SDA → A4; SCL → A5 | I²C en la dirección `0x68`. |
| Tierra común | GND del Arduino con GND del HC-06, ESC, servo y MPU6500 | Todos deben compartir referencia de tierra. |

La lista indica las señales usadas por el firmware. La tensión de alimentación y los cables de potencia dependen de las placas y del ESC concretos; comprueba sus etiquetas y documentación antes de conectarlos. El firmware no determina esos voltajes.

El Timer1 del Uno genera PWM de 50 Hz en D9 y D10. No uses `Servo.h`, `analogWrite()` en esos pines ni otra función que reconfigure Timer1.

## Preparar Arduino IDE

1. Instala [Arduino IDE](https://support.arduino.cc/hc/en-us/articles/360019833020-Download-and-install-Arduino-IDE).
2. Instala la biblioteca **NeoSWSerial** desde **Herramientas → Administrar bibliotecas…** (o el icono de Library Manager), busca `NeoSWSerial` y pulsa **Instalar**. Consulta la [guía oficial para instalar bibliotecas](https://support.arduino.cc/hc/en-us/articles/5145457742236-Install-libraries-in-the-Arduino-IDE).
3. Descarga `Barco-Firmware-v....zip` desde [Releases](https://github.com/Mario91457/barco/releases), extráelo y abre `barco_control/barco_control.ino` en Arduino IDE. Esa carpeta y el archivo principal tienen el mismo nombre, como requiere la estructura de un sketch de Arduino.

Si vas a compilar una copia del repositorio, el archivo activo está en `firmware/arduino/barco_control.ino`. Para abrirlo con Arduino IDE, copia el archivo en una carpeta aparte llamada `barco_control` y abre `barco_control/barco_control.ino`; conserva intacta la copia del repositorio. Consulta la [guía de inicio de Arduino IDE 2](https://docs.arduino.cc/software/ide-v2/tutorials/getting-started-ide-v2/).

## Compilar y cargar

1. En el selector de placa, elige **Arduino Uno**. Si no aparece, abre **Boards Manager**, instala **Arduino AVR Boards** y vuelve a elegir **Arduino Uno**.
2. En **Herramientas → Puerto**, selecciona el puerto COM del Arduino. Cierra el Monitor Serie y cualquier otro programa que lo esté usando.
3. Pulsa **Verificar** (✓) para compilar. Si no hay errores, pulsa **Subir** (→) para cargar el programa.
4. Espera a que Arduino IDE indique que la carga terminó. El reinicio y la calibración inicial tardan varios segundos.

## Prueba de banco

Después de cargar cambios, verifica con la hélice retirada:

1. Confirma que el ESC permanece detenido al encender, tras `S` y cuando vence el failsafe avanzado (`FAILSAFE_MS`, 1,6 s sin órdenes avanzadas de control).
2. Verifica el centro y los límites del servo; el brazo no debe forzar los topes.
3. Gira el barco a mano en sentido horario: yaw debe aumentar. Eleva la proa: pitch positivo. Inclina estribor hacia abajo: roll positivo.
4. Activa crucero con el barco inmóvil; al girarlo a mano, el timón debe oponerse al giro. No navegues si la corrección va en el mismo sentido.
5. Comprueba `CAL` con el barco inmóvil y que el watchdog reinicie la placa si el loop deja de avanzar.

Una compilación correcta en Arduino IDE no verifica el ESC, el sentido real del timón, los signos del MPU ni el failsafe físico. Esas comprobaciones requieren una prueba controlada en el barco.

## Errores comunes

- **Falta `NeoSWSerial.h`:** instálala desde Library Manager y vuelve a compilar.
- **No aparece Arduino Uno:** instala **Arduino AVR Boards** desde Boards Manager.
- **No aparece el puerto:** usa un cable USB de datos y revisa el Administrador de dispositivos y el controlador USB-serie.
- **Puerto ocupado:** cierra el Monitor Serie y otras aplicaciones que usen ese puerto.
- **El sketch no abre o no compila por su carpeta:** confirma que la carpeta se llame `barco_control` y que dentro esté `barco_control.ino`.
