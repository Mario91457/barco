BARCO — adaptación de Bluetooth para Capacitor 8

QUÉ INCLUYE
- src/index.html: interfaz HTML/CSS original.
- src/main.js: eventos de sliders/botones y API actualizada de BluetoothSerial.
- vite.config.js: compila la app en www/, la carpeta configurada como webDir.
- package.json: reemplaza el paquete Git antiguo por @ascentio-it/capacitor-bluetooth-serial 8.x.

CÓMO APLICARLO
1. Haz una copia de seguridad de tu proyecto y del AndroidManifest.xml.
2. Copia la carpeta src/ y vite.config.js a la raíz de tu proyecto. Reemplaza package.json y capacitor.config.json con los incluidos.
3. En una terminal situada en la raíz del proyecto ejecuta:
   npm install
   npm run build
   npx cap sync android
   npx cap open android
4. En Android Studio, sincroniza Gradle si te lo solicita y ejecuta la app en el teléfono.
5. En Android, concede el permiso de Dispositivos cercanos/Bluetooth cuando lo solicite.
6. Empareja el HC-06 desde los Ajustes de Android. Luego abre Barco > Conectar > Actualizar y selecciona el HC-06.

COMPILACIÓN AUTOMÁTICA AL EDITAR
- En la raíz del proyecto ejecuta: npm run watch:android
- El observador compila al arrancar y vuelve a compilar cuando detecta cambios dentro de src/.
- Cada ciclo ejecuta npm run build, npx cap sync android y gradlew assembleDebug.
- El APK de depuración queda en android/app/build/outputs/apk/debug/app-debug.apk.
- Deja esa ventana abierta mientras editas; Ctrl+C detiene el observador. Si una compilación falla, el observador sigue activo y reintenta tras el siguiente cambio.

IMPORTANTE
- La carpeta www/ es generada por npm run build. Edita src/index.html y src/main.js, no el archivo construido dentro de www/.
- Este ZIP no incluye tu carpeta android/ ni tu AndroidManifest.xml; conserva los del proyecto existente. El manifest que mostraste ya declara BLUETOOTH_CONNECT.
- No se ha podido probar con tu teléfono ni con el HC-06 físico. El JavaScript y la configuración se han revisado estáticamente; primero haz una compilación de prueba y revisa Logcat si aparece un error nativo.
