// app-settings.js — sección "Ajustes" (cuenta, privacidad/RGPD, preferencias,
// eliminación de cuenta). Mixin mezclado sobre PianoStudyApp.prototype en
// app-init.js.
//
// El HTML de las 4 tarjetas y los modales asociados vive en index.html
// (bloque #settings + #settings-change-password-overlay, #settings-change-email-overlay,
// #settings-delete-overlay, #settings-cancel-deletion-overlay). Este archivo
// solo hidrata inputs, engancha handlers y llama a los módulos que hacen
// las mutaciones reales (AuthManager, SupabaseDataManager, Edge Function
// delete-account).

import { AuthManager } from '../modules/AuthManager.js';
import { toast } from '../modules/Toast.js';
import { db } from '../modules/supabase-client.js';
import {
    getMyProfile,
    setAiDataConsent,
    setDefaultStyle,
    cancelAccountDeletion,
    exportAllUserData,
    downloadRecordingBlob,
} from '../modules/SupabaseDataManager.js';

const auth = new AuthManager();

// ── Helpers de modal ─────────────────────────────────────────────────────────

function openOverlay(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.add('auth-overlay--visible');
    overlay.querySelector('.auth-modal')?.classList.add('auth-modal--visible');
}

function closeOverlay(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.remove('auth-overlay--visible');
    overlay.querySelector('.auth-modal')?.classList.remove('auth-modal--visible');
}

function setFormLoading(formId, loading) {
    const btn = document.querySelector(`#${formId} .auth-submit-btn`);
    if (!btn) return;
    btn.disabled = loading;
    const spinner = btn.querySelector('.auth-spinner');
    const label = btn.querySelector('.auth-btn-label');
    if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
    if (label) label.style.opacity = loading ? '0.5' : '1';
}

function showFormError(errId, message) {
    const el = document.getElementById(errId);
    if (!el) return;
    el.textContent = message;
    el.classList.remove('auth-error--shake');
    void el.offsetWidth;
    el.classList.add('auth-error--shake');
}

function clearFormError(errId) {
    const el = document.getElementById(errId);
    if (!el) return;
    el.textContent = '';
    el.classList.remove('auth-error--shake');
}

// ── ZIP helper ───────────────────────────────────────────────────────────────

async function ensureJSZip() {
    // JSZip se carga por CDN en index.html (defer). Si el usuario abrió esta
    // sección antes de que termine de descargarse, lo esperamos un poco.
    if (window.JSZip) return window.JSZip;
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const interval = setInterval(() => {
            if (window.JSZip) {
                clearInterval(interval);
                resolve(window.JSZip);
            } else if (Date.now() - started > 8000) {
                clearInterval(interval);
                reject(new Error('No se pudo cargar la librería de compresión (JSZip).'));
            }
        }, 100);
    });
}

// ── El mixin propiamente ──────────────────────────────────────────────────────

