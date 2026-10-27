import barcoSvg from './assets/barco.svg';
/**
 * Instrumentos SVG del barco RC (estilo arcade). Sin dependencias.
 *
 *  - crearRumboBote:        anillo FIJO con números; lo que gira es el bote.
 *  - crearVelocimetroNudos: velocímetro en nudos (0 a maxKt).
 *  - crearHorizonteArcade:  horizonte con pitch y roll.
 * El firmware envía un paquete T,yaw,pitch,roll,velocidad_décimas_m_s.
 * El controlador de la app alimenta estos instrumentos con los valores recibidos.
 * Pitch/roll se calculan en el firmware solo con la gravedad del acelerómetro; la velocidad es una estimación inercial con deriva
 * (no compensa la gravedad, así que inclinar el casco la altera).
 *
 * Los colores salen de las variables CSS de index.html (--tinta, --panel, --boya, ...).
 */
const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = d => d * Math.PI / 180;
const num = n => Math.round(n * 100) / 100;
/** Punto polar alrededor del centro (100,100); ángulo en grados, horario desde arriba. */
const pt = (r, a) => [num(100 + r * Math.sin(rad(a))), num(100 - r * Math.cos(rad(a)))];
const rot = a => `rotate(${num(a)} 100 100)`;
/** Suavizado exponencial independiente de los fps. */
const acercar = (actual, objetivo, dt, tau) => actual + (objetivo - actual) * (1 - Math.exp(-dt / tau));

function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
}

function texto(parent, x, y, str, size, extra = {}) {
    const t = el('text', {
        x, y, 'font-size': size, 'font-weight': 800, fill: 'var(--tinta)',
        'text-anchor': 'middle', 'dominant-baseline': 'central', ...extra
    }, parent);
    t.textContent = str;
    return t;
}

