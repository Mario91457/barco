# Barco RC

Aplicación para controlar el barco y firmware para la placa Arduino. La app permite manejar el barco y consultar sus instrumentos; el Arduino recibe las órdenes y controla el motor y el timón.

## Instalar la app

1. Abre [**Releases de GitHub**](https://github.com/Mario91457/barco/releases).
2. En la versión más reciente, descarga `Barco-v1.0.2.apk`.
3. Abre el archivo en tu teléfono Android y confirma la instalación. Si Android pregunta, permite instalar apps desde el navegador o administrador de archivos que estés usando.
4. Abre **Barco** y conéctate al HC-06 desde la app.

El APK usa el identificador `com.mario.barco`, igual que la app anterior. Android solo permite actualizarla si ambas versiones están firmadas con la misma clave. Si aparece un error de firma, tendrás que desinstalar la app instalada antes de instalar el APK nuevo; eso borra sus datos.

### Si Android bloquea la instalación: usar ADB

Google está desplegando gradualmente la verificación de desarrolladores. La primera etapa comenzó el 30 de septiembre de 2026 en Brasil, Indonesia, Singapur y Tailandia para instalaciones desde tiendas participantes; la expansión global está prevista para 2027. La documentación oficial mantiene ADB como opción para instalar y probar APKs no registrados. Este método instala la app en un teléfono conectado; no registra la app para distribuirla ampliamente.

En una computadora con Windows:

1. Descarga el APK más reciente desde [Releases](https://github.com/Mario91457/barco/releases).
2. Descarga las [Android SDK Platform-Tools para Windows](https://developer.android.com/tools/releases/platform-tools) y extrae el ZIP. Copia el APK a la carpeta `platform-tools`, junto a `adb.exe`.
3. En el teléfono, activa **Opciones de desarrollador** (en muchos modelos: **Ajustes → Acerca del teléfono → Número de compilación**, toca siete veces). Dentro de esas opciones, activa **Depuración por USB**. La ruta puede variar según el teléfono.
4. Conecta el teléfono con un cable USB de datos y mantenlo desbloqueado.
5. Abre PowerShell en la carpeta `platform-tools` (en el Explorador, escribe `powershell` en la barra de dirección y pulsa **Enter**). Comprueba la conexión:

   ```powershell
   .\adb.exe devices
   ```

   Si el teléfono pregunta, acepta **Permitir depuración por USB** y ejecuta el comando otra vez. Debe aparecer en la lista con el estado `device`.

6. Instala el APK. Cambia el nombre por el archivo que descargaste:

   ```powershell
   .\adb.exe install -r .\Barco-v1.0.2.apk
   ```

Si aparece `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, hay instalada una versión con otra firma. Desinstálala una sola vez y vuelve a instalar; esto borra los datos guardados de esa app:

```powershell
.\adb.exe uninstall com.mario.barco
.\adb.exe install .\Barco-v1.0.2.apk
```

Cuando termines, puedes desactivar **Depuración por USB**. Consulta la [guía oficial de ADB](https://developer.android.com/tools/adb), la guía para [activar la depuración](https://developer.android.com/studio/debug/dev-options), las [preguntas frecuentes de verificación de Android](https://developer.android.com/developer-verification/guides/faq) y el [anuncio de Google](https://developer.android.com/blog/posts/android-developer-verification-building-a-safer-ecosystem-together?hl=es-419).

## Cargar el programa del barco

Esto se hace desde una computadora con Arduino IDE y conectada al Arduino por USB:

1. Abre **Releases** y descarga `Barco-Firmware-v1.0.2.zip` de la misma versión.
2. Extrae el ZIP y abre `barco_control/barco_control.ino` con Arduino IDE.
3. Conecta el Arduino, selecciona **Arduino Uno** y el puerto que aparece, y pulsa **Subir** (flecha hacia la derecha).
