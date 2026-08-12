import { AuthManager } from './AuthManager.js';
import { consentManager } from './ConsentManager.js';
import { toast } from './Toast.js';
import { db } from './supabase-client.js';

const auth = new AuthManager();

// ── Avatar color ──────────────────────────────────────────────────────────────

function avatarColor(name) {
    const colors = [
        '#667eea', '#764ba2', '#00d4ff', '#00ff41',
        '#ff6b35', '#9d4edd', '#f59e0b', '#10b981'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

function initials(fullName) {
    return String(fullName || '?')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(w => w[0]?.toUpperCase() || '')
        .join('');
}

// ── Toast (delegado al sistema unificado en modules/Toast.js) ─────────────────

function showToast(message, type = 'success') {
    const map = { success: 'exito', error: 'error', warning: 'aviso', info: 'info' };
    const kind = map[type] || 'info';
    toast[kind](message);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function getModal() { return document.getElementById('auth-modal'); }
function getOverlay() { return document.getElementById('auth-modal-overlay'); }

function openModal(tab = 'login') {
    const modal = getModal();
    const overlay = getOverlay();
    if (!modal || !overlay) return;
    overlay.classList.add('auth-overlay--visible');
    modal.classList.add('auth-modal--visible');
    switchTab(tab);
    setTimeout(() => {
        const first = modal.querySelector(`#auth-${tab}-form input`);
        if (first) first.focus();
    }, 80);
}

function closeModal() {
    const modal = getModal();
    const overlay = getOverlay();
    if (!modal || !overlay) return;
    overlay.classList.remove('auth-overlay--visible');
    modal.classList.remove('auth-modal--visible');
    clearErrors();
}

function switchTab(tab) {
    document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.classList.toggle('auth-tab-btn--active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.auth-form-panel').forEach(panel => {
        panel.classList.toggle('auth-form-panel--active', panel.dataset.panel === tab);
    });
}

function clearErrors() {
    document.querySelectorAll('.auth-error').forEach(el => {
        el.textContent = '';
        el.classList.remove('auth-error--shake');
    });
}

function showError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.classList.remove('auth-error--shake');
    void el.offsetWidth;
    el.classList.add('auth-error--shake');
}

function setLoading(formId, loading) {
    const btn = document.querySelector(`#${formId} .auth-submit-btn`);
    if (!btn) return;
    btn.disabled = loading;
    const spinner = btn.querySelector('.auth-spinner');
    const label = btn.querySelector('.auth-btn-label');
    if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
    if (label) label.style.opacity = loading ? '0.5' : '1';
}

// ── Password strength indicator ───────────────────────────────────────────────

function updateStrengthBar(password) {
    const bar = document.getElementById('auth-strength-bar');
    const label = document.getElementById('auth-strength-label');
    if (!bar || !label) return;

    const { level, label: text } = auth.passwordStrength(password);
    const pct = level === 0 ? 0 : (level / 5) * 100;
    bar.style.width = `${pct}%`;

    const colors = ['', '#ef4444', '#f97316', '#eab308', '#84cc16', '#00ff41'];
    bar.style.background = colors[level] || 'transparent';
    label.textContent = text;
    label.style.color = colors[level] || 'transparent';
}

// ── Header UI ─────────────────────────────────────────────────────────────────

function renderLoggedOut() {
    const section = document.getElementById('auth-user-section');
    if (!section) return;
    section.innerHTML = `
        <button class="auth-header-btn auth-header-btn--outline" id="auth-open-login">
            Ingresar
        </button>
        <button class="auth-header-btn auth-header-btn--primary" id="auth-open-register">
            Registrarse
        </button>
    `;
    document.getElementById('auth-open-login')?.addEventListener('click', () => openModal('login'));
    document.getElementById('auth-open-register')?.addEventListener('click', () => openModal('register'));
}

function renderLoggedIn(session) {
    const section = document.getElementById('auth-user-section');
    if (!section) return;
    const color = avatarColor(session.fullName);
    const ini = initials(session.fullName);
    section.innerHTML = `
        <div class="auth-profile">
            <div class="auth-avatar" style="background:${color}" title="${escSafe(session.fullName)}">${escSafe(ini)}</div>
            <div class="auth-profile-info">
                <span class="auth-profile-name">${escSafe(session.fullName)}</span>
                <span class="auth-profile-username">@${escSafe(session.username)}</span>
            </div>
            <button class="auth-logout-btn" id="auth-logout-btn" title="Cerrar sesión">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
            </button>
        </div>
    `;
    document.getElementById('auth-logout-btn')?.addEventListener('click', handleLogout);

    consentManager.checkAndPrompt();
}

function escSafe(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

async function handleRegister(e) {
    e.preventDefault();
    clearErrors();

    const fullName = document.getElementById('reg-fullname')?.value || '';
    const username = document.getElementById('reg-username')?.value || '';
    const email = document.getElementById('reg-email')?.value || '';
    const password = document.getElementById('reg-password')?.value || '';

    setLoading('auth-register-form', true);

    const result = await auth.register({ fullName, username, email, password });

    setLoading('auth-register-form', false);

    if (!result.ok) {
        showError('auth-register-error', result.error);
        return;
    }

    closeModal();
    const regSession = await auth.getActiveSessionAsync();
    renderLoggedIn(regSession || { fullName: result.user.fullName, username: result.user.username, email: result.user.email });
    showToast(`¡Bienvenido, ${result.user.fullName}! 🎹`);
    window.dispatchEvent(new CustomEvent('auth:login', { detail: { username: result.user.username } }));
}

async function handleLogin(e) {
    e.preventDefault();
    clearErrors();

    const username = document.getElementById('login-username')?.value || '';
    const password = document.getElementById('login-password')?.value || '';

    setLoading('auth-login-form', true);

    const result = await auth.login({ username, password });

    setLoading('auth-login-form', false);

    if (!result.ok) {
        showError('auth-login-error', result.error);
        return;
    }

    closeModal();
    const loginSession = await auth.getActiveSessionAsync();
    renderLoggedIn(loginSession || { fullName: result.user.fullName, username: result.user.username, email: result.user.email });
    showToast(`¡Bienvenido, ${result.user.fullName}! 🎹`);
    window.dispatchEvent(new CustomEvent('auth:login', { detail: { username: result.user.username } }));
}

async function handleLogout() {
    const session = auth.getActiveSession();
    const name = session?.fullName || 'Usuario';
    await auth.logout();
    renderLoggedOut();
    showToast(`Hasta pronto, ${name} 👋`, 'info');
    window.dispatchEvent(new CustomEvent('auth:logout'));
}

// ── Toggle password visibility ────────────────────────────────────────────────

function setupTogglePassword(toggleId, inputId) {
    const btn = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
        const isText = input.type === 'text';
        input.type = isText ? 'password' : 'text';
        btn.innerHTML = isText
            ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    });
}

// ── Modal HTML ────────────────────────────────────────────────────────────────

function buildModalHTML() {
    return `
<div id="auth-modal-overlay" class="auth-overlay" role="dialog" aria-modal="true" aria-label="Autenticación">
    <div id="auth-modal" class="auth-modal">
        <button class="auth-modal-close" id="auth-modal-close" aria-label="Cerrar">&times;</button>

        <div class="auth-tabs" role="tablist" id="auth-tabs-bar">
            <button class="auth-tab-btn auth-tab-btn--active" data-tab="login" role="tab">Ingresar</button>
            <button class="auth-tab-btn" data-tab="register" role="tab">Registrarse</button>
        </div>

        <!-- LOGIN -->
        <div class="auth-form-panel auth-form-panel--active" data-panel="login">
            <form id="auth-login-form" novalidate autocomplete="on">
                <div class="auth-field">
                    <label class="auth-label" for="login-username">Email o usuario</label>
                    <input class="auth-input" id="login-username" name="username"
                           type="text" autocomplete="username" placeholder="tu@email.com o tu_usuario" required>
                </div>
                <div class="auth-field">
                    <label class="auth-label" for="login-password">Contraseña</label>
                    <div class="auth-input-wrap">
                        <input class="auth-input" id="login-password" name="password"
                               type="password" autocomplete="current-password" placeholder="••••••" required>
                        <button type="button" class="auth-toggle-pw" id="login-pw-toggle" tabindex="-1" aria-label="Mostrar contraseña">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                    </div>
                </div>
                <p class="auth-error" id="auth-login-error" role="alert"></p>
                <button type="submit" class="auth-submit-btn">
                    <span class="auth-spinner" style="display:none"></span>
                    <span class="auth-btn-label">Ingresar</span>
                </button>
            </form>
            <p class="auth-switch-text">
                <button class="auth-switch-link" id="auth-forgot-link">¿Olvidaste tu contraseña?</button>
            </p>
            <p class="auth-switch-text">
                ¿No tienes cuenta?
                <button class="auth-switch-link" data-tab="register">Regístrate</button>
            </p>
        </div>

        <!-- REGISTER -->
        <div class="auth-form-panel" data-panel="register">
            <form id="auth-register-form" novalidate autocomplete="off">
                <div class="auth-field">
                    <label class="auth-label" for="reg-fullname">Nombre completo</label>
                    <input class="auth-input" id="reg-fullname" name="fullname"
                           type="text" autocomplete="name" placeholder="Juan García" required>
                </div>
                <div class="auth-field">
                    <label class="auth-label" for="reg-username">Usuario</label>
                    <input class="auth-input" id="reg-username" name="username"
                           type="text" autocomplete="username" placeholder="juan_garcia" required>
                </div>
                <div class="auth-field">
                    <label class="auth-label" for="reg-email">Email</label>
                    <input class="auth-input" id="reg-email" name="email"
                           type="email" autocomplete="email" placeholder="juan@email.com" required>
                </div>
                <div class="auth-field">
                    <label class="auth-label" for="reg-password">Contraseña</label>
                    <div class="auth-input-wrap">
                        <input class="auth-input" id="reg-password" name="password"
                               type="password" autocomplete="new-password" placeholder="••••••" required>
                        <button type="button" class="auth-toggle-pw" id="reg-pw-toggle" tabindex="-1" aria-label="Mostrar contraseña">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                    </div>
                    <div class="auth-strength-wrap">
                        <div class="auth-strength-track">
                            <div class="auth-strength-bar" id="auth-strength-bar"></div>
                        </div>
                        <span class="auth-strength-label" id="auth-strength-label"></span>
                    </div>
                </div>
                <p class="auth-error" id="auth-register-error" role="alert"></p>
                <button type="submit" class="auth-submit-btn">
                    <span class="auth-spinner" style="display:none"></span>
                    <span class="auth-btn-label">Crear cuenta</span>
                </button>
            </form>
            <p class="auth-switch-text">
                ¿Ya tienes cuenta?
                <button class="auth-switch-link" data-tab="login">Ingresar</button>
            </p>
        </div>

        <!-- RECOVERY — un solo paso: pedir email, mandar link -->
        <div class="auth-form-panel" data-panel="recovery" id="auth-recovery-panel">
            <p class="auth-recovery-title">Recuperar contraseña</p>
            <p class="auth-recovery-help">
                Ingresa tu email o usuario y te enviaremos un link para elegir
                una nueva contraseña.
            </p>
            <div class="auth-field">
                <label class="auth-label" for="recovery-username">Email o usuario</label>
                <input class="auth-input" id="recovery-username" type="text"
                       autocomplete="username" placeholder="tu@email.com o tu_usuario">
            </div>
            <p class="auth-error" id="auth-recovery-error" role="alert"></p>
            <button type="button" class="auth-submit-btn" id="recovery-send-btn">
                <span class="auth-spinner" style="display:none"></span>
                <span class="auth-btn-label">Enviarme el link</span>
            </button>
            <p class="auth-switch-text" style="margin-top:1rem">
                <button class="auth-switch-link" id="recovery-back-link">← Volver al inicio de sesión</button>
            </p>
        </div>
    </div>
</div>`;
}

// ── Password recovery modal (post-link, cuando el usuario vuelve del email) ──

function buildRecoveryPasswordModalHTML() {
    return `
<div id="pw-recovery-overlay" class="auth-overlay" role="dialog" aria-modal="true" aria-label="Elegir nueva contraseña">
    <div id="pw-recovery-modal" class="auth-modal">
        <p class="auth-recovery-title" style="margin-bottom:0.25rem">
            <i class="fas fa-key" style="color:var(--accent-green);margin-right:0.4rem"></i>
            Elegir nueva contraseña
        </p>
        <p class="auth-recovery-help" style="margin-bottom:1rem">
            Verificamos tu identidad con el link del correo. Escribí tu nueva
            contraseña dos veces para confirmar.
        </p>
        <form id="pw-recovery-form" novalidate autocomplete="off">
            <input type="text" name="username" autocomplete="username" style="display:none">
            <div class="auth-field">
                <label class="auth-label" for="pw-recovery-new">Nueva contraseña</label>
                <div class="auth-input-wrap">
                    <input class="auth-input" id="pw-recovery-new" type="password"
                           autocomplete="new-password" placeholder="••••••" required>
                    <button type="button" class="auth-toggle-pw" id="pw-recovery-toggle" tabindex="-1" aria-label="Mostrar contraseña">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
            </div>
            <div class="auth-field">
                <label class="auth-label" for="pw-recovery-confirm">Confirmar contraseña</label>
                <input class="auth-input" id="pw-recovery-confirm" type="password"
                       autocomplete="new-password" placeholder="••••••" required>
            </div>
            <p class="auth-error" id="pw-recovery-error" role="alert"></p>
            <button type="submit" class="auth-submit-btn">
                <span class="auth-spinner" style="display:none"></span>
                <span class="auth-btn-label">Guardar contraseña</span>
            </button>
        </form>
    </div>
</div>`;
}

// ── Recovery helpers ──────────────────────────────────────────────────────────

function showRecoveryPanel() {
    document.getElementById('recovery-username').value = '';
    clearErrors();

    document.getElementById('auth-tabs-bar').style.display = 'none';
    switchTab('recovery');
    setTimeout(() => document.getElementById('recovery-username')?.focus(), 80);
}

function hideRecoveryPanel() {
    document.getElementById('auth-tabs-bar').style.display = '';
    switchTab('login');
    clearErrors();
}

function setRecoveryLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    const spinner = btn.querySelector('.auth-spinner');
    const label = btn.querySelector('.auth-btn-label');
    if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
    if (label) label.style.opacity = loading ? '0.5' : '1';
}