export const settingsMixin = {
    // Llamado por app-ui.js:showSection('settings').
    async renderSettings() {
        const signedOut = document.getElementById('settings-signed-out');
        const signedIn = document.getElementById('settings-signed-in');
        const session = auth.getActiveSession();

        if (!session) {
            if (signedOut) signedOut.style.display = '';
            if (signedIn) signedIn.style.display = 'none';
            return;
        }

        if (signedOut) signedOut.style.display = 'none';
        if (signedIn) signedIn.style.display = '';

        // Wiring una sola vez (los botones tienen data-action, así que ya los
        // captura el listener global de app-ui.js — pero necesitamos enganchar
        // los submits de los forms y el input listener del textbox "ELIMINAR").
        if (!this._settingsWired) {
            this._wireSettings();
            this._settingsWired = true;
        }

        // Datos básicos de la sesión (email/username/nombre) desde el usuario.
        const emailInput = document.getElementById('settings-email');
        const nameInput = document.getElementById('settings-display-name');
        const userInput = document.getElementById('settings-username');
        if (emailInput) emailInput.value = session.email || '';
        if (nameInput) nameInput.value = session.fullName || '';
        if (userInput) userInput.value = session.username || '';

        // Perfil (consentimiento, estilo por defecto).
        const profile = await getMyProfile();
        const consentToggle = document.getElementById('settings-ai-consent');
        if (consentToggle) consentToggle.checked = !!(profile && profile.ai_data_consent);
        const styleSelect = document.getElementById('settings-default-style');
        if (styleSelect) styleSelect.value = (profile && profile.default_style) || '';
    },

    _wireSettings() {
        // Toggle de consentimiento IA — persiste al vuelo.
        document.getElementById('settings-ai-consent')?.addEventListener('change', async (e) => {
            const { error } = await setAiDataConsent(!!e.target.checked);
            if (error) {
                toast.error('No se pudo guardar el consentimiento. Intentá de nuevo.');
                e.target.checked = !e.target.checked; // revert visual
                return;
            }
            toast.exito(e.target.checked
                ? 'Consentimiento activado. Gracias por ayudarnos a mejorar la IA.'
                : 'Consentimiento desactivado. Tus datos ya no se usarán para entrenar la IA.');
        });

        // Forms de modales
        document.getElementById('settings-cp-form')?.addEventListener('submit', (e) => this._handleChangePassword(e));
        document.getElementById('settings-ce-form')?.addEventListener('submit', (e) => this._handleChangeEmail(e));
        document.getElementById('settings-del-form')?.addEventListener('submit', (e) => this._handleDeleteAccount(e));

        // Habilitación del botón "Eliminar" solo cuando el input coincide exacto.
        const confirmInput = document.getElementById('settings-del-confirm');
        const passwordInput = document.getElementById('settings-del-password');
        const submitBtn = document.getElementById('settings-del-submit');
        const refreshDelBtn = () => {
            if (!submitBtn) return;
            const okText = confirmInput?.value.trim() === 'ELIMINAR';
            const okPass = (passwordInput?.value || '').length >= 1;
            submitBtn.disabled = !(okText && okPass);
        };
        confirmInput?.addEventListener('input', refreshDelBtn);
        passwordInput?.addEventListener('input', refreshDelBtn);
    },

    // ── Guardar nombre público / usuario ──────────────────────────────────────

    async saveProfile() {
        const nameInput = document.getElementById('settings-display-name');
        const userInput = document.getElementById('settings-username');
        const displayName = nameInput?.value || '';
        const username = userInput?.value || '';

        const session = auth.getActiveSession();
        if (!session) { toast.error('Necesitás iniciar sesión.'); return; }

        // No enviar patch si nada cambió.
        const changedName = displayName.trim() && displayName.trim() !== session.fullName;
        const changedUser = username.trim() && username.trim() !== session.username;
        if (!changedName && !changedUser) {
            toast.info('No hay cambios para guardar.');
            return;
        }

        const result = await auth.updateDisplayName({ displayName, username });
        if (!result.ok) {
            toast.error(result.error);
            return;
        }
        toast.exito('Perfil actualizado.');
    },

    // ── Cambiar contraseña ────────────────────────────────────────────────────

    openChangePasswordModal() {
        clearFormError('settings-cp-error');
        ['settings-cp-current', 'settings-cp-new', 'settings-cp-confirm'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        openOverlay('settings-change-password-overlay');
        setTimeout(() => document.getElementById('settings-cp-current')?.focus(), 80);
    },

    closeChangePasswordModal() {
        closeOverlay('settings-change-password-overlay');
    },

    async _handleChangePassword(e) {
        e.preventDefault();
        clearFormError('settings-cp-error');

        const cur = document.getElementById('settings-cp-current')?.value || '';
        const nw = document.getElementById('settings-cp-new')?.value || '';
        const cf = document.getElementById('settings-cp-confirm')?.value || '';

        if (nw !== cf) {
            showFormError('settings-cp-error', 'Las contraseñas nuevas no coinciden.');
            return;
        }

        setFormLoading('settings-cp-form', true);
        const result = await auth.changePassword(cur, nw);
        setFormLoading('settings-cp-form', false);

        if (!result.ok) {
            showFormError('settings-cp-error', result.error);
            return;
        }

        this.closeChangePasswordModal();
        toast.exito('Contraseña actualizada.');
    },

    // ── Cambiar email ─────────────────────────────────────────────────────────

    openChangeEmailModal() {
        clearFormError('settings-ce-error');
        const inp = document.getElementById('settings-ce-new');
        if (inp) inp.value = '';
        openOverlay('settings-change-email-overlay');
        setTimeout(() => inp?.focus(), 80);
    },

    closeChangeEmailModal() {
        closeOverlay('settings-change-email-overlay');
    },

    async _handleChangeEmail(e) {
        e.preventDefault();
        clearFormError('settings-ce-error');

        const newEmail = document.getElementById('settings-ce-new')?.value || '';

        setFormLoading('settings-ce-form', true);
        const result = await auth.changeEmail(newEmail);
        setFormLoading('settings-ce-form', false);

        if (!result.ok) {
            showFormError('settings-ce-error', result.error);
            return;
        }

        this.closeChangeEmailModal();
        toast.exito('Te enviamos un mail al nuevo email. El cambio se aplica cuando lo confirmes.');
    },

    // ── Estilo por defecto ────────────────────────────────────────────────────

    async saveDefaultStyle() {
        const styleSelect = document.getElementById('settings-default-style');
        const val = styleSelect?.value || '';
        const { error } = await setDefaultStyle(val);
        if (error) { toast.error('No se pudo guardar. Intentá de nuevo.'); return; }
        toast.exito('Preferencia guardada.');
    },

    // ── Export RGPD ───────────────────────────────────────────────────────────

    async exportUserData() {
        const btn = document.getElementById('settings-export-btn');
        const statusEl = document.getElementById('settings-export-status');

        const setStatus = (msg) => {
            if (!statusEl) return;
            statusEl.style.display = msg ? '' : 'none';
            statusEl.textContent = msg;
        };

        try {
            if (btn) btn.disabled = true;
            setStatus('Preparando…');

            let JSZip;
            try {
                JSZip = await ensureJSZip();
            } catch (e) {
                toast.error(e.message || 'No se pudo cargar la librería de compresión.');
                setStatus('');
                return;
            }

            const { data, error } = await exportAllUserData();
            if (error || !data) {
                toast.error('No se pudieron leer tus datos. Intentá de nuevo.');
                setStatus('');
                return;
            }

            const zip = new JSZip();

            // Un JSON con TODO el snapshot.
            zip.file('mis-datos.json', JSON.stringify(data, null, 2));

            // README explicativo.
            zip.file('README.txt',
                'PianoStudy — Export de datos personales (RGPD art. 20)\n' +
                '=========================================================\n\n' +
                `Fecha del export: ${data.exportedAt}\n` +
                `User ID: ${data.userId}\n\n` +
                'Contenido:\n' +
                '  - mis-datos.json — todas tus filas en las tablas del proyecto.\n' +
                '  - recordings/ — tus archivos de audio (una carpeta por cada grabación).\n\n' +
                'Este archivo es tuyo. Podés guardarlo, moverlo o borrarlo cuando quieras.\n' +
                'Si tenés dudas, consultá la Política de Privacidad en la app.\n'
            );

            // Descargar los audios uno por uno (best-effort — si alguno falla,
            // seguimos con el resto y anotamos el error en el README).
            const audioFolder = zip.folder('recordings');
            const errores = [];
            let bajados = 0;

            for (const rec of data.recordings) {
                if (!rec.file_path) continue;
                setStatus(`Descargando audio ${bajados + 1} de ${data.recordings.length}…`);
                const { blob, error: dlErr } = await downloadRecordingBlob(rec.file_path);
                if (dlErr || !blob) {
                    errores.push(`${rec.file_path}: ${dlErr?.message || 'no encontrado'}`);
                    continue;
                }
                const ext = blob.type.includes('webm') ? 'webm' :
                            blob.type.includes('wav')  ? 'wav'  :
                            blob.type.includes('mpeg') ? 'mp3'  : 'audio';
                const safeName = String(rec.name || rec.id || 'grabacion')
                    .replace(/[\\/:*?"<>|]/g, '_')
                    .slice(0, 80);
                audioFolder.file(`${rec.id || bajados}_${safeName}.${ext}`, blob);
                bajados++;
            }

            if (errores.length) {
                zip.file('recordings/_errores.txt', errores.join('\n'));
            }

            setStatus('Comprimiendo…');
            const zipBlob = await zip.generateAsync({ type: 'blob' });

            const today = new Date().toISOString().slice(0, 10);
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pianostudy-mis-datos-${today}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 4000);

            setStatus('');
            toast.exito(`Listo. ${bajados} audio(s) incluidos.${errores.length ? ` (${errores.length} con error)` : ''}`);
        } catch (e) {
            console.error('exportUserData error:', e);
            toast.error('Error al preparar el export. Intentá de nuevo.');
            setStatus('');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    // ── Eliminar cuenta (soft-delete + purga a 30 días) ───────────────────────

    openDeleteAccountModal() {
        clearFormError('settings-del-error');
        ['settings-del-confirm', 'settings-del-password'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const submit = document.getElementById('settings-del-submit');
        if (submit) submit.disabled = true;
        openOverlay('settings-delete-overlay');
        setTimeout(() => document.getElementById('settings-del-confirm')?.focus(), 80);
    },

    closeDeleteAccountModal() {
        closeOverlay('settings-delete-overlay');
    },

    async _handleDeleteAccount(e) {
        e.preventDefault();
        clearFormError('settings-del-error');

        const confirmVal = document.getElementById('settings-del-confirm')?.value.trim() || '';
        const password = document.getElementById('settings-del-password')?.value || '';

        if (confirmVal !== 'ELIMINAR') {
            showFormError('settings-del-error', 'Tenés que escribir ELIMINAR para confirmar.');
            return;
        }

        const session = auth.getActiveSession();
        if (!session) {
            showFormError('settings-del-error', 'Sesión expirada. Volvé a iniciar sesión.');
            return;
        }

        setFormLoading('settings-del-form', true);

        // 1. Verificar la contraseña actual re-autenticando.
        try {
            const { error: signErr } = await db.auth.signInWithPassword({
                email: session.email,
                password
            });
            if (signErr) {
                setFormLoading('settings-del-form', false);
                showFormError('settings-del-error', 'Contraseña incorrecta.');
                return;
            }
        } catch {
            setFormLoading('settings-del-form', false);
            showFormError('settings-del-error', 'No se pudo verificar tu contraseña.');
            return;
        }

        // 2. Invocar Edge Function que marca la cuenta.
        try {
            const { data, error } = await db.functions.invoke('delete-account', { body: {} });
            if (error || !data?.ok) {
                setFormLoading('settings-del-form', false);
                showFormError('settings-del-error',
                    'No se pudo marcar la cuenta para eliminación. Intentá de nuevo.');
                return;
            }
        } catch (e) {
            setFormLoading('settings-del-form', false);
            showFormError('settings-del-error', 'Error al conectar. Intentá de nuevo.');
            console.error('deleteAccount invoke error:', e);
            return;
        }

        // 3. Cerrar sesión local (por si el admin.signOut del server no corrió).
        try { await db.auth.signOut(); } catch { /* no-op */ }

        setFormLoading('settings-del-form', false);
        this.closeDeleteAccountModal();
        toast.exito('Cuenta marcada para eliminación. Tenés 30 días para cancelar iniciando sesión.');
    },

    // ── Cancelar eliminación (llamado desde el modal post-login) ──────────────

    async cancelPendingDeletion() {
        const { error } = await cancelAccountDeletion();
        if (error) {
            toast.error('No se pudo cancelar. Intentá de nuevo.');
            return;
        }
        closeOverlay('settings-cancel-deletion-overlay');
        toast.exito('Cancelación confirmada. Tu cuenta sigue activa.');
    },

    keepPendingDeletion() {
        closeOverlay('settings-cancel-deletion-overlay');
    },

    // Chequea al arrancar la sesión si hay una eliminación pendiente y muestra
    // el modal. Se llama desde app-init.js cuando hay sesión activa.
    async checkPendingDeletion() {
        try {
            const profile = await getMyProfile();
            if (!profile || !profile.deleted_at) return;
            const scheduled = profile.deletion_scheduled_for;
            if (!scheduled) return;
            const scheduledMs = new Date(scheduled).getTime();
            if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now()) return; // ya pasó
            const dateEl = document.getElementById('settings-cancel-deletion-date');
            if (dateEl) {
                try {
                    dateEl.textContent = new Date(scheduledMs).toLocaleDateString('es-ES', {
                        year: 'numeric', month: 'long', day: 'numeric'
                    });
                } catch {
                    dateEl.textContent = scheduled;
                }
            }
            openOverlay('settings-cancel-deletion-overlay');
        } catch (e) {
            console.warn('checkPendingDeletion error:', e);
        }
    },
};
