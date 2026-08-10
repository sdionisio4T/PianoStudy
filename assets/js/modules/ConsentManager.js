import { getMyProfile, setAiDataConsent } from './SupabaseDataManager.js';

// Gestiona el consentimiento explícito para usar datos musicales (grabaciones,
// frases MIDI, interacciones con la IA) en el entrenamiento de modelos de IA
// (ver legal/politica-de-privacidad.md sección 4 y legal/terminos-de-servicio.md
// sección 6). Este consentimiento es APARTE de aceptar los Términos de Servicio
// generales — nunca se activa solo, requiere que el usuario elija activamente.
//
// Se pregunta una sola vez por usuario: en cuanto `ai_data_consent_at` deja de
// ser null (haya dicho que sí o que no), no se vuelve a mostrar el modal. Esto
// cubre tanto a usuarios nuevos (se les pregunta en su primer login) como a
// usuarios que ya tenían cuenta antes de que este consentimiento existiera (se
// les pregunta la primera vez que inician sesión después de este cambio).
export class ConsentManager {
    constructor() {
        this._checkedThisPageLoad = false;
        this._modalOpen = false;
    }

    // Llamar después de cualquier inicio de sesión exitoso (login, registro,
    // restauración de sesión). Es seguro llamarla varias veces — solo hace el
    // chequeo real una vez por carga de página.
    async checkAndPrompt() {
        if (this._checkedThisPageLoad || this._modalOpen) return;
        this._checkedThisPageLoad = true;

        const profile = await getMyProfile();
        if (!profile) return; // sin sesión, o el perfil todavía no existe (no debería pasar)
        if (profile.ai_data_consent_at !== null) return; // ya respondió antes (sí o no)

        this._showModal();
    }

    _showModal() {
        if (this._modalOpen || document.getElementById('consent-ai-overlay')) return;
        this._modalOpen = true;

        const wrapper = document.createElement('div');
        wrapper.innerHTML = this._buildModalHTML();
        document.body.appendChild(wrapper.firstElementChild);

        // Muestra con un pequeño delay para que la transición CSS (reusa las
        // clases del modal de auth) se note, igual que el resto de los modales.
        requestAnimationFrame(() => {
            document.getElementById('consent-ai-overlay')?.classList.add('auth-overlay--visible');
            document.getElementById('consent-ai-modal')?.classList.add('auth-modal--visible');
        });

        document.getElementById('consent-ai-accept')?.addEventListener('click', () => this._respond(true));
        document.getElementById('consent-ai-decline')?.addEventListener('click', () => this._respond(false));
    }

    async _respond(consent) {
        const acceptBtn = document.getElementById('consent-ai-accept');
        const declineBtn = document.getElementById('consent-ai-decline');
        if (acceptBtn) acceptBtn.disabled = true;
        if (declineBtn) declineBtn.disabled = true;

        const { error } = await setAiDataConsent(consent);
        if (error) {
            console.error('ConsentManager: error guardando consentimiento:', error);
            // No dejamos al usuario trabado si falla la escritura — cierra igual
            // y se le va a volver a preguntar en el próximo login (ai_data_consent_at
            // sigue en null porque el update falló).
        }

        this._closeModal();
    }

    _closeModal() {
        const overlay = document.getElementById('consent-ai-overlay');
        const modal = document.getElementById('consent-ai-modal');
        overlay?.classList.remove('auth-overlay--visible');
        modal?.classList.remove('auth-modal--visible');
        setTimeout(() => overlay?.remove(), 250);
        this._modalOpen = false;
    }

    _buildModalHTML() {
        // Sin botón de cerrar ("x") a propósito: el consentimiento tiene que
        // ser una elección activa (sí o no), no algo que se descarta sin
        // responder. "No, gracias" es una respuesta tan válida y fácil de
        // elegir como "Sí" — no es un patrón oscuro, es la misma idea que un
        // banner de cookies con Aceptar/Rechazar al mismo nivel.
        return `
<div id="consent-ai-overlay" class="auth-overlay" role="dialog" aria-modal="true" aria-label="Consentimiento de datos musicales para IA">
    <div id="consent-ai-modal" class="auth-modal">
        <p class="auth-recovery-title" style="margin-bottom:0.5rem">
            <i class="fas fa-robot" style="color:var(--accent-green);margin-right:0.4rem"></i>
            Ayudanos a mejorar la IA de PianoStudy
        </p>
        <p style="color:var(--text-secondary);font-size:0.85rem;line-height:1.5;margin-bottom:0.75rem">
            Hoy tus grabaciones y frases MIDI se usan solo para darte el servicio
            (analizarlas, transcribirlas y mostrártelas a vos). Si querés, podés
            darnos permiso para usarlas también para mejorar nuestros modelos de
            inteligencia artificial (por ejemplo, el motor que genera variaciones
            musicales en NeuralJam).
        </p>
        <p style="color:var(--text-secondary);font-size:0.85rem;line-height:1.5;margin-bottom:1.25rem">
            Es completamente opcional: uses o no esta opción, seguís teniendo
            acceso a todas las funciones de PianoStudy igual. Podés cambiar de
            opinión cuando quieras desde Ajustes. Más detalle en nuestra
            Política de Privacidad.
        </p>
        <div class="form-actions" style="display:flex;gap:0.75rem;flex-wrap:wrap">
            <button class="btn-primary" id="consent-ai-accept" type="button">
                <i class="fas fa-check"></i> Sí, quiero ayudar
            </button>
            <button class="btn-secondary" id="consent-ai-decline" type="button">
                No, gracias
            </button>
        </div>
    </div>
</div>`;
    }
}

export const consentManager = new ConsentManager();
