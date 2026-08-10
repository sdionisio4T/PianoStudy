import { AuthManager } from './AuthManager.js';
import { consentManager } from './ConsentManager.js';

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

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(message, type = 'success') {
    const existing = document.getElementById('auth-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'auth-toast';
    toast.className = `auth-toast auth-toast--${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('auth-toast--visible'));

    setTimeout(() => {
        toast.classList.remove('auth-toast--visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 3500);
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
    // Focus first input
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
    void el.offsetWidth; // reflow to restart animation
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
    const hasQ = auth.hasSecurityQuestion(session.username);
    const warningBtn = hasQ ? '' : `
        <button class="auth-sq-warning-btn" id="auth-sq-warning-btn"
                title="Configura tu pregunta de seguridad" aria-label="Configura tu pregunta de seguridad">
            <i class="fas fa-exclamation-triangle"></i>
        </button>`;
    section.innerHTML = `
        <div class="auth-profile">
            <div class="auth-avatar" style="background:${color}" title="${escSafe(session.fullName)}">${escSafe(ini)}</div>
            <div class="auth-profile-info">
                <span class="auth-profile-name">${escSafe(session.fullName)}</span>
                <span class="auth-profile-username">@${escSafe(session.username)}</span>
            </div>
            ${warningBtn}
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
    document.getElementById('auth-sq-warning-btn')?.addEventListener('click', openSQSetupModal);

    // Pregunta el consentimiento de datos musicales para IA si todavía no se
    // respondió. Es un no-op si ya se preguntó en esta carga de página o si
    // el usuario ya había respondido antes (ver ConsentManager.js).
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
    const securityQuestion = document.getElementById('reg-security-question')?.value || '';
    const securityAnswer = document.getElementById('reg-security-answer')?.value || '';

    setLoading('auth-register-form', true);

    const result = await auth.register({ fullName, username, email, password, securityQuestion, securityAnswer });

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

const SECURITY_QUESTIONS = [
    '¿Cuál es el nombre de tu primera mascota?',
    '¿En qué ciudad naciste?',
    '¿Cuál fue tu primer instrumento musical?',
    '¿Cuál es el nombre de tu mejor amigo de infancia?'
];

function buildModalHTML() {
    const questionOptions = SECURITY_QUESTIONS
        .map(q => `<option value="${escSafe(q)}">${escSafe(q)}</option>`)
        .join('');

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
                <div class="auth-field">
                    <label class="auth-label" for="reg-security-question">Pregunta de seguridad</label>
                    <select class="auth-input auth-select" id="reg-security-question" name="securityQuestion" required>
                        <option value="">Selecciona una pregunta...</option>
                        ${questionOptions}
                    </select>
                </div>
                <div class="auth-field">
                    <label class="auth-label" for="reg-security-answer">Respuesta</label>
                    <input class="auth-input" id="reg-security-answer" name="securityAnswer"
                           type="text" autocomplete="off" placeholder="Tu respuesta" required>
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

        <!-- RECOVERY (not a tab — shown/hidden as a panel overlay) -->
        <div class="auth-form-panel" data-panel="recovery" id="auth-recovery-panel">
            <div id="recovery-step-1">
                <p class="auth-recovery-title">Recuperar contraseña</p>
                <div class="auth-field">
                    <label class="auth-label" for="recovery-username">Email</label>
                    <input class="auth-input" id="recovery-username" type="email"
                           autocomplete="email" placeholder="tu@email.com">
                </div>
                <p class="auth-error" id="auth-recovery-error-1" role="alert"></p>
                <button type="button" class="auth-submit-btn" id="recovery-continue-btn">
                    <span class="auth-spinner" style="display:none"></span>
                    <span class="auth-btn-label">Continuar</span>
                </button>
            </div>

            <div id="recovery-step-2" style="display:none">
                <p class="auth-recovery-title">Pregunta de seguridad</p>
                <p class="auth-recovery-question" id="recovery-question-text"></p>
                <div class="auth-field">
                    <label class="auth-label" for="recovery-answer">Tu respuesta</label>
                    <input class="auth-input" id="recovery-answer" type="text"
                           autocomplete="off" placeholder="Respuesta">
                </div>
                <p class="auth-error" id="auth-recovery-error-2" role="alert"></p>
                <button type="button" class="auth-submit-btn" id="recovery-verify-btn">
                    <span class="auth-spinner" style="display:none"></span>
                    <span class="auth-btn-label">Verificar</span>
                </button>
            </div>

            <div id="recovery-step-3" style="display:none">
                <p class="auth-recovery-title">Nueva contraseña</p>
                <form novalidate autocomplete="off" onsubmit="return false;">
                <input type="text" name="username" autocomplete="username" style="display:none">
                <div class="auth-field">
                    <label class="auth-label" for="recovery-new-pw">Nueva contraseña</label>
                    <div class="auth-input-wrap">
                        <input class="auth-input" id="recovery-new-pw" type="password"
                               autocomplete="new-password" placeholder="••••••">
                        <button type="button" class="auth-toggle-pw" id="recovery-pw-toggle" tabindex="-1" aria-label="Mostrar contraseña">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                    </div>
                </div>
                <div class="auth-field">
                    <label class="auth-label" for="recovery-confirm-pw">Confirmar contraseña</label>
                    <input class="auth-input" id="recovery-confirm-pw" type="password"
                           autocomplete="new-password" placeholder="••••••">
                </div>
                </form>
                <p class="auth-error" id="auth-recovery-error-3" role="alert"></p>
                <button type="button" class="auth-submit-btn" id="recovery-save-btn">
                    <span class="auth-spinner" style="display:none"></span>
                    <span class="auth-btn-label">Guardar contraseña</span>
                </button>
            </div>

            <p class="auth-switch-text" style="margin-top:1rem">
                <button class="auth-switch-link" id="recovery-back-link">← Volver al inicio de sesión</button>
            </p>
        </div>
    </div>
</div>`;
}

// ── SQ Setup modal HTML ───────────────────────────────────────────────────────

function buildSQSetupModalHTML() {
    const questionOptions = SECURITY_QUESTIONS
        .map(q => `<option value="${escSafe(q)}">${escSafe(q)}</option>`)
        .join('');

    return `
<div id="sq-setup-overlay" class="auth-overlay" role="dialog" aria-modal="true" aria-label="Configurar pregunta de seguridad">
    <div id="sq-setup-modal" class="auth-modal sq-setup-modal">
        <button class="auth-modal-close" id="sq-setup-close" aria-label="Cerrar">&times;</button>
        <p class="auth-recovery-title" style="margin-bottom:0.25rem">
            <i class="fas fa-shield-alt" style="color:var(--accent-green);margin-right:0.4rem"></i>
            Configurar pregunta de seguridad
        </p>
        <p style="color:var(--text-secondary);font-size:0.82rem;font-family:'Courier New',monospace;margin-bottom:1.25rem">
            Esto te permitirá recuperar tu contraseña si la olvidas.
        </p>
        <form id="sq-setup-form" novalidate autocomplete="off">
            <input type="text" name="username" autocomplete="username" style="display:none">
            <div class="auth-field">
                <label class="auth-label" for="sq-current-pw">Contraseña actual</label>
                <div class="auth-input-wrap">
                    <input class="auth-input" id="sq-current-pw" type="password"
                           autocomplete="current-password" placeholder="••••••" required>
                    <button type="button" class="auth-toggle-pw" id="sq-pw-toggle" tabindex="-1" aria-label="Mostrar contraseña">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
            </div>
            <div class="auth-field">
                <label class="auth-label" for="sq-question">Pregunta de seguridad</label>
                <select class="auth-input auth-select" id="sq-question" required>
                    <option value="">Selecciona una pregunta...</option>
                    ${questionOptions}
                </select>
            </div>
            <div class="auth-field">
                <label class="auth-label" for="sq-answer">Respuesta</label>
                <input class="auth-input" id="sq-answer" type="text"
                       autocomplete="off" placeholder="Tu respuesta" required>
            </div>
            <p class="auth-error" id="sq-setup-error" role="alert"></p>
            <button type="submit" class="auth-submit-btn">
                <span class="auth-spinner" style="display:none"></span>
                <span class="auth-btn-label">Guardar</span>
            </button>
        </form>
    </div>
</div>`;
}

// ── SQ Setup handlers ─────────────────────────────────────────────────────────

function openSQSetupModal() {
    const overlay = document.getElementById('sq-setup-overlay');
    const modal = document.getElementById('sq-setup-modal');
    if (!overlay || !modal) return;
    document.getElementById('sq-current-pw').value = '';
    document.getElementById('sq-question').value = '';
    document.getElementById('sq-answer').value = '';
    document.getElementById('sq-setup-error').textContent = '';
    overlay.classList.add('auth-overlay--visible');
    modal.classList.add('auth-modal--visible');
    setTimeout(() => document.getElementById('sq-current-pw')?.focus(), 80);
}

function closeSQSetupModal() {
    document.getElementById('sq-setup-overlay')?.classList.remove('auth-overlay--visible');
    document.getElementById('sq-setup-modal')?.classList.remove('auth-modal--visible');
}

async function handleSQSetupSave(e) {
    e.preventDefault();
    const errEl = document.getElementById('sq-setup-error');
    errEl.textContent = '';
    errEl.classList.remove('auth-error--shake');

    const session = auth.getActiveSession();
    if (!session) { closeSQSetupModal(); return; }

    const currentPw = document.getElementById('sq-current-pw')?.value || '';
    const question = document.getElementById('sq-question')?.value || '';
    const answer = document.getElementById('sq-answer')?.value || '';

    const btn = document.querySelector('#sq-setup-form .auth-submit-btn');
    const spinner = btn?.querySelector('.auth-spinner');
    const label = btn?.querySelector('.auth-btn-label');
    if (btn) btn.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';
    if (label) label.style.opacity = '0.5';

    const result = await auth.setSecurityQuestion(session.username, currentPw, question, answer);

    if (btn) btn.disabled = false;
    if (spinner) spinner.style.display = 'none';
    if (label) label.style.opacity = '1';

    if (!result.ok) {
        errEl.textContent = result.error;
        void errEl.offsetWidth;
        errEl.classList.add('auth-error--shake');
        return;
    }

    closeSQSetupModal();
    renderLoggedIn(session);
    showToast('¡Pregunta de seguridad configurada! 🔒', 'success');
}

// ── Recovery helpers ──────────────────────────────────────────────────────────

let _recoveryUsername = '';

function showRecoveryPanel() {
    _recoveryUsername = '';
    document.getElementById('recovery-step-1').style.display = '';
    document.getElementById('recovery-step-2').style.display = 'none';
    document.getElementById('recovery-step-3').style.display = 'none';
    document.getElementById('recovery-username').value = '';
    document.getElementById('recovery-answer').value = '';
    document.getElementById('recovery-new-pw').value = '';
    document.getElementById('recovery-confirm-pw').value = '';
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

async function handleRecoveryContinue() {
    clearErrors();
    const email = String(document.getElementById('recovery-username')?.value || '').trim();
    if (!email) {
        showError('auth-recovery-error-1', 'Ingresa tu email.');
        return;
    }
    setRecoveryLoading('recovery-continue-btn', true);
    const question = await auth.getSecurityQuestionForRecovery(email);
    setRecoveryLoading('recovery-continue-btn', false);

    if (!question) {
        showError('auth-recovery-error-1',
            'Esta cuenta no tiene pregunta de seguridad configurada. ' +
            'Inicia sesión con tu contraseña actual y podrás configurarla desde tu perfil.');
        return;
    }
    _recoveryUsername = email;
    document.getElementById('recovery-question-text').textContent = question;
    document.getElementById('recovery-step-1').style.display = 'none';
    document.getElementById('recovery-step-2').style.display = '';
    setTimeout(() => document.getElementById('recovery-answer')?.focus(), 60);
}

async function handleRecoveryVerify() {
    clearErrors();
    const answer = String(document.getElementById('recovery-answer')?.value || '').trim();
    if (!answer) {
        showError('auth-recovery-error-2', 'Ingresa tu respuesta.');
        return;
    }
    setRecoveryLoading('recovery-verify-btn', true);
    const ok = await auth.verifySecurityAnswer(_recoveryUsername, answer);
    setRecoveryLoading('recovery-verify-btn', false);

    if (!ok) {
        showError('auth-recovery-error-2', 'No fue posible verificar tu identidad.');
        return;
    }
    document.getElementById('recovery-step-2').style.display = 'none';
    document.getElementById('recovery-step-3').style.display = '';
    setTimeout(() => document.getElementById('recovery-new-pw')?.focus(), 60);
}

async function handleRecoverySave() {
    clearErrors();
    const newPw = String(document.getElementById('recovery-new-pw')?.value || '');
    const confirmPw = String(document.getElementById('recovery-confirm-pw')?.value || '');

    if (newPw !== confirmPw) {
        showError('auth-recovery-error-3', 'Las contraseñas no coinciden.');
        return;
    }
    const answer = String(document.getElementById('recovery-answer')?.value || '').trim();
    setRecoveryLoading('recovery-save-btn', true);
    const result = await auth.resetPassword(_recoveryUsername, answer, newPw);
    setRecoveryLoading('recovery-save-btn', false);

    if (!result.ok) {
        showError('auth-recovery-error-3', result.error);
        return;
    }
    hideRecoveryPanel();
    showToast('¡Contraseña actualizada! Ya puedes ingresar 🎹', 'success');
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

    // Inject SQ setup modal into DOM
    const sqContainer = document.createElement('div');
    sqContainer.innerHTML = buildSQSetupModalHTML();
    document.body.appendChild(sqContainer.firstElementChild);

    // Tab switching
    document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Switch links inside panels (data-tab attribute)
    document.querySelectorAll('.auth-switch-link[data-tab]').forEach(link => {
        link.addEventListener('click', () => switchTab(link.dataset.tab));
    });

    // Close button
    document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);

    // Overlay click outside
    document.getElementById('auth-modal-overlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeModal();
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
            closeSQSetupModal();
        }
    });

    // Forms
    document.getElementById('auth-login-form')?.addEventListener('submit', handleLogin);
    document.getElementById('auth-register-form')?.addEventListener('submit', handleRegister);

    // Enter on login password field
    document.getElementById('login-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('auth-login-form')?.requestSubmit();
        }
    });

    // Password toggles
    setupTogglePassword('login-pw-toggle', 'login-password');
    setupTogglePassword('reg-pw-toggle', 'reg-password');
    setupTogglePassword('recovery-pw-toggle', 'recovery-new-pw');
    setupTogglePassword('sq-pw-toggle', 'sq-current-pw');

    // SQ setup modal events
    document.getElementById('sq-setup-close')?.addEventListener('click', closeSQSetupModal);
    document.getElementById('sq-setup-overlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeSQSetupModal();
    });
    document.getElementById('sq-setup-form')?.addEventListener('submit', handleSQSetupSave);

    // Strength bar
    document.getElementById('reg-password')?.addEventListener('input', (e) => {
        updateStrengthBar(e.target.value);
    });

    // Forgot password link
    document.getElementById('auth-forgot-link')?.addEventListener('click', showRecoveryPanel);

    // Recovery back link
    document.getElementById('recovery-back-link')?.addEventListener('click', hideRecoveryPanel);

    // Recovery step buttons
    document.getElementById('recovery-continue-btn')?.addEventListener('click', handleRecoveryContinue);
    document.getElementById('recovery-verify-btn')?.addEventListener('click', handleRecoveryVerify);
    document.getElementById('recovery-save-btn')?.addEventListener('click', handleRecoverySave);

    // Enter key on recovery inputs
    document.getElementById('recovery-username')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRecoveryContinue();
    });
    document.getElementById('recovery-answer')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRecoveryVerify();
    });
    document.getElementById('recovery-confirm-pw')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRecoverySave();
    });

    // Listen for Supabase auth state changes
    auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session) {
            renderLoggedIn(session);
        } else if (event === 'SIGNED_OUT') {
            renderLoggedOut();
        } else if (event === 'USER_UPDATED' && session) {
            renderLoggedIn(session);
        }
    });

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
