import { Capacitor } from '@capacitor/core';
import { BluetoothSerial } from '@ascentio-it/capacitor-bluetooth-serial';
import { crearRumboBote, crearVelocimetroNudos, crearHorizonteArcade } from './instrumentos.js';
/**
 * Controlador de la interfaz del barco RC.
 * - Mantiene los estados Simple/Avanzado y la configuración local.
 * - Serializa los comandos de Bluetooth para evitar que se mezclen líneas.
 * - Recibe un paquete combinado de yaw, pitch, roll y velocidad estimada, bajo demanda.
 * - El Arduino conserva el failsafe físico si dejan de llegar comandos de control.
 */
(() => {
    'use strict';
    /*
     * El control se envía app -> Arduino; la telemetría de retorno se activa bajo demanda.
     * SIMPLE: F avanza, S detiene, L/G giran a babor y R/H a estribor; los giros aplican potencia fija.
     * AVANZADO: P<potencia>\n y D<angulo>\n. En crucero, HOLD captura el yaw al soltar el timón.
     * Telemetría combinada: T,yaw,pitch,roll,velocidad_en_décimas_de_m_s\n.
     * Se transmite un solo paquete a un máximo de 4 Hz. La velocidad y pitch/roll son estimaciones inerciales.
     */
    /** Valores por defecto alineados con el firmware Arduino. */
    const DEFAULTS = {
        maxPower: 20,
        minStart: 3,
        angLeft: 130,
        angCenter: 90,
        angRight: 70,
        throttleSpring: true, // Por seguridad, el acelerador avanzado vuelve a cero al soltar.
        pidP: 2.0, pidI: 0.0, pidD: 0.4
    };
    const STORAGE_KEY = 'barco.cfg.v2';
    const LIMITES = {
        maxPower: [1, 180], minStart: [0, 179],
        angLeft: [0, 180], angCenter: [0, 180], angRight: [0, 180]
    };
    const SEND_MIN_MS = 90; // limita el número de comandos mientras se arrastran sliders
    const REFRESH_ACTIVE_MS = 750; // margen inferior al failsafe de 1600 ms del firmware
    const POLL_MS = 35;
    const YAW_READ_POLL_MS = 100;       // Solo consulta el buffer local si las notificaciones no están disponibles
    const TELEMETRY_STALE_MS = 1800;   // Paquete combinado: latido cada 1 s
    const SPEED_GAUGE_MAX_MPS = 5.0;    // Máximo aceptado: 5 m/s, expresado por el firmware en décimas
    const KNOTS_PER_MPS = 1.943844;     // 1 m/s = 1,943844 nudos
    const SPEED_GAUGE_MAX_KT = 10;      // Escala del velocímetro: 5 m/s ≈ 9,7 kt
    const YAW_MAX_REQUEST_RETRIES = 8;  // Cubre el armado/calibración inicial bloqueante del firmware
    const $ = s => document.querySelector(s);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // Instrumentos SVG (src/instrumentos.js). El rumbo crea #boatCompass y #casco; el anillo con
    // números queda fijo y solo gira el bote. Los cuatro instrumentos vienen del paquete T combinado.
    crearRumboBote($('#instRumbo'));
    const velocimetro = crearVelocimetroNudos($('#instNudos'), { maxKt: SPEED_GAUGE_MAX_KT });
    const horizonte = crearHorizonteArcade($('#instActitud'));

    /** Abre un dialogo centrado y enfoca su titulo para no abrir el teclado movil. */
    function abrirDialogo(selector) {
        const dialog = $(selector);
        if (!dialog.open)
            dialog.showModal();
        dialog.querySelector('[data-dialog-focus]')?.focus({ preventScroll: true });
    }
    const cfg = { ...DEFAULTS };
    try {
        const guardada = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        for (const clave of Object.keys(DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(guardada, clave))
                cfg[clave] = guardada[clave];
        }
    }
    catch { }
    const BT = Capacitor.isNativePlatform() ? BluetoothSerial : null;
    let modo = 'avanzado';
    let conectado = false;
    let nombre = '';
    let direccionActual = '';
    let desconectando = false;
    let ultimaDireccionEnviada = null;
    let ultimaPotenciaEnviada = null;
    let ultimoEnvio = 0;
    let simpleAceleradorActivo = false;
    let simpleDireccionActiva = ''; // L o R en protocolo heredado; también accionan el motor
    let ultimoEnvioAceleradorSimple = 0;
    let ultimoEnvioDireccionSimple = 0;
    let prioridadDireccion = true;
    let colaEnvio = Promise.resolve();
    let enviosPendientes = 0;
    let pidActivo = false;
    let cruceroActivo = false;
    let lectorYawHandle = null;
    let notificacionesYawActivas = false;
    let recepcionYawSolicitada = false;
    let bufferYaw = '';
    let yawActual = null; // yaw integrado real recibido del Arduino; no se modifica al poner cero visual
    let velocidadEstimadaMps = null; // Estimación inercial, no una velocidad real calibrada
    let yawOffsetVisual = 0;
    let ceroVisualPendiente = false;
    let anguloManualVisualCero = 0;
    let ultimaTelemetriaYawMs = 0;
    let paqueteTelemetriaRecibido = false;
    let intentosSolicitudYaw = 0;
    let ultimoComandoYawMs = 0;
    const guardar = () => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        }
        catch { }
    };
    /** Serializa escrituras para impedir que dos gestos mezclen bytes de comandos. */
    function enviarLinea(linea, address = direccionActual) {
        enviosPendientes++;
        const ejecutar = async () => {
            if (!BT) {
                console.log('[Bluetooth simulador -> barco]', JSON.stringify(linea));
                return true;
            }
            if (!address)
                return false;
            try {
                await BT.write({ address, value: linea });
                return true;
            }
            catch (e) {
                console.error('Error enviando comando Bluetooth:', e);
                return false;
            }
        };
        const tarea = colaEnvio.then(ejecutar, ejecutar);
        colaEnvio = tarea.then(() => undefined, () => undefined);
        return tarea.finally(() => { enviosPendientes = Math.max(0, enviosPendientes - 1); });
    }
    /** ---------- Sliders del modo Avanzado: cada control rastrea su puntero ---------- */
    function crearSlider(el, { origen, snap = 0, volver, alSoltar = null }) {
        let t = origen;
        let pointerActivo = null;
        const raiz = el.closest('.dial');
        const vertical = el.classList.contains('v');
        const dibujar = () => raiz.style.setProperty('--t', t);
        const leer = e => {
            const r = el.getBoundingClientRect();
            const thumb = el.querySelector('.thumb').getBoundingClientRect();
            const pad = (vertical ? thumb.height : thumb.width) / 2;
            const pos = vertical ? r.bottom - e.clientY : e.clientX - r.left;
            const largo = Math.max(1, (vertical ? r.height : r.width) - 2 * pad);
            return clamp((pos - pad) / largo, 0, 1);
        };
        const poner = v => {
            t = Math.abs(v - origen) < snap ? origen : clamp(v, 0, 1);
            dibujar();
            pintar();
        };
        const soltar = () => {
            if (volver())
                poner(origen);
        };
        el.addEventListener('pointerdown', e => {
            if (pointerActivo !== null || (e.pointerType === 'mouse' && e.button !== 0))
                return;
            pointerActivo = e.pointerId;
            try {
                el.setPointerCapture(e.pointerId);
            }
            catch { }
            e.preventDefault();
            poner(leer(e));
        });
        el.addEventListener('pointermove', e => {
            if (e.pointerId !== pointerActivo)
                return;
            e.preventDefault();
            poner(leer(e));
        });
        const fin = e => {
            if (e.pointerId !== pointerActivo)
                return;
            pointerActivo = null;
            const posicionFinal = t;
            soltar();
            if (typeof alSoltar === 'function')
                void alSoltar(posicionFinal);
        };
        el.addEventListener('pointerup', fin);
        el.addEventListener('pointercancel', fin);
        el.addEventListener('lostpointercapture', fin);
        dibujar();
        return { poner, valor: () => t };
    }
    /** Convierte una posición del slider en el ángulo calibrado del servo. */
    function direccionDesdePosicion(t) {
        if (t < 0.5) {
            const fraccion = (0.5 - t) * 2;
            return clamp(Math.round(cfg.angCenter + (cfg.angLeft - cfg.angCenter) * fraccion), 0, 180);
        }
        const fraccion = (t - 0.5) * 2;
        return clamp(Math.round(cfg.angCenter + (cfg.angRight - cfg.angCenter) * fraccion), 0, 180);
    }
    /** Al soltar el timón en crucero: termina el giro manual y captura el yaw actual. */
    async function soltarDireccionEnCrucero(posicionFinal) {
        if (modo !== 'avanzado' || !conectado || !cruceroActivo)
            return;
        const direccionFinal = direccionDesdePosicion(posicionFinal);
        const okDireccion = await enviarLinea(`D${direccionFinal}\n`);
        if (!okDireccion) {
            perderConexion();
            return;
        }
        const okHold = await enviarLinea('HOLD\n');
        if (!okHold) {
            perderConexion();
            return;
        }
        // El slider visual ya ha vuelto al centro. Evita que el bucle emita D90
        // después de HOLD y vuelva a activar accidentalmente el modo manual.
        ultimaDireccionEnviada = cfg.angCenter;
        ultimoEnvio = Date.now();
        aviso('Crucero: nuevo rumbo capturado.');
    }
    const acel = crearSlider($('#thr'), { origen: 0, volver: () => cfg.throttleSpring });
    const timon = crearSlider($('#str'), {
        origen: 0.5, snap: 0.03, volver: () => true, alSoltar: soltarDireccionEnCrucero
    });
    /** Convierte las posiciones actuales de ambos controles en comandos. */
    function valoresAvanzados() {
        const direccion = direccionDesdePosicion(timon.valor());
        const acelerador = acel.valor();
        const piso = Math.min(cfg.minStart, cfg.maxPower);
        const potencia = acelerador <= 0 ? 0 : clamp(Math.round(piso + (cfg.maxPower - piso) * acelerador), 0, 180);
        return { direccion, potencia };
    }
    const GIRO_VISUAL_MAX = 28; // grados visuales simétricos; no altera la calibración del servo
    function anguloVisualSimple() {
        if (simpleDireccionActiva === 'L')
            return -GIRO_VISUAL_MAX; // babor: proa hacia la izquierda
        if (simpleDireccionActiva === 'R')
            return GIRO_VISUAL_MAX; // estribor: proa hacia la derecha
        return 0;
    }
    function anguloVisualAvanzado() {
        // La posición del slider determina el giro visual. No se usan los ángulos de
        // calibración del servo (130/90/70), porque no son simétricos alrededor del centro.
        return Math.round((timon.valor() - 0.5) * 2 * GIRO_VISUAL_MAX);
    }
    function normalizarAngulo(angulo) {
        return ((angulo + 180) % 360 + 360) % 360 - 180;
    }
    function anguloYawVisual() {
        return yawActual === null ? null : normalizarAngulo(yawActual - yawOffsetVisual);
    }
    function actualizarOrientacionBote(anguloVisual) {
        // El offset solo pertenece a la interfaz: nunca se envía al Arduino ni
        // modifica rumboObjetivo del PID. Al perder la telemetría se usa el mando.
        const yawFresco = yawActual !== null &&
            (Date.now() - ultimaTelemetriaYawMs) <= TELEMETRY_STALE_MS;
        const angulo = yawFresco
            ? anguloYawVisual()
            : normalizarAngulo(anguloVisual - anguloManualVisualCero);
        $('#casco').setAttribute('transform', `rotate(${angulo})`);
    }
    function pintarYaw(yaw) {
        if (ceroVisualPendiente) {
            yawOffsetVisual = yaw;
            ceroVisualPendiente = false;
        }
        yawActual = yaw;
        ultimaTelemetriaYawMs = Date.now();
        const yawVisible = anguloYawVisual();
        $('#yawValue').textContent = `${yawVisible > 0 ? '+' : ''}${yawVisible}°`;
        $('#yawStatus').textContent = 'MPU activo';
        $('#yawStatus').classList.add('online');
        actualizarOrientacionBote(modo === 'simple' ? anguloVisualSimple() : anguloVisualAvanzado());
    }
    function ponerCeroVisual() {
        // Es un cero exclusivamente visual: no manda comandos ni altera el PID.
        const mandoVisual = modo === 'simple' ? anguloVisualSimple() : anguloVisualAvanzado();
        anguloManualVisualCero = mandoVisual;
        if (yawActual !== null) {
            yawOffsetVisual = yawActual;
            ceroVisualPendiente = false;
            const valor = anguloYawVisual();
            $('#yawValue').textContent = `${valor > 0 ? '+' : ''}${valor}°`;
        }
        else {
            ceroVisualPendiente = true;
            $('#yawValue').textContent = '0°';
        }
        actualizarOrientacionBote(mandoVisual);
        aviso('Cero visual restablecido; el rumbo del Arduino no cambió.');
    }
    $('#boatCompass').addEventListener('click', ponerCeroVisual);
    $('#boatCompass').addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ponerCeroVisual();
        }
    });
    function limpiarYaw(estado = 'Sin conexión') {
        yawActual = null;
        ultimaTelemetriaYawMs = 0;
        $('#yawValue').textContent = '—°';
        $('#yawStatus').textContent = estado;
        $('#yawStatus').classList.remove('online');
        actualizarOrientacionBote(modo === 'simple' ? anguloVisualSimple() : anguloVisualAvanzado());
    }
    function pintarVelocidad(velocidadMps) {
        velocidadEstimadaMps = clamp(velocidadMps, 0, SPEED_GAUGE_MAX_MPS);
        const nudos = velocidadEstimadaMps * KNOTS_PER_MPS;
        $('#speedValue').textContent = `${nudos.toFixed(1)} kt`;
        $('#speedStatus').textContent = 'Estimación MPU';
        $('#speedStatus').classList.add('online');
        velocimetro.update(nudos);
    }
    function limpiarVelocidad(estado = 'Sin datos') {
        velocidadEstimadaMps = null;
        $('#speedValue').textContent = '— kt';
        $('#speedStatus').textContent = estado;
        $('#speedStatus').classList.remove('online');
        velocimetro.update(0);
    }
    function pintarActitud(pitch, roll) {
        horizonte.update({ pitch, roll });
        const signo = n => n > 0 ? '+' : '';
        $('#attValue').textContent = `P ${signo(pitch)}${pitch}° R ${signo(roll)}${roll}°`;
        $('#attStatus').textContent = 'MPU · actitud estimada';
        $('#attStatus').classList.add('online');
    }
    function limpiarActitud(estado = 'Sin datos') {
        horizonte.update({ pitch: 0, roll: 0 }, true);
        $('#attValue').textContent = 'P —° R —°';
        $('#attStatus').textContent = estado;
        $('#attStatus').classList.remove('online');
    }
    function procesarLineaTelemetria(valor) {
        const linea = String(valor ?? '').trim();
        // Paquete único: T,yaw,pitch,roll,velocidad en décimas de m/s.
        // Ejemplo: T,-12,4,-7,12 = yaw -12°, pitch 4°, roll -7°, velocidad 1.2 m/s.
        const paquete = /^T,(-?\d{1,3}),(-?\d{1,2}),(-?\d{1,3}),(\d{1,2})$/.exec(linea);
        if (paquete) {
            const [yaw, pitch, roll, velocidadDecimas] = paquete.slice(1).map(Number);
            if (Number.isInteger(yaw) && yaw >= -180 && yaw <= 180 &&
                Number.isInteger(pitch) && pitch >= -90 && pitch <= 90 &&
                Number.isInteger(roll) && roll >= -180 && roll <= 180 &&
                Number.isInteger(velocidadDecimas) && velocidadDecimas >= 0 && velocidadDecimas <= 50) {
                pintarYaw(yaw);
                pintarActitud(pitch, roll);
                pintarVelocidad(velocidadDecimas / 10);
                paqueteTelemetriaRecibido = true;
            }
            return;
        }
    }
    function recibirTelemetriaYaw(texto) {
        if (typeof texto !== 'string' || texto.length === 0)
            return;
        bufferYaw += texto;
        const lineas = bufferYaw.split(/[\r\n]+/);
        bufferYaw = lineas.pop() ?? '';
        for (const linea of lineas)
            procesarLineaTelemetria(linea);
        // Algunas versiones del plugin entregan una sola línea sin terminador.
        if (/^T,-?\d{1,3},-?\d{1,2},-?\d{1,3},\d{1,2}$/.test(bufferYaw.trim())) {
            procesarLineaTelemetria(bufferYaw);
            bufferYaw = '';
        }
        if (bufferYaw.length > 32)
            bufferYaw = '';
    }
    function valorEventoYaw(evento) {
        let valor = evento?.value ?? evento?.data ?? evento;
        if (valor && typeof valor === 'object')
            valor = valor.value ?? valor.data ?? '';
        return typeof valor === 'string' ? valor : '';
    }
    async function detenerRecepcionYaw(address = direccionActual, desactivarEnArduino = false) {
        recepcionYawSolicitada = false;
        if (desactivarEnArduino && conectado && address) {
            const ok = await enviarLinea('TEL,0\n', address);
            if (!ok) console.warn('No se pudo desactivar la telemetría en el Arduino.');
        }
        if (BT && address && notificacionesYawActivas) {
            try { await BT.stopNotifications({ address }); }
            catch (e) { console.warn('No se pudieron detener las notificaciones Bluetooth:', e); }
        }
        notificacionesYawActivas = false;
        if (lectorYawHandle) {
            try { await lectorYawHandle.remove(); } catch { }
            lectorYawHandle = null;
        }
        bufferYaw = '';
        paqueteTelemetriaRecibido = false;
        limpiarYaw(conectado ? 'Telemetría pausada' : 'Sin conexión');
        limpiarVelocidad(conectado ? 'Telemetría pausada' : 'Sin conexión');
        limpiarActitud(conectado ? 'Telemetría pausada' : 'Sin conexión');
    }
    async function iniciarRecepcionYaw(address = direccionActual) {
        if (!conectado || !address || !BT) {
            limpiarYaw(BT ? 'Sin conexión' : 'Sin Bluetooth en simulador');
            return;
        }
        await detenerRecepcionYaw(address, false);
        recepcionYawSolicitada = true;
        paqueteTelemetriaRecibido = false;
        intentosSolicitudYaw = 0;
        limpiarYaw('Esperando telemetría…');
        limpiarVelocidad('Esperando MPU…');
        limpiarActitud('Esperando MPU…');
        try {
            lectorYawHandle = await BT.addListener('onRead', evento => recibirTelemetriaYaw(valorEventoYaw(evento)));
            await BT.startNotifications({ address, delimiter: '\n' });
            notificacionesYawActivas = true;
        }
        catch (e) {
            notificacionesYawActivas = false;
            if (lectorYawHandle) {
                try { await lectorYawHandle.remove(); } catch { }
                lectorYawHandle = null;
            }
            console.warn('Notificaciones Bluetooth no disponibles; se usará lectura periódica:', e);
        }
        const ok = await enviarLinea('TEL,1\n', address);
        if (ok) {
            intentosSolicitudYaw = 1;
            ultimoComandoYawMs = Date.now();
        }
        if (!ok) {
            recepcionYawSolicitada = false;
            perderConexion();
            return;
        }
    }
    // El canal serie entrega paquetes de telemetría; la consulta es solo un fallback.
    let leyendoYaw = false;
    setInterval(async () => {
        if (!BT || !conectado || !direccionActual || !recepcionYawSolicitada ||
            notificacionesYawActivas || leyendoYaw)
            return;
        leyendoYaw = true;
        try {
            const resultado = await BT.read({ address: direccionActual });
            const datos = resultado?.data ?? resultado?.value ?? '';
            if (datos)
                recibirTelemetriaYaw(typeof datos === 'string' ? datos : String(datos));
        }
        catch (e) {
            console.warn('Error leyendo telemetría yaw:', e);
        }
        finally {
            leyendoYaw = false;
        }
    }, YAW_READ_POLL_MS);
    setInterval(() => {
        if (!recepcionYawSolicitada || !conectado)
            return;
        const ahora = Date.now();
        if (ultimaTelemetriaYawMs && ahora - ultimaTelemetriaYawMs > TELEMETRY_STALE_MS) {
            limpiarYaw('Telemetría interrumpida');
            limpiarVelocidad('Telemetría interrumpida');
            limpiarActitud('Telemetría interrumpida');
            paqueteTelemetriaRecibido = false;
        }
        // Si el firmware estaba armando/calibrando al conectar, reintenta pocos veces.
        if (!paqueteTelemetriaRecibido && intentosSolicitudYaw < YAW_MAX_REQUEST_RETRIES &&
            ahora - ultimoComandoYawMs >= 1600) {
            intentosSolicitudYaw++;
            ultimoComandoYawMs = ahora;
            void enviarLinea('TEL,1\n').then(ok => { if (!ok) perderConexion(); });
        }
        if (!paqueteTelemetriaRecibido && intentosSolicitudYaw >= YAW_MAX_REQUEST_RETRIES &&
            ahora - ultimoComandoYawMs >= TELEMETRY_STALE_MS) {
            $('#yawStatus').textContent = 'Sin datos del MPU';
            $('#yawStatus').classList.remove('online');
            $('#speedStatus').textContent = 'Sin datos del MPU';
            $('#speedStatus').classList.remove('online');
            $('#attStatus').textContent = 'Sin datos del MPU';
            $('#attStatus').classList.remove('online');
        }
    }, 500);
    function pintar() {
        const { direccion, potencia } = valoresAvanzados();
        const velocidadSolicitada = Math.round(acel.valor() * 100);
        $('#thrPct').textContent = `${velocidadSolicitada}%`;
        $('#thrPot').textContent = `pot. ${potencia}`;
        $('#strAng').textContent = `${direccion}°`;
        // El velocímetro se actualiza con la velocidad estimada incluida en el paquete T del MPU.
        actualizarOrientacionBote(modo === 'simple' ? anguloVisualSimple() : anguloVisualAvanzado());
        $('#btnPID').classList.toggle('active', pidActivo);
        $('#btnPID').textContent = `PID: ${pidActivo ? 'ACTIVADO' : 'DESACTIVADO'}`;
        $('#btnPID').setAttribute('aria-pressed', String(pidActivo));
        $('#btnPID').disabled = (modo === 'simple');
        $('#btnCrucero').classList.toggle('active', cruceroActivo);
        $('#btnCrucero').textContent = `Crucero: ${cruceroActivo ? 'ACTIVADO' : 'DESACTIVADO'}`;
        $('#btnCrucero').setAttribute('aria-pressed', String(cruceroActivo));
        $('#btnCrucero').disabled = (modo === 'simple') || !pidActivo;
    }
    function aviso(texto) {
        $('#aviso').textContent = texto;
        clearTimeout(aviso.timer);
        aviso.timer = setTimeout(() => { $('#aviso').textContent = ''; }, 4000);
    }
    function pintarEstado(texto) {
        $('#estado').classList.toggle('on', conectado);
        $('#estadoTxt').textContent = texto ?? (conectado ? `Conectado a ${nombre}` : 'Sin conexión');
        $('#btnConectar').textContent = conectado ? 'Desconectar' : 'Conectar';
    }
    function reiniciarSeguimientoAvanzado() {
        ultimaDireccionEnviada = null;
        ultimaPotenciaEnviada = null;
        ultimoEnvio = 0;
    }
    async function pararLocalYEnviar() {
        simpleAceleradorActivo = false;
        simpleDireccionActiva = '';
        acel.poner(0);
        timon.poner(0.5);
        pintar();
        if (conectado) {
            const okS = await enviarLinea('S\n');
            if (!okS) {
                perderConexion();
                return;
            }
            if (modo !== 'simple') {
                const okC = await enviarLinea('C\n');
                if (!okC) {
                    perderConexion();
                    return;
                }
                if (cruceroActivo) {
                    const okHold = await enviarLinea('HOLD\n');
                    if (!okHold) {
                        perderConexion();
                        return;
                    }
                }
            }
            ultimaPotenciaEnviada = 0;
            ultimaDireccionEnviada = cfg.angCenter;
            ultimoEnvio = Date.now();
        }
    }
    function perderConexion() {
        const address = direccionActual;
        conectado = false;
        nombre = '';
        direccionActual = '';
        pidActivo = false;
        cruceroActivo = false;
        pintar();
        simpleAceleradorActivo = false;
        simpleDireccionActiva = '';
        reiniciarSeguimientoAvanzado();
        acel.poner(0);
        timon.poner(0.5);
        pintarEstado('Conexión perdida; se activará el paro de seguridad del Arduino');
        limpiarYaw('Conexión perdida');
        limpiarVelocidad('Conexión perdida');
        limpiarActitud('Conexión perdida');
        aviso('Se perdió la conexión Bluetooth. Vuelve a conectar.');
        void detenerRecepcionYaw(address, false);
        if (BT && address)
            void BT.disconnect({ address }).catch(() => { });
    }
    /**
     * Lazo de control periódico. Limita la frecuencia de escrituras y refresca
     * las órdenes activas antes de que venza el failsafe de 1600 ms del Arduino.
     * El firmware conserva la última barrera de seguridad si la app pierde conexión.
     */
    setInterval(async () => {
        if (!conectado || desconectando || enviosPendientes > 0)
            return;
        const ahora = Date.now();
        if (modo === 'simple') {
            // El firmware Simple heredado utiliza un único carácter por estado.
            // Mientras se gira, L/R tienen prioridad; F no debe recentrar el timón.
            if (simpleDireccionActiva && ahora - ultimoEnvioDireccionSimple >= REFRESH_ACTIVE_MS) {
                const cmd = simpleDireccionActiva === 'L' ? 'G' : 'H'; // Compatibilidad con el firmware Simple clásico
                const ok = await enviarLinea(`${cmd}\n`);
                if (!ok) {
                    perderConexion();
                    return;
                }
                // simpleDireccionActiva conserva L/R; cmd puede ser su alias G/H.
                if (simpleDireccionActiva)
                    ultimoEnvioDireccionSimple = Date.now();
            } else if (!simpleDireccionActiva && simpleAceleradorActivo &&
                ahora - ultimoEnvioAceleradorSimple >= REFRESH_ACTIVE_MS) {
                const ok = await enviarLinea('F\n');
                if (!ok) {
                    perderConexion();
                    return;
                }
                ultimoEnvioAceleradorSimple = Date.now();
            }
            return;
        }
        const actual = valoresAvanzados();
        const cambioD = actual.direccion !== ultimaDireccionEnviada;
        const cambioP = actual.potencia !== ultimaPotenciaEnviada;
        if (ahora - ultimoEnvio < SEND_MIN_MS)
            return;
        let linea = '';
        let tipo = '';
        if (cambioD && cambioP) {
            if (prioridadDireccion) {
                linea = `D${actual.direccion}\n`;
                tipo = 'D';
            }
            else {
                linea = `P${actual.potencia}\n`;
                tipo = 'P';
            }
            prioridadDireccion = !prioridadDireccion;
        }
        else if (cambioD) {
            linea = `D${actual.direccion}\n`;
            tipo = 'D';
        }
        else if (cambioP) {
            linea = `P${actual.potencia}\n`;
            tipo = 'P';
        }
        else if (ahora - ultimoEnvio >= REFRESH_ACTIVE_MS) {
            if (actual.potencia > 0) {
                linea = `P${actual.potencia}\n`;
                tipo = 'P';
            }
            else if (actual.direccion !== cfg.angCenter) {
                linea = `D${actual.direccion}\n`;
                tipo = 'D';
            }
        }
        if (!linea)
            return;
        const ok = await enviarLinea(linea);
        if (!ok) {
            perderConexion();
            return;
        }
        ultimoEnvio = Date.now();
        if (tipo === 'D')
            ultimaDireccionEnviada = actual.direccion;
        if (tipo === 'P')
            ultimaPotenciaEnviada = actual.potencia;
    }, POLL_MS);
    /* ---------- Cambiar de modo ---------- */
    async function cambiarModo() {
        const siguienteModo = modo === 'avanzado' ? 'simple' : 'avanzado';
        if (siguienteModo === 'simple' && conectado && (cruceroActivo || pidActivo)) {
            // El protocolo anterior no entiende PID/CRU; apagarlos al entrar en Simple.
            await enviarLinea('CRU,0\n');
            await enviarLinea('PID,0\n');
            pidActivo = false;
            cruceroActivo = false;
            pintar();
        }
        await pararLocalYEnviar();
        modo = siguienteModo;
        $('main').classList.toggle('modo-simple', modo === 'simple');
        if (modo === 'avanzado' && conectado) {
            // C es ignorado por el firmware antiguo, pero centra el timón en el firmware nuevo.
            await enviarLinea('C\n');
        }
        $('#btnModo').textContent = modo === 'simple' ? 'Cambiar a Avanzado' : 'Cambiar a Simple';
        $('#controlHint').innerHTML = modo === 'simple'
            ? 'Modo Simple<br><small>F/S/L/G/R/H; girar también activa el motor</small>'
            : 'Modo Avanzado<br><small>Desliza para ajustar potencia y dirección</small>';
        reiniciarSeguimientoAvanzado();
        pintar();
        if (conectado) {
            ultimaPotenciaEnviada = 0;
            ultimaDireccionEnviada = cfg.angCenter;
            ultimoEnvio = Date.now();
        }
    }
    $('#btnModo').addEventListener('click', () => { void cambiarModo(); });
    // Control de rumbo: solo comandos app -> Arduino; nunca se espera telemetría.
    $('#btnPID').addEventListener('click', async () => {
        if (modo === 'simple') {
            aviso('PID solo está disponible en el modo Avanzado.');
            return;
        }
        if (!conectado) {
            aviso('Conecta el HC-06 antes de cambiar el PID.');
            return;
        }
        pidActivo = !pidActivo;
        if (!pidActivo)
            cruceroActivo = false;
        pintar();
        const ok = await enviarLinea(`PID,${pidActivo ? 1 : 0}\n`);
        if (!ok) {
            perderConexion();
            return;
        }
        if (pidActivo) {
            await enviarLinea(`KP,${cfg.pidP}\n`);
            await enviarLinea(`KI,${cfg.pidI}\n`);
            await enviarLinea(`KD,${cfg.pidD}\n`);
            aviso('PID activado. El rumbo es relativo y puede derivar.');
        }
        else {
            await enviarLinea('CRU,0\n');
            aviso('PID desactivado; dirección manual.');
        }
    });
    $('#btnCrucero').addEventListener('click', async () => {
        if (modo === 'simple') {
            aviso('Crucero solo está disponible en el modo Avanzado.');
            return;
        }
        if (!conectado) {
            aviso('Conecta el HC-06 primero.');
            return;
        }
        if (!pidActivo) {
            aviso('Activa el PID antes del modo crucero.');
            return;
        }
        cruceroActivo = !cruceroActivo;
        pintar();
        const ok = await enviarLinea(`CRU,${cruceroActivo ? 1 : 0}\n`);
        if (!ok) {
            perderConexion();
            return;
        }
        aviso(cruceroActivo ? 'Crucero activado: mantendrá el rumbo integrado actual.' : 'Crucero desactivado.');
    });
    $('#btnCalibrar').addEventListener('click', async () => {
        if (!conectado) {
            aviso('Conecta el HC-06 antes de calibrar.');
            return;
        }
        const ok = await enviarLinea('CAL\n');
        if (!ok) {
            perderConexion();
            return;
        }
        aviso('Calibración solicitada. Mantén el barco completamente inmóvil unos segundos.');
    });
    /* ---------- Controles del modo Simple: velocidad y dirección independientes ---------- */
    function validarModoSimpleConectado() {
        if (modo !== 'simple')
            return false;
        if (!conectado) {
            aviso('Conecta el HC-06 antes de controlar el barco.');
            return false;
        }
        return true;
    }
    let simpleStopLatch = false;
    function detenerSimplePorOrden() {
        simpleStopLatch = true;
        simpleAceleradorActivo = false;
        simpleDireccionActiva = '';
        pintar();
        if (conectado) {
            void enviarLinea('S\n').then(ok => { if (!ok) perderConexion(); });
        }
    }
    $('#simpleDecelerate').addEventListener('click', detenerSimplePorOrden);

    function vincularAceleradorSimple(el) {
        let pointerId = null;
        const comenzar = e => {
            if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0))
                return;
            if (!validarModoSimpleConectado())
                return;
            e.preventDefault();
            simpleStopLatch = false;
            pointerId = e.pointerId;
            try {
                el.setPointerCapture(e.pointerId);
            }
            catch { }
            simpleAceleradorActivo = true;
            ultimoEnvioAceleradorSimple = Date.now();
            void (async () => {
                const ok = await enviarLinea('F\n');
                if (!ok) {
                    perderConexion();
                    return;
                }
                if (simpleAceleradorActivo)
                    ultimoEnvioAceleradorSimple = Date.now();
            })();
        };
        const soltar = async (e) => {
            if (pointerId === null || (e && e.pointerId !== pointerId))
                return;
            pointerId = null;
            if (simpleStopLatch) return;
            simpleAceleradorActivo = false;
            if (!conectado || simpleDireccionActiva)
                return; // El giro sigue activo y mantiene el motor a potencia fija.
            const ok = await enviarLinea('S\n');
            if (!ok) {
                perderConexion();
                return;
            }
            ultimoEnvio = Date.now();
            ultimaPotenciaEnviada = 0;
        };
        el.addEventListener('pointerdown', comenzar);
        el.addEventListener('pointerup', e => { void soltar(e); });
        el.addEventListener('pointercancel', e => { void soltar(e); });
        el.addEventListener('lostpointercapture', e => { void soltar(e); });
    }
    function vincularDireccionSimple(el, comando) {
        let pointerId = null;
        const comenzar = e => {
            if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0))
                return;
            if (!validarModoSimpleConectado())
                return;
            e.preventDefault();
            simpleStopLatch = false;
            pointerId = e.pointerId;
            try {
                el.setPointerCapture(e.pointerId);
            }
            catch { }
            simpleDireccionActiva = comando;
            ultimoEnvioDireccionSimple = Date.now();
            pintar();
            void (async () => {
                const ok = await enviarLinea(`${comando}\n`);
                if (!ok) {
                    perderConexion();
                    return;
                }
                if (simpleDireccionActiva === comando)
                    ultimoEnvioDireccionSimple = Date.now();
            })();
        };
        const soltar = async (e) => {
            if (pointerId === null || (e && e.pointerId !== pointerId))
                return;
            pointerId = null;
            // Si otra dirección ya fue seleccionada, no la sobrescribas al soltar este dedo.
            if (simpleStopLatch || simpleDireccionActiva !== comando)
                return;
            simpleDireccionActiva = '';
            pintar();
            if (!conectado)
                return;
            // El firmware heredado no tiene C ni HOLD: F recentra si el acelerador sigue
            // pulsado; de lo contrario S apaga el motor y deja el servo donde está.
            const siguiente = simpleAceleradorActivo ? 'F' : 'S';
            const ok = await enviarLinea(`${siguiente}\n`);
            if (!ok) {
                perderConexion();
                return;
            }
            if (siguiente === 'F') ultimoEnvioAceleradorSimple = Date.now();
        };
        el.addEventListener('pointerdown', comenzar);
        el.addEventListener('pointerup', e => { void soltar(e); });
        el.addEventListener('pointercancel', e => { void soltar(e); });
        el.addEventListener('lostpointercapture', e => { void soltar(e); });
    }
    vincularAceleradorSimple($('#simpleForward'));
    vincularDireccionSimple($('#simpleLeft'), 'L'); // Se traduce a G en el protocolo heredado
    vincularDireccionSimple($('#simpleRight'), 'R'); // Se traduce a H en el protocolo heredado
    // #simpleDecelerate es intencionalmente decorativo: no tiene listener ni envía órdenes.
    /** ---------- Emparejamiento y conexión Bluetooth serie ---------- */
    async function abrirDispositivos() {
        if (conectado) {
            desconectando = true;
            const address = direccionActual;
            try {
                if (cruceroActivo && modo !== 'simple')
                    await enviarLinea('CRU,0\n', address);
                await enviarLinea('S\n', address);
                if (modo !== 'simple') await enviarLinea('C\n', address);
                await detenerRecepcionYaw(address, true);
                if (BT && address)
                    await BT.disconnect({ address });
            }
            catch (e) {
                console.warn('Error durante la desconexión:', e);
            }
            finally {
                conectado = false;
                nombre = '';
                direccionActual = '';
                simpleAceleradorActivo = false;
                simpleDireccionActiva = '';
                pidActivo = false;
                cruceroActivo = false;
                desconectando = false;
                reiniciarSeguimientoAvanzado();
                acel.poner(0);
                timon.poner(0.5);
                pintar();
                limpiarYaw('Sin conexión');
                limpiarVelocidad('Sin conexión');
                pintarEstado();
            }
            return;
        }
        if (!BT) {
            conectado = true;
            nombre = 'simulador';
            direccionActual = '';
            reiniciarSeguimientoAvanzado();
            pintarEstado();
            aviso('Simulador de PC: las órdenes se muestran en la consola, no controlan un barco real.');
            return;
        }
        abrirDialogo('#dispositivos');
        $('#estadoLista').textContent = 'Buscando dispositivos emparejados…';
        $('#lista').textContent = 'Cargando…';
        await cargarDispositivos();
    }
    async function cargarDispositivos() {
        if (!BT)
            return;
        try {
            await BT.enable();
            const permisos = await BT.checkBluetoothPermissions();
            if (!permisos)
                throw new Error('Concede el permiso Dispositivos cercanos en Ajustes de Android.');
            const { enabled } = await BT.isEnabled();
            if (!enabled)
                throw new Error('Activa Bluetooth en el teléfono.');
            const resultado = await BT.getPairedDevices();
            const devices = resultado?.devices ?? resultado?.data ?? [];
            listar(Array.isArray(devices) ? devices : []);
        }
        catch (e) {
            $('#estadoLista').textContent = 'No se pudo cargar la lista';
            $('#lista').textContent = `Error de Bluetooth: ${e?.message ?? String(e)}`;
        }
    }
    function listar(devices) {
        const caja = $('#lista');
        caja.replaceChildren();
        $('#estadoLista').textContent = devices.length ? `${devices.length} dispositivo(s) emparejado(s)` : 'No se encontraron dispositivos emparejados';
        if (!devices.length) {
            const p = document.createElement('p');
            p.className = 'ayuda';
            p.textContent = 'Empareja el HC-06 desde Ajustes de Android y pulsa Actualizar.';
            caja.append(p);
            return;
        }
        for (const d of devices) {
            const address = d.address || d.id;
            if (!address)
                continue;
            const b = document.createElement('button');
            b.className = 'disp';
            b.type = 'button';
            const n = document.createElement('b');
            n.textContent = d.name || 'Dispositivo sin nombre';
            const a = document.createElement('small');
            a.textContent = address;
            b.append(n, a);
            b.addEventListener('click', () => void conectar({ ...d, address }));
            caja.append(b);
        }
    }
    async function conectar(d) {
        $('#dispositivos').close();
        pintarEstado(`Conectando a ${d.name || d.address}…`);
        try {
            try {
                await BT.connect({ address: d.address });
            }
            catch {
                await BT.connectInsecure({ address: d.address });
            }
            direccionActual = d.address;
            nombre = d.name || d.address;
            conectado = true;
            acel.poner(0);
            timon.poner(0.5);
            reiniciarSeguimientoAvanzado();
            ultimoEnvio = 0;
            simpleAceleradorActivo = false;
            simpleDireccionActiva = '';
            ultimoEnvioAceleradorSimple = Date.now();
            ultimoEnvioDireccionSimple = Date.now();
            pintarEstado();
            const ok = await enviarLinea('S\n');
            if (!ok) {
                perderConexion();
                return;
            }
            ultimaPotenciaEnviada = 0;
            ultimaDireccionEnviada = cfg.angCenter;
            ultimoEnvio = Date.now();
            pidActivo = false;
            cruceroActivo = false;
            pintar();
            if (modo !== 'simple') {
                const okCentro = await enviarLinea('C\n');
                if (!okCentro) {
                    perderConexion();
                    return;
                }
                await enviarLinea('PID,0\n');
                await enviarLinea('CRU,0\n');
                await enviarLinea(`KP,${cfg.pidP}\n`);
                await enviarLinea(`KI,${cfg.pidI}\n`);
                await enviarLinea(`KD,${cfg.pidD}\n`);
            }
            await iniciarRecepcionYaw(direccionActual);
            if (!conectado)
                return;
            aviso('Conectado. Telemetría yaw/velocidad solicitada; la velocidad es aproximada.');
        }
        catch (e) {
            conectado = false;
            nombre = '';
            direccionActual = '';
            pintarEstado('No se pudo conectar');
            aviso(`Error de conexión: ${e?.message ?? String(e)}`);
            abrirDialogo('#dispositivos');
        }
    }
    /** ---------- Eventos de interfaz y persistencia de ajustes ---------- */
    $('#btnConectar').addEventListener('click', () => void abrirDispositivos());
    $('#btnCerrarDisp').addEventListener('click', () => $('#dispositivos').close());
    $('#btnActualizarDisp').addEventListener('click', () => void cargarDispositivos());
    $('#btnParar').addEventListener('click', () => { void pararLocalYEnviar(); aviso('Motor detenido y dirección centrada.'); });
    for (const [k, [lo, hi]] of Object.entries(LIMITES)) {
        const input = $('#' + k);
        input.value = cfg[k];
        input.addEventListener('change', () => {
            const n = Number(input.value);
            if (input.value !== '' && Number.isFinite(n)) {
                cfg[k] = clamp(Math.round(n), lo, hi);
                input.value = cfg[k];
                guardar();
                pintar();
                reiniciarSeguimientoAvanzado();
            }
        });
    }
    for (const key of ['pidP', 'pidI', 'pidD']) {
        const input = $('#' + key);
        input.value = cfg[key];
        input.addEventListener('change', async () => {
            const n = Number(input.value);
            const limits = { pidP: [0, 50], pidI: [0, 10], pidD: [0, 50] }[key];
            if (!Number.isFinite(n) || input.value === '') {
                input.value = cfg[key];
                return;
            }
            cfg[key] = Math.min(limits[1], Math.max(limits[0], n));
            input.value = cfg[key];
            guardar();
            if (conectado) {
                const command = { pidP: 'KP', pidI: 'KI', pidD: 'KD' }[key];
                const ok = await enviarLinea(`${command},${cfg[key]}\n`);
                if (!ok)
                    perderConexion();
            }
        });
    }
    $('#throttleSpring').checked = cfg.throttleSpring;
    $('#throttleSpring').addEventListener('change', e => { cfg.throttleSpring = e.target.checked; guardar(); });
    document.querySelectorAll('[data-probar]').forEach(b => b.addEventListener('click', async () => {
        const posicion = Number(b.dataset.probar);
        if (cruceroActivo && conectado) {
            const ok = await enviarLinea('CRU,0\n');
            if (!ok) {
                perderConexion();
                return;
            }
            cruceroActivo = false;
            pintar();
            aviso('Crucero desactivado para probar el ángulo del servo.');
        }
        timon.poner(posicion);
        if (modo === 'simple')
            aviso('El control de ángulo se aplica en el modo Avanzado.');
    }));
    $('#btnAjustes').addEventListener('click', () => {
        void pararLocalYEnviar();
        abrirDialogo('#ajustes');
    });
    $('#btnCerrar').addEventListener('click', () => $('#ajustes').close());
    $('#btnReset').addEventListener('click', () => {
        Object.assign(cfg, DEFAULTS);
        guardar();
        for (const k of Object.keys(LIMITES))
            $('#' + k).value = cfg[k];
        for (const key of ['pidP', 'pidI', 'pidD'])
            $('#' + key).value = cfg[key];
        $('#throttleSpring').checked = cfg.throttleSpring;
        if (conectado) {
            void enviarLinea(`KP,${cfg.pidP}\n`);
            void enviarLinea(`KI,${cfg.pidI}\n`);
            void enviarLinea(`KD,${cfg.pidD}\n`);
        }
        pintar();
        reiniciarSeguimientoAvanzado();
    });
    async function mantenerPantallaActiva() {
        try {
            await navigator.wakeLock?.request('screen');
        }
        catch { }
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            void pararLocalYEnviar();
            if (conectado && direccionActual)
                void detenerRecepcionYaw(direccionActual, true);
        }
        else {
            void mantenerPantallaActiva();
            if (conectado && direccionActual)
                void iniciarRecepcionYaw(direccionActual);
        }
    });
    /** El horizonte ahora usa pitch/roll reales estimados del MPU, no la animación de los mandos. */
    let animacionPrevMs = 0;
    function animarInstrumentos(ts) {
        const dt = Math.min(0.1, (ts - (animacionPrevMs || ts)) / 1000);
        animacionPrevMs = ts;
        horizonte.tick(dt);
        velocimetro.tick(dt);
        requestAnimationFrame(animarInstrumentos);
    }
    requestAnimationFrame(animarInstrumentos);
    void mantenerPantallaActiva();
    $('#controlHint').innerHTML = 'Modo Avanzado<br><small>Desliza para ajustar potencia y dirección</small>';
    pintarEstado();
    limpiarYaw(BT ? 'Sin conexión' : 'Sin Bluetooth en simulador');
    limpiarVelocidad(BT ? 'Sin datos' : 'Sin Bluetooth');
    limpiarActitud(BT ? 'Sin datos' : 'Sin Bluetooth');
    pintar();
})();