async function handleRecoverySend() {
    clearErrors();
    const val = String(document.getElementById('recovery-username')?.value || '').trim();
    if (!val) {
        showError('auth-recovery-error', 'Ingresa tu email o usuario.');
        return;
    }
    setRecoveryLoading('recovery-send-btn', true);
    const result = await auth.sendPasswordResetEmail(val);
    setRecoveryLoading('recovery-send-btn', false);

    if (!result.ok) {
        showError('auth-recovery-error', result.error);
        return;
    }
    hideRecoveryPanel();
    closeModal();
    toast.exito('Te enviamos un link para elegir una nueva contraseña. Revisa tu correo (y la carpeta de spam).');
}

// ── Post-link password modal ──────────────────────────────────────────────────

let _recoveryModalReady = false;
let _pendingRecoveryOpen = false;

function ensureRecoveryModal() {
    if (_recoveryModalReady) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildRecoveryPasswordModalHTML();
    document.body.appendChild(wrapper.firstElementChild);
    _recoveryModalReady = true;

    document.getElementById('pw-recovery-form')?.addEventListener('submit', handleRecoveryPasswordSave);
    setupTogglePassword('pw-recovery-toggle', 'pw-recovery-new');
}

function openRecoveryPasswordModal() {
    ensureRecoveryModal();
    const overlay = document.getElementById('pw-recovery-overlay');
    const modal = document.getElementById('pw-recovery-modal');
    if (!overlay || !modal) return;
    document.getElementById('pw-recovery-new').value = '';
    document.getElementById('pw-recovery-confirm').value = '';
    document.getElementById('pw-recovery-error').textContent = '';
    overlay.classList.add('auth-overlay--visible');
    modal.classList.add('auth-modal--visible');
    setTimeout(() => document.getElementById('pw-recovery-new')?.focus(), 80);
}

