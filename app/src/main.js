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
     * Simple y Avanzado comparten el protocolo comprobado P/D. Los caracteres F/S/L/G/R/H
     * quedan reservados para aplicaciones heredadas. La telemetría es un canal separado.
     */
    const APP_CONFIG = Object.freeze({
        defaults: Object.freeze({
            maxPower: 20, minStart: 3, angLeft: 130, angCenter: 90, angRight: 70,
            throttleSpring: true, pidP: 2.0, pidI: 0.0, pidD: 0.4
        }),
        limits: Object.freeze({
            maxPower: [1, 180], minStart: [0, 179],
            angLeft: [0, 180], angCenter: [0, 180], angRight: [0, 180]
        }),
        valueRanges: Object.freeze({ power: [0, 180], servo: [0, 180] }),
        pidLimits: Object.freeze({ pidP: [0, 50], pidI: [0, 10], pidD: [0, 50] }),
        pidSteps: Object.freeze({ pidP: 0.1, pidI: 0.01, pidD: 0.1 }),
        timing: Object.freeze({
            commandMinMs: 90, activeRefreshMs: 750, controlPollMs: 35,
            telemetryReadPollMs: 100, telemetryStaleMs: 1800,
            telemetryRetryMs: 1600, telemetryRetryCheckMs: 500,
            telemetryMaxRetries: 8, configurationRefreshMs: 5000,
            consoleRows: 60, noticeClearMs: 4000
        }),
        telemetry: Object.freeze({
            maxSpeedMps: 5.0, knotsPerMps: 1.943844, maxSpeedKt: 10,
            yawRange: [-180, 180], pitchRange: [-90, 90], rollRange: [-180, 180], speedDeciRange: [0, 50]
        }),
        visual: Object.freeze({ maxSteeringDegrees: 28 }),
        simpleDirection: Object.freeze({ port: -1, center: 0, starboard: 1 }),
        protocol: Object.freeze({
            lineEnding: '\n',
            commands: Object.freeze({
                power: value => `P${value}`,
                direction: value => `D${value}`,
                hold: 'HOLD', calibration: 'CAL', cruiseOff: 'CRU,0',
                cruiseOn: cfg => `CRU,1,KP=${cfg.pidP.toFixed(1)},KI=${cfg.pidI.toFixed(2)},KD=${cfg.pidD.toFixed(1)}`,
                telemetryOn: 'TEL,1', telemetryOff: 'TEL,0',
                servoAngles: cfg => `ANG,${cfg.angCenter},${cfg.angLeft},${cfg.angRight}`,
                powerLimit: cfg => `PMAX,${cfg.maxPower}`
            })
        })
    });
    const DEFAULTS = APP_CONFIG.defaults;
    const STORAGE_KEY = 'barco.cfg.v2';
    const LIMITES = APP_CONFIG.limits;
    const SIMPLE = APP_CONFIG.simpleDirection;
    const COMMAND = APP_CONFIG.protocol.commands;
    const TELEMETRY = APP_CONFIG.telemetry;
    const INTERVAL = APP_CONFIG.timing;
    const $ = s => document.querySelector(s);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function checksumXor(orden) {
        let xor = 0;
        for (let i = 0; i < orden.length; i++)
            xor ^= orden.charCodeAt(i) & 0xff;
        return xor.toString(16).padStart(2, '0').toUpperCase();
    }
    function prepararLinea(orden) {
        const contenido = String(orden).replace(/[\r\n]+$/g, '');
        return `${contenido}*${checksumXor(contenido)}${APP_CONFIG.protocol.lineEnding}`;
    }

    const filasRegistros = {
        received: $('#registroRecibido'), sent: $('#registroEnviado'), console: $('#registroConsola')
    };
    const registros = { received: [], sent: [], console: [] };
    function textoDeConsola(valor) {
        if (valor instanceof Error)
            return valor.stack || `${valor.name}: ${valor.message}`;
        if (typeof valor === 'string')
            return valor;
        try { return JSON.stringify(valor); }
        catch { return String(valor); }
    }
    function agregarRegistro(tipo, texto) {
        const lista = filasRegistros[tipo];
        if (!lista)
            return;
        const caja = lista.closest('.registro-lista');
        const estabaAlFinal = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 12;
        const hora = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const fila = document.createElement('li');
        fila.className = `registro-fila ${tipo === 'console' ? 'registro-' + (texto.nivel || 'log') : ''}`;
        const marca = document.createElement('time');
        marca.textContent = hora;
        const contenido = document.createElement('code');
        contenido.textContent = typeof texto === 'string' ? texto : texto.mensaje;
        fila.append(marca, contenido);
        lista.append(fila);
        registros[tipo].push(fila);
        if (registros[tipo].length > APP_CONFIG.timing.consoleRows) {
            registros[tipo].shift().remove();
        }
        if (estabaAlFinal)
            caja.scrollTop = caja.scrollHeight;
    }
    const metodosConsola = ['log', 'info', 'warn', 'error', 'debug'];
    for (const metodo of metodosConsola) {
        const original = console[metodo].bind(console);
        console[metodo] = (...argumentos) => {
            original(...argumentos);
            agregarRegistro('console', { nivel: metodo, mensaje: argumentos.map(textoDeConsola).join(' ') });
        };
    }
    window.addEventListener('error', evento => agregarRegistro('console', {
        nivel: 'error', mensaje: `${evento.message || 'Error de ejecución'}${evento.filename ? ` · ${evento.filename}:${evento.lineno}` : ''}`
    }));
    window.addEventListener('unhandledrejection', evento => agregarRegistro('console', {
        nivel: 'error', mensaje: `Promesa rechazada: ${textoDeConsola(evento.reason)}`
    }));

    // Instrumentos SVG (src/instrumentos.js). El rumbo crea #boatCompass y #casco; el anillo con
    // números queda fijo y solo gira el bote. Los cuatro instrumentos vienen del paquete T combinado.
    crearRumboBote($('#instRumbo'));
    const velocimetro = crearVelocimetroNudos($('#instNudos'), { maxKt: APP_CONFIG.telemetry.maxSpeedKt });
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
    for (const [key, [minimo, maximo]] of Object.entries(LIMITES)) {
        const valor = Number(cfg[key]);
        cfg[key] = Number.isFinite(valor) ? clamp(Math.round(valor), minimo, maximo) : DEFAULTS[key];
    }
    for (const key of ['pidP', 'pidI', 'pidD']) {
        const valor = Number(cfg[key]);
        const paso = APP_CONFIG.pidSteps[key];
        const decimales = String(paso).split('.')[1]?.length || 0;
        cfg[key] = Number.isFinite(valor)
            ? Number(clamp(valor, ...APP_CONFIG.pidLimits[key]).toFixed(decimales))
            : DEFAULTS[key];
    }
    cfg.throttleSpring = Boolean(cfg.throttleSpring);
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
    let simpleDireccionActiva = SIMPLE.center;
    let prioridadDireccion = true;
    let colaEnvio = Promise.resolve();
    let enviosPendientes = 0;
    let cruceroActivo = false;
    let lectorYawHandle = null;
    let notificacionesYawActivas = false;
    let recepcionYawSolicitada = false;
    let bufferYaw = '';
    let yawActual = null; // yaw integrado real recibido del Arduino; no se modifica al poner cero visual
    let yawAnteriorDelta = null;
    let deltaYawReciente = null;
    let calibracionPendienteConfirmacion = false;
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
        const trama = prepararLinea(linea);
        const ejecutar = async () => {
            if (!BT) {
                agregarRegistro('sent', trama.trim());
                console.log('[Bluetooth simulador -> barco]', JSON.stringify(trama));
                return true;
            }
            if (!address)
                return false;
            try {
                agregarRegistro('sent', trama.trim());
                await BT.write({ address, value: trama });
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
    async function enviarConfiguracionFirmware(address = direccionActual) {
        const ordenes = [COMMAND.servoAngles(cfg), COMMAND.powerLimit(cfg)];
        for (const orden of ordenes) {
            const ok = await enviarLinea(orden, address);
            if (!ok)
                return false;
        }
        return true;
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
            return clamp(Math.round(cfg.angCenter + (cfg.angLeft - cfg.angCenter) * fraccion), ...APP_CONFIG.valueRanges.servo);
        }
        const fraccion = (t - 0.5) * 2;
        return clamp(Math.round(cfg.angCenter + (cfg.angRight - cfg.angCenter) * fraccion), ...APP_CONFIG.valueRanges.servo);
    }
    /** Al soltar el timón en crucero: termina el giro manual y captura el yaw actual. */
    async function soltarDireccionEnCrucero(posicionFinal) {
        if (modo !== 'avanzado' || !conectado || !cruceroActivo)
            return;
        const direccionFinal = direccionDesdePosicion(posicionFinal);
        const okDireccion = await enviarLinea(COMMAND.direction(direccionFinal));
        if (!okDireccion) {
            perderConexion();
            return;
        }
        const okHold = await enviarLinea(COMMAND.hold);
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
        const potencia = acelerador <= 0 ? 0 : clamp(Math.round(piso + (cfg.maxPower - piso) * acelerador), ...APP_CONFIG.valueRanges.power);
        return { direccion, potencia };
    }
    function valoresSimples() {
        const direccion = simpleDireccionActiva === SIMPLE.port ? cfg.angLeft
            : simpleDireccionActiva === SIMPLE.starboard ? cfg.angRight : cfg.angCenter;
        const accionado = simpleAceleradorActivo || simpleDireccionActiva !== SIMPLE.center;
        return { direccion, potencia: accionado ? cfg.maxPower : 0 };
    }
    function valoresControl() {
        return modo === 'simple' ? valoresSimples() : valoresAvanzados();
    }
    const GIRO_VISUAL_MAX = APP_CONFIG.visual.maxSteeringDegrees; // no altera la calibración del servo
    function anguloVisualSimple() {
        if (simpleDireccionActiva === SIMPLE.port)
            return -GIRO_VISUAL_MAX; // babor: proa hacia la izquierda
        if (simpleDireccionActiva === SIMPLE.starboard)
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
    function pintarDerivaGiroscopio(estado = '') {
        const valor = deltaYawReciente === null
            ? '—°'
            : `${deltaYawReciente > 0 ? '+' : ''}${deltaYawReciente.toFixed(1)}°`;
        $('#gyroDrift').textContent = `Drift: ${valor}${estado ? ` · ${estado}` : ''}`;
    }
    function actualizarOrientacionBote(anguloVisual) {
        // El offset solo pertenece a la interfaz: nunca se envía al Arduino ni
        // modifica rumboObjetivo del PID. Al perder la telemetría se usa el mando.
        const yawFresco = yawActual !== null &&
            (Date.now() - ultimaTelemetriaYawMs) <= APP_CONFIG.timing.telemetryStaleMs;
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
        if (yawAnteriorDelta !== null) {
            let delta = yaw - yawAnteriorDelta;
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            deltaYawReciente = delta;
        }
        yawAnteriorDelta = yaw;
        const yawVisible = anguloYawVisual();
        $('#yawValue').textContent = `${yawVisible > 0 ? '+' : ''}${yawVisible}°`;
        pintarDerivaGiroscopio();
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
        yawAnteriorDelta = null;
        deltaYawReciente = null;
        ultimaTelemetriaYawMs = 0;
        $('#yawValue').textContent = '—°';
        pintarDerivaGiroscopio(estado);
        $('#yawStatus').textContent = estado;
        $('#yawStatus').classList.remove('online');
        actualizarOrientacionBote(modo === 'simple' ? anguloVisualSimple() : anguloVisualAvanzado());
    }
    function pintarVelocidad(velocidadMps) {
        velocidadEstimadaMps = clamp(velocidadMps, 0, APP_CONFIG.telemetry.maxSpeedMps);
        const nudos = velocidadEstimadaMps * TELEMETRY.knotsPerMps;
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
            if (Number.isInteger(yaw) && yaw >= TELEMETRY.yawRange[0] && yaw <= TELEMETRY.yawRange[1] &&
                Number.isInteger(pitch) && pitch >= TELEMETRY.pitchRange[0] && pitch <= TELEMETRY.pitchRange[1] &&
                Number.isInteger(roll) && roll >= TELEMETRY.rollRange[0] && roll <= TELEMETRY.rollRange[1] &&
                Number.isInteger(velocidadDecimas) && velocidadDecimas >= TELEMETRY.speedDeciRange[0] && velocidadDecimas <= TELEMETRY.speedDeciRange[1]) {
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
        for (const linea of lineas) {
            if (linea.trim())
                agregarRegistro('received', linea.trim());
            procesarLineaTelemetria(linea);
        }
        // Algunas versiones del plugin entregan una sola línea sin terminador.
        if (/^T,-?\d{1,3},-?\d{1,2},-?\d{1,3},\d{1,2}$/.test(bufferYaw.trim())) {
            agregarRegistro('received', bufferYaw.trim());
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
            const ok = await enviarLinea(COMMAND.telemetryOff, address);
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
        const ok = await enviarLinea(COMMAND.telemetryOn, address);
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
    }, APP_CONFIG.timing.telemetryReadPollMs);
    setInterval(() => {
        if (!recepcionYawSolicitada || !conectado)
            return;
        const ahora = Date.now();
        if (ultimaTelemetriaYawMs && ahora - ultimaTelemetriaYawMs > APP_CONFIG.timing.telemetryStaleMs) {
            limpiarYaw('Telemetría interrumpida');
            limpiarVelocidad('Telemetría interrumpida');
            limpiarActitud('Telemetría interrumpida');
            paqueteTelemetriaRecibido = false;
        }
        // Si el firmware estaba armando/calibrando al conectar, reintenta pocos veces.
        if (!paqueteTelemetriaRecibido && intentosSolicitudYaw < APP_CONFIG.timing.telemetryMaxRetries &&
            ahora - ultimoComandoYawMs >= APP_CONFIG.timing.telemetryRetryMs) {
            intentosSolicitudYaw++;
            ultimoComandoYawMs = ahora;
            void enviarLinea(COMMAND.telemetryOn).then(ok => { if (!ok) perderConexion(); });
        }
        if (!paqueteTelemetriaRecibido && intentosSolicitudYaw >= APP_CONFIG.timing.telemetryMaxRetries &&
            ahora - ultimoComandoYawMs >= APP_CONFIG.timing.telemetryStaleMs) {
            $('#yawStatus').textContent = 'Sin datos del MPU';
            $('#yawStatus').classList.remove('online');
            $('#speedStatus').textContent = 'Sin datos del MPU';
            $('#speedStatus').classList.remove('online');
            $('#attStatus').textContent = 'Sin datos del MPU';
            $('#attStatus').classList.remove('online');
        }
    }, APP_CONFIG.timing.telemetryRetryCheckMs);
    setInterval(async () => {
        if (!conectado || desconectando || enviosPendientes > 0)
            return;
        const ok = await enviarConfiguracionFirmware();
        if (!ok)
            perderConexion();
    }, APP_CONFIG.timing.configurationRefreshMs);
    function pintar() {
        const { direccion, potencia } = valoresControl();
        const velocidadSolicitada = Math.round(acel.valor() * 100);
        $('#thrPct').textContent = `${velocidadSolicitada}%`;
        $('#thrPot').textContent = `pot. ${potencia}`;
        $('#strAng').textContent = `${direccion}°`;
        $('#simplePowerValue').textContent = String(cfg.maxPower);
        $('#simplePowerHint').textContent = 'potencia configurada';
        // El velocímetro se actualiza con la velocidad estimada incluida en el paquete T del MPU.
        actualizarOrientacionBote(modo === 'simple' ? anguloVisualSimple() : anguloVisualAvanzado());
        $('#btnCrucero').classList.toggle('active', cruceroActivo);
        $('#btnCrucero').textContent = `Crucero: ${cruceroActivo ? 'ACTIVADO' : 'DESACTIVADO'}`;
        $('#btnCrucero').setAttribute('aria-pressed', String(cruceroActivo));
    }
    function aviso(texto) {
        $('#aviso').textContent = texto;
        clearTimeout(aviso.timer);
        aviso.timer = setTimeout(() => { $('#aviso').textContent = ''; }, INTERVAL.noticeClearMs);
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
        simpleDireccionActiva = SIMPLE.center;
        acel.poner(0);
        timon.poner(0.5);
        pintar();
        if (conectado) {
            const okMotor = await enviarLinea(COMMAND.power(0));
            if (!okMotor) {
                perderConexion();
                return;
            }
            const okDireccion = await enviarLinea(COMMAND.direction(cfg.angCenter));
            if (!okDireccion) {
                perderConexion();
                return;
            }
            if (cruceroActivo) {
                const okHold = await enviarLinea(COMMAND.hold);
                if (!okHold) {
                    perderConexion();
                    return;
                }
            }
            ultimaPotenciaEnviada = 0;
            ultimaDireccionEnviada = cfg.angCenter;
            ultimoEnvio = Date.now();
        }
    }
    function perderConexion() {
        const address = direccionActual;
        calibracionPendienteConfirmacion = false;
        $('#btnCalibrar').textContent = 'Calibrar';
        conectado = false;
        nombre = '';
        direccionActual = '';
        cruceroActivo = false;
        pintar();
        simpleAceleradorActivo = false;
        simpleDireccionActiva = SIMPLE.center;
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
     * Lazo común Simple/Avanzado. Limita escrituras y renueva solo órdenes activas
     * de potencia/dirección antes del failsafe del Arduino.
     * El firmware conserva la última barrera de seguridad si la app pierde conexión.
     */
    setInterval(async () => {
        if (!conectado || desconectando || enviosPendientes > 0)
            return;
        const ahora = Date.now();
        const actual = valoresControl();
        const cambioD = actual.direccion !== ultimaDireccionEnviada;
        const cambioP = actual.potencia !== ultimaPotenciaEnviada;
        if (ahora - ultimoEnvio < APP_CONFIG.timing.commandMinMs)
            return;
        let linea = '';
        let tipo = '';
        if (cambioD && cambioP) {
            if (prioridadDireccion) {
                linea = COMMAND.direction(actual.direccion);
                tipo = 'D';
            }
            else {
                linea = COMMAND.power(actual.potencia);
                tipo = 'P';
            }
            prioridadDireccion = !prioridadDireccion;
        }
        else if (cambioD) {
            linea = COMMAND.direction(actual.direccion);
            tipo = 'D';
        }
        else if (cambioP) {
            linea = COMMAND.power(actual.potencia);
            tipo = 'P';
        }
        else if (ahora - ultimoEnvio >= APP_CONFIG.timing.activeRefreshMs) {
            if (actual.potencia > 0) {
                linea = COMMAND.power(actual.potencia);
                tipo = 'P';
            }
            else if (actual.direccion !== cfg.angCenter) {
                linea = COMMAND.direction(actual.direccion);
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
    }, APP_CONFIG.timing.controlPollMs);
    /* ---------- Cambiar de modo ---------- */
    async function cambiarModo() {
        const siguienteModo = modo === 'avanzado' ? 'simple' : 'avanzado';
        await pararLocalYEnviar();
        modo = siguienteModo;
        $('main').classList.toggle('modo-simple', modo === 'simple');
        $('#btnModo').textContent = modo === 'simple' ? 'Cambiar a Avanzado' : 'Cambiar a Simple';
        $('#controlHint').innerHTML = modo === 'simple'
            ? 'Modo Simple<br><small>Usa la potencia y los ángulos configurados</small>'
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
    // Crucero incluye PID y ganancias en una sola orden comprobada.
    $('#btnCrucero').addEventListener('click', async () => {
        if (!conectado) {
            aviso('Conecta el HC-06 primero.');
            return;
        }
        cruceroActivo = !cruceroActivo;
        pintar();
        const ok = await enviarLinea(cruceroActivo ? COMMAND.cruiseOn(cfg) : COMMAND.cruiseOff);
        if (!ok) {
            perderConexion();
            return;
        }
        aviso(cruceroActivo
            ? 'Crucero activado con las ganancias configuradas; el rumbo puede derivar.'
            : 'Crucero desactivado.');
    });
    $('#btnCalibrar').addEventListener('click', async () => {
        clearTimeout(aviso.timer);
        $('#aviso').textContent = '';
        if (!conectado) {
            calibracionPendienteConfirmacion = false;
            $('#btnCalibrar').textContent = 'Calibrar';
            return;
        }
        if (!calibracionPendienteConfirmacion) {
            calibracionPendienteConfirmacion = true;
            $('#btnCalibrar').textContent = 'Calibrar: ¿confirmar?';
            return;
        }
        calibracionPendienteConfirmacion = false;
        $('#btnCalibrar').textContent = 'Calibrar';
        const ok = await enviarLinea(COMMAND.calibration);
        if (!ok) {
            perderConexion();
            return;
        }
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
    async function enviarEstadoSimple() {
        if (!conectado || modo !== 'simple')
            return;
        const actual = valoresSimples();
        if (actual.direccion !== ultimaDireccionEnviada) {
            const ok = await enviarLinea(COMMAND.direction(actual.direccion));
            if (!ok) { perderConexion(); return; }
            ultimaDireccionEnviada = actual.direccion;
        }
        if (actual.potencia !== ultimaPotenciaEnviada) {
            const ok = await enviarLinea(COMMAND.power(actual.potencia));
            if (!ok) { perderConexion(); return; }
            ultimaPotenciaEnviada = actual.potencia;
        }
        ultimoEnvio = Date.now();
    }
    async function detenerSimplePorOrden() {
        simpleStopLatch = true;
        simpleAceleradorActivo = false;
        simpleDireccionActiva = SIMPLE.center;
        pintar();
        if (!conectado)
            return;
        const okMotor = await enviarLinea(COMMAND.power(0));
        if (!okMotor) { perderConexion(); return; }
        const okDireccion = await enviarLinea(COMMAND.direction(cfg.angCenter));
        if (!okDireccion) { perderConexion(); return; }
        if (cruceroActivo) {
            const okHold = await enviarLinea(COMMAND.hold);
            if (!okHold) { perderConexion(); return; }
        }
        ultimaPotenciaEnviada = 0;
        ultimaDireccionEnviada = cfg.angCenter;
        ultimoEnvio = Date.now();
    }
    $('#simpleDecelerate').addEventListener('click', () => { void detenerSimplePorOrden(); });

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
            try { el.setPointerCapture(e.pointerId); } catch { }
            simpleAceleradorActivo = true;
            pintar();
            void enviarEstadoSimple();
        };
        const soltar = async e => {
            if (pointerId === null || (e && e.pointerId !== pointerId))
                return;
            pointerId = null;
            if (simpleStopLatch) return;
            simpleAceleradorActivo = false;
            pintar();
            if (!simpleDireccionActiva)
                await enviarEstadoSimple();
        };
        el.addEventListener('pointerdown', comenzar);
        el.addEventListener('pointerup', e => { void soltar(e); });
        el.addEventListener('pointercancel', e => { void soltar(e); });
        el.addEventListener('lostpointercapture', e => { void soltar(e); });
    }
    function vincularDireccionSimple(el, direccion) {
        let pointerId = null;
        const comenzar = e => {
            if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0))
                return;
            if (!validarModoSimpleConectado())
                return;
            e.preventDefault();
            simpleStopLatch = false;
            pointerId = e.pointerId;
            try { el.setPointerCapture(e.pointerId); } catch { }
            simpleDireccionActiva = direccion;
            pintar();
            void enviarEstadoSimple();
        };
        const soltar = async e => {
            if (pointerId === null || (e && e.pointerId !== pointerId))
                return;
            pointerId = null;
            if (simpleStopLatch || simpleDireccionActiva !== direccion)
                return;
            simpleDireccionActiva = SIMPLE.center;
            pintar();
            if (!conectado)
                return;
            await enviarEstadoSimple();
            if (cruceroActivo && conectado) {
                const okHold = await enviarLinea(COMMAND.hold);
                if (!okHold) { perderConexion(); return; }
            }
        };
        el.addEventListener('pointerdown', comenzar);
        el.addEventListener('pointerup', e => { void soltar(e); });
        el.addEventListener('pointercancel', e => { void soltar(e); });
        el.addEventListener('lostpointercapture', e => { void soltar(e); });
    }
    vincularAceleradorSimple($('#simpleForward'));
    vincularDireccionSimple($('#simpleLeft'), SIMPLE.port);
    vincularDireccionSimple($('#simpleRight'), SIMPLE.starboard);
    /** ---------- Emparejamiento y conexión Bluetooth serie ---------- */
    async function abrirDispositivos() {
        if (conectado) {
            desconectando = true;
            const address = direccionActual;
            try {
                if (cruceroActivo)
                    await enviarLinea(COMMAND.cruiseOff, address);
                await enviarLinea(COMMAND.power(0), address);
                await enviarLinea(COMMAND.direction(cfg.angCenter), address);
                await detenerRecepcionYaw(address, true);
                if (BT && address)
                    await BT.disconnect({ address });
            }
            catch (e) {
                console.warn('Error durante la desconexión:', e);
            }
            finally {
                calibracionPendienteConfirmacion = false;
                $('#btnCalibrar').textContent = 'Calibrar';
                conectado = false;
                nombre = '';
                direccionActual = '';
                simpleAceleradorActivo = false;
                simpleDireccionActiva = SIMPLE.center;
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
            simpleDireccionActiva = SIMPLE.center;
            pintarEstado();
            const ok = await enviarLinea(COMMAND.power(0));
            if (!ok) {
                perderConexion();
                return;
            }
            const okDireccion = await enviarLinea(COMMAND.direction(cfg.angCenter));
            if (!okDireccion) {
                perderConexion();
                return;
            }
            ultimaPotenciaEnviada = 0;
            ultimaDireccionEnviada = cfg.angCenter;
            ultimoEnvio = Date.now();
            cruceroActivo = false;
            pintar();
            const okCrucero = await enviarLinea(COMMAND.cruiseOff);
            if (!okCrucero) {
                perderConexion();
                return;
            }
            const okConfig = await enviarConfiguracionFirmware(direccionActual);
            if (!okConfig) {
                perderConexion();
                return;
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
    $('#btnRegistros').addEventListener('click', () => {
        abrirDialogo('#panelRegistros');
        requestAnimationFrame(() => document.querySelectorAll('.registro-lista').forEach(caja => {
            caja.scrollTop = caja.scrollHeight;
        }));
    });
    $('#btnCerrarRegistros').addEventListener('click', () => $('#panelRegistros').close());
    $('#btnCerrarDisp').addEventListener('click', () => $('#dispositivos').close());
    $('#btnActualizarDisp').addEventListener('click', () => void cargarDispositivos());
    $('#btnParar').addEventListener('click', () => { void pararLocalYEnviar(); aviso('Motor detenido y dirección centrada.'); });
    for (const [k, [lo, hi]] of Object.entries(LIMITES)) {
        const input = $('#' + k);
        input.min = lo;
        input.max = hi;
        input.step = '1';
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
        input.min = APP_CONFIG.pidLimits[key][0];
        input.max = APP_CONFIG.pidLimits[key][1];
        input.step = APP_CONFIG.pidSteps[key];
        input.value = cfg[key];
        input.addEventListener('change', async () => {
            const n = Number(input.value);
            const limits = APP_CONFIG.pidLimits[key];
            if (!Number.isFinite(n) || input.value === '') {
                input.value = cfg[key];
                return;
            }
            const decimals = String(APP_CONFIG.pidSteps[key]).split('.')[1]?.length || 0;
            const ajustado = clamp(n, limits[0], limits[1]);
            cfg[key] = Number(ajustado.toFixed(decimals));
            input.value = cfg[key];
            guardar();
            if (conectado && cruceroActivo) {
                const ok = await enviarLinea(COMMAND.cruiseOn(cfg));
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
            const ok = await enviarLinea(COMMAND.cruiseOff);
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
            void enviarConfiguracionFirmware().then(ok => { if (!ok) perderConexion(); });
            if (cruceroActivo)
                void enviarLinea(COMMAND.cruiseOn(cfg))
                    .then(ok => { if (!ok) perderConexion(); });
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
