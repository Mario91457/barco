# Barco RC

Aplicación para controlar el barco y firmware para la placa Arduino. La app permite manejar el barco y consultar sus instrumentos; el Arduino recibe las órdenes y controla el motor y el timón.

## Instalar la app

1. Abre [**Releases de GitHub**](https://github.com/Mario91457/barco/releases).
2. En la versión más reciente, descarga `Barco-v....apk`.
3. Abre el archivo en tu teléfono Android y confirma la instalación. Si Android pregunta, permite instalar apps desde el navegador o administrador de archivos que estés usando.
4. Abre **Barco** y conéctate al HC-06 desde la app.

La app se distribuye como una versión de prueba separada de la app anterior. Para actualizarla, instala el APK más reciente desde **Releases**.

## Cargar el programa del barco

Esto se hace desde una computadora con Arduino IDE y conectada al Arduino por USB:

1. Abre **Releases** y descarga `Barco-Firmware-v....zip` de la misma versión. También está disponible `barco_control.ino` suelto.
2. Extrae el ZIP y abre `barco_control/barco_control.ino` con Arduino IDE.
3. Conecta el Arduino, selecciona **Arduino Uno** y el puerto que aparece, y pulsa **Subir** (flecha hacia la derecha).
