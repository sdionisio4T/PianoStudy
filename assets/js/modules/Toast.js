// Toast.js — sistema unificado de notificaciones flotantes.
//
// Portado a vanilla JS desde un componente React (glass-morphism, progreso,
// pausa on hover). Reemplaza dos sistemas paralelos que había antes en el
// proyecto: showNotification (app-ui.js) y showToast (auth-ui.js), que ahora
// delegan acá.
//
// Uso:
//   import { toast } from './Toast.js';
//   toast.exito('Grabación guardada');
//   toast.error('No se pudo subir el audio');
//   toast.info('IA analizando…');
//   toast.aviso('Cerca del límite mensual');
//
// El contenedor y los elementos se crean con document.createElement (nunca
// innerHTML con contenido dinámico), y los mensajes se pasan por textContent,
// así los mensajes con HTML/JS se muestran como texto crudo — no XSS.

const DURATION_MS = 4500;
const OUT_ANIM_MS = 260;
const ROOT_ID = 'toast-root';

const TYPES = {
    exito: { icon: '✓', cls: 'toast--exito' },
    error: { icon: '✕', cls: 'toast--error' },
    aviso: { icon: '△', cls: 'toast--aviso' },
    info:  { icon: 'i', cls: 'toast--info' },
};

function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'toast-root';
        root.setAttribute('role', 'region');
        root.setAttribute('aria-live', 'polite');
        root.setAttribute('aria-label', 'Notificaciones');
        document.body.appendChild(root);
    }
    return root;
}

function show(message, type) {
    const cfg = TYPES[type] || TYPES.info;
    const root = ensureRoot();

    const el = document.createElement('div');
    el.className = `toast ${cfg.cls}`;
    el.setAttribute('role', 'status');

    const iconEl = document.createElement('div');
    iconEl.className = 'toast__icon';
    iconEl.textContent = cfg.icon;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'toast__body';
    bodyEl.textContent = String(message == null ? '' : message);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast__close';
    closeBtn.setAttribute('aria-label', 'Cerrar notificación');
    closeBtn.textContent = '×';

    const progress = document.createElement('div');
    progress.className = 'toast__progress';

    el.appendChild(iconEl);
    el.appendChild(bodyEl);
    el.appendChild(closeBtn);
    el.appendChild(progress);
    root.appendChild(el);

    // Auto-dismiss with pause on hover.
    const state = { remaining: DURATION_MS, startedAt: Date.now(), rafId: 0, timeoutId: 0 };

    const setProgressWidth = (leftMs) => {
        const pct = Math.max(0, Math.min(100, (leftMs / DURATION_MS) * 100));
        progress.style.width = `${pct}%`;
    };

    const tick = () => {
        const elapsed = Date.now() - state.startedAt;
        const left = Math.max(0, state.remaining - elapsed);
        setProgressWidth(left);
        if (left > 0) {
            state.rafId = requestAnimationFrame(tick);
        }
    };

    const dismiss = () => {
        if (state.timeoutId) { clearTimeout(state.timeoutId); state.timeoutId = 0; }
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
        el.classList.add('toast--out');
        setTimeout(() => el.remove(), OUT_ANIM_MS);
    };

    const start = () => {
        state.startedAt = Date.now();
        state.timeoutId = setTimeout(dismiss, state.remaining);
        state.rafId = requestAnimationFrame(tick);
    };

    const pause = () => {
        const elapsed = Date.now() - state.startedAt;
        state.remaining = Math.max(0, state.remaining - elapsed);
        if (state.timeoutId) { clearTimeout(state.timeoutId); state.timeoutId = 0; }
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
    };

    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', start);
    closeBtn.addEventListener('click', dismiss);

    setProgressWidth(DURATION_MS);
    start();

    return dismiss;
}

export const toast = {
    exito:  (msg) => show(msg, 'exito'),
    error:  (msg) => show(msg, 'error'),
    aviso:  (msg) => show(msg, 'aviso'),
    info:   (msg) => show(msg, 'info'),
};

export default toast;