function closeRecoveryPasswordModal() {
    document.getElementById('pw-recovery-overlay')?.classList.remove('auth-overlay--visible');
    document.getElementById('pw-recovery-modal')?.classList.remove('auth-modal--visible');
}

async function handleRecoveryPasswordSave(e) {
    e.preventDefault();
    const errEl = document.getElementById('pw-recovery-error');
    errEl.textContent = '';
    errEl.classList.remove('auth-error--shake');

    const newPw = String(document.getElementById('pw-recovery-new')?.value || '');
    const confirmPw = String(document.getElementById('pw-recovery-confirm')?.value || '');

    if (newPw !== confirmPw) {
        errEl.textContent = 'Las contraseñas no coinciden.';
        void errEl.offsetWidth;
        errEl.classList.add('auth-error--shake');
        return;
    }

    const btn = document.querySelector('#pw-recovery-form .auth-submit-btn');
    const spinner = btn?.querySelector('.auth-spinner');
    const label = btn?.querySelector('.auth-btn-label');
    if (btn) btn.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';
    if (label) label.style.opacity = '0.5';

    const result = await auth.applyNewPasswordFromRecovery(newPw);

    if (btn) btn.disabled = false;
    if (spinner) spinner.style.display = 'none';
    if (label) label.style.opacity = '1';

    if (!result.ok) {
        errEl.textContent = result.error;
        void errEl.offsetWidth;
        errEl.classList.add('auth-error--shake');
        return;
    }

    closeRecoveryPasswordModal();
    // Limpiar el hash del URL para que un F5 no vuelva a disparar el modal.
    if (window.location.hash) {
        try { history.replaceState(null, '', window.location.pathname + window.location.search); }
        catch { /* no-op */ }
    }
    toast.exito('¡Contraseña actualizada! Ya podés usar la app.');
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
    // Inject auth modal into DOM
    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = buildModalHTML();
    const existingModal = document.getElementById('modal');
    if (existingModal) {
        existingModal.parentNode.insertBefore(modalContainer.firstElementChild, existingModal);
    } else {
        document.body.appendChild(modalContainer.firstElementChild);
    }

    // Preparar el modal de nueva contraseña por si llegamos con hash de recovery.
    ensureRecoveryModal();

    // Tab switching
    document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('.auth-switch-link[data-tab]').forEach(link => {
        link.addEventListener('click', () => switchTab(link.dataset.tab));
    });

    document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);

    document.getElementById('auth-modal-overlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    });

    document.getElementById('auth-login-form')?.addEventListener('submit', handleLogin);
    document.getElementById('auth-register-form')?.addEventListener('submit', handleRegister);

    document.getElementById('login-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('auth-login-form')?.requestSubmit();
        }
    });

    setupTogglePassword('login-pw-toggle', 'login-password');
    setupTogglePassword('reg-pw-toggle', 'reg-password');

    document.getElementById('reg-password')?.addEventListener('input', (e) => {
        updateStrengthBar(e.target.value);
    });

    document.getElementById('auth-forgot-link')?.addEventListener('click', showRecoveryPanel);
    document.getElementById('recovery-back-link')?.addEventListener('click', hideRecoveryPanel);
    document.getElementById('recovery-send-btn')?.addEventListener('click', handleRecoverySend);

    document.getElementById('recovery-username')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRecoverySend();
    });

    // Auth state changes
    auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session) {
            renderLoggedIn(session);
        } else if (event === 'SIGNED_OUT') {
            renderLoggedOut();
        } else if (event === 'USER_UPDATED' && session) {
            renderLoggedIn(session);
        } else if (event === 'PASSWORD_RECOVERY') {
            // El usuario vino desde el link del email; supabase-js ya consumió
            // el hash y estableció una sesión temporal. Abrimos el modal para
            // que elija la contraseña nueva.
            openRecoveryPasswordModal();
        }
    });

    // Si por race condition el evento PASSWORD_RECOVERY se disparó antes de
    // que quedara el listener conectado, y el hash sigue apuntando a un
    // recovery, abrimos el modal después de dejar que supabase-js procese la
    // sesión (getSession fuerza esa resolución).
    if (/type=recovery/.test(window.location.hash || '')) {
        _pendingRecoveryOpen = true;
        db.auth.getSession().then(() => {
            if (_pendingRecoveryOpen) {
                _pendingRecoveryOpen = false;
                openRecoveryPasswordModal();
            }
        });
    }

    // Restore session on page load
    auth.getActiveSessionAsync().then(session => {
        if (session) {
            renderLoggedIn(session);
        } else {
            renderLoggedOut();
        }
    });
}

// Run after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