function arco(r, a0, a1) {
    const [x0, y0] = pt(r, a0);
    const [x1, y1] = pt(r, a1);
    return `M${x0} ${y0} A${r} ${r} 0 ${(a1 - a0) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/** SVG base: bisel grueso oscuro y cara blanca. Radio útil interior: 88. */
function marco(host, etiqueta) {
    const svg = el('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': etiqueta }, host);
    el('circle', { cx: 100, cy: 100, r: 95, fill: 'var(--panel)', stroke: 'var(--tinta)', 'stroke-width': 10 }, svg);
    return svg;
}

function aguja(svg, largo, ancho, color) {
    const g = el('g', null, svg);
    el('polygon', { points: `${100 - ancho},114 100,${100 - largo} ${100 + ancho},114`, fill: color }, g);
    return g;
}

/* ------------------------------------------------------------------ */
/* Rumbo: el anillo y los números NO se mueven; el bote gira.          */
/* main.js mueve #casco con rotate(grados) alrededor del centro.       */
/* ------------------------------------------------------------------ */
export function crearRumboBote(host) {
    const svg = marco(host, 'Rumbo relativo del bote');
    svg.setAttribute('class', 'rosa');
    svg.setAttribute('id', 'boatCompass');
    svg.setAttribute('role', 'button');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', 'Tocar para poner el rumbo visual en cero; no cambia el rumbo del Arduino');
    el('title', null, svg).textContent = 'Restablecer orientación visual';

    // Anillo fijo: marcas cada 15°, números cada 30° (0 = proa de referencia, relativo al cero visual).
    for (let a = 0; a < 360; a += 15) {
        const mayor = a % 30 === 0;
        const [x1, y1] = pt(86, a);
        const [x2, y2] = pt(mayor ? 75 : 80, a);
        el('line', { x1, y1, x2, y2, stroke: 'var(--tinta)', 'stroke-width': mayor ? 3 : 1.6, 'stroke-linecap': 'round' }, svg);
        if (mayor) {
            const cardinal = a % 90 === 0;
            const [x, y] = pt(cardinal ? 59 : 62, a);
            texto(svg, x, y, String(a), cardinal ? 21 : 13, cardinal ? {} : { fill: 'var(--tinta-2)' });
        }
    }
    // Referencia fija arriba
    el('polygon', { points: '100,24 91,6 109,6', fill: 'var(--boya)', stroke: 'var(--tinta)', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, svg);

    // SVG suministrado para el barco. El asset está horizontal (proa a la izquierda),
    // por eso se gira 90° para apuntar hacia arriba. El grupo exterior centra y escala
    // el casco en el dial; #casco recibe después la rotación dinámica de yaw.
    const base = el('g', { transform: 'translate(100 100) scale(1.2)' }, svg);
    const casco = el('g', { id: 'casco' }, base);
    el('image', {
        href: barcoSvg,
        x: -39,
        y: -23.5,
        width: 78,
        height: 47,
        preserveAspectRatio: 'xMidYMid meet',
        transform: 'rotate(90 0 0)'
    }, casco);
    return { svg, casco };
}

/* ------------------------------------------------------------------ */
/* Velocímetro en nudos                                                */
/* ------------------------------------------------------------------ */
export function crearVelocimetroNudos(host, { maxKt = 10 } = {}) {
    const svg = marco(host, 'Velocímetro en nudos');
    const inicio = 225, barrido = 270; // de abajo-izquierda a abajo-derecha por arriba
    const ang = v => inicio + clamp(v, 0, maxKt) / maxKt * barrido;

    [[0, .5, 'var(--estribor)'], [.5, .8, 'var(--boya)'], [.8, 1, 'var(--babor)']].forEach(([a, b, color]) => {
        el('path', { d: arco(78, ang(a * maxKt), ang(b * maxKt)), fill: 'none', stroke: color, 'stroke-width': 10 }, svg);
    });
    for (let i = 0; i <= 20; i++) {
        const v = i * maxKt / 20, mayor = i % 4 === 0;
        const [x1, y1] = pt(69, ang(v));
        const [x2, y2] = pt(mayor ? 59 : 64, ang(v));
        el('line', { x1, y1, x2, y2, stroke: 'var(--tinta)', 'stroke-width': mayor ? 3 : 1.6, 'stroke-linecap': 'round' }, svg);
        if (mayor) {
            const [x, y] = pt(45, ang(v));
            texto(svg, x, y, String(Math.round(v)), 17);
        }
    }
    texto(svg, 100, 152, 'NUDOS', 14, { fill: 'var(--tinta-2)' });

    const manecilla = aguja(svg, 70, 6, 'var(--tinta)');
    el('circle', { cx: 100, cy: 100, r: 10, fill: 'var(--boya)', stroke: 'var(--tinta)', 'stroke-width': 4 }, svg);

    let actual = 0, objetivo = 0;
    const dibujar = () => manecilla.setAttribute('transform', rot(ang(actual)));
    dibujar();
    return {
        svg,
        /** Fija la velocidad objetivo en nudos; la aguja la alcanza con tick(). */
        update(kt, inmediato = false) {
            objetivo = clamp(Number(kt) || 0, 0, maxKt);
            if (inmediato) { actual = objetivo; dibujar(); }
        },
        tick(dt) {
            const nuevo = acercar(actual, objetivo, dt, 0.35);
            if (Math.abs(nuevo - actual) < 0.001 && actual === objetivo) return;
            actual = Math.abs(nuevo - objetivo) < 0.005 ? objetivo : nuevo;
            dibujar();
        },
        valor: () => actual
    };
}

/* ------------------------------------------------------------------ */
/* Horizonte: pitch (proa arriba +) y roll (estribor abajo +)           */
/* ------------------------------------------------------------------ */
export function crearHorizonteArcade(host, { pxPorGrado = 3 } = {}) {
    const svg = marco(host, 'Horizonte: pitch y roll (arcade)');
    const id = `hz${++uid}`;
    const recorte = el('clipPath', { id }, el('defs', null, svg));
    el('circle', { cx: 100, cy: 100, r: 88 }, recorte);
    const vista = el('g', { 'clip-path': `url(#${id})` }, svg);

    // Mundo: cielo, mar, línea de horizonte y escala de pitch (se mueve completo)
    const mundo = el('g', null, vista);
    el('rect', { x: -200, y: -400, width: 600, height: 500, fill: '#58B0E8' }, mundo);
    el('rect', { x: -200, y: 100, width: 600, height: 500, fill: '#1E6F94' }, mundo);
    el('line', { x1: -200, y1: 100, x2: 400, y2: 100, stroke: '#fff', 'stroke-width': 3 }, mundo);
    for (const p of [5, 10, 15, 20, 25]) {
        const mitad = p % 10 === 0 ? 26 : 13;
        for (const s of [1, -1]) {
            const y = 100 - s * p * pxPorGrado;
            el('line', { x1: 100 - mitad, y1: y, x2: 100 + mitad, y2: y, stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round' }, mundo);
            if (p % 10 === 0) {
                texto(mundo, 100 - mitad - 11, y, String(p), 11, { fill: '#fff' });
                texto(mundo, 100 + mitad + 11, y, String(p), 11, { fill: '#fff' });
            }
        }
    }

    // Escala de roll (gira con el horizonte) + índice fijo
    const escala = el('g', null, svg);
    for (const a of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
        const grande = a % 30 === 0;
        const [x1, y1] = pt(88, a);
        const [x2, y2] = pt(grande ? 76 : 81, a);
        el('line', { x1, y1, x2, y2, stroke: '#fff', 'stroke-width': grande ? 4 : 2.4, 'stroke-linecap': 'round' }, escala);
    }
    el('polygon', { points: '100,26 92,42 108,42', fill: 'var(--boya)', stroke: 'var(--tinta)', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, svg);

    // Referencia fija de proa (contorno oscuro + relleno ámbar)
    const referencia = 'M32 104 H78 V113 M168 104 H122 V113';
    el('path', { d: referencia, fill: 'none', stroke: 'var(--tinta)', 'stroke-width': 12, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    el('path', { d: referencia, fill: 'none', stroke: 'var(--boya)', 'stroke-width': 6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    el('circle', { cx: 100, cy: 104, r: 6, fill: 'var(--boya)', stroke: 'var(--tinta)', 'stroke-width': 3 }, svg);

    const actual = { pitch: 0, roll: 0 };
    const objetivo = { pitch: 0, roll: 0 };
    const dibujar = () => {
        // proa arriba => el horizonte baja; escora a estribor => el horizonte gira en sentido antihorario
        mundo.setAttribute('transform', `${rot(-actual.roll)} translate(0 ${num(actual.pitch * pxPorGrado)})`);
        escala.setAttribute('transform', rot(-actual.roll));
    };
    dibujar();
    return {
        svg,
        update({ pitch, roll } = {}, inmediato = false) {
            if (pitch != null) objetivo.pitch = clamp(pitch, -60, 60);
            if (roll != null) objetivo.roll = clamp(roll, -180, 180);
            if (inmediato) { actual.pitch = objetivo.pitch; actual.roll = objetivo.roll; dibujar(); }
        },
        tick(dt) {
            const p = acercar(actual.pitch, objetivo.pitch, dt, 0.2);
            const r = acercar(actual.roll, objetivo.roll, dt, 0.2);
            if (Math.abs(p - actual.pitch) < 0.002 && Math.abs(r - actual.roll) < 0.002) return;
            actual.pitch = p;
            actual.roll = r;
            dibujar();
        },
        valor: () => ({ ...actual })
    };
}
