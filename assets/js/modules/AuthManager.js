import { db } from './supabase-client.js';

export class AuthManager {
    // ── Crypto helpers ────────────────────────────────────────────────────────

    generateSalt() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // PBKDF2-SHA256, 100k iteraciones — protege las respuestas de seguridad
    // (cortas y adivinables) contra brute-force por GPU, a diferencia de un
    // SHA-256 directo que es demasiado rápido para ese propósito.
    async hashPassword(password, salt) {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveBits']
        );
        const derivedBits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: encoder.encode(salt),
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            256
        );
        const hashArray = Array.from(new Uint8Array(derivedBits));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ── Validation ────────────────────────────────────────────────────────────

    validateUsername(username) {
        if (typeof username !== 'string') return 'El usuario debe ser texto.';
        if (username.length < 3) return 'El usuario debe tener al menos 3 caracteres.';
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'El usuario solo puede contener letras, números y _.';
        return null;
    }

    validateEmail(email) {
        if (typeof email !== 'string') return 'El email debe ser texto.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'El email no tiene un formato válido.';
        return null;
    }

    validatePassword(password) {
        if (typeof password !== 'string') return 'La contraseña debe ser texto.';
        if (password.length < 6) return 'La contraseña debe tener al menos 6 caracteres.';
        return null;
    }

    passwordStrength(password) {
        const p = String(password || '');
        if (p.length === 0) return { level: 0, label: '' };
        if (p.length < 6) return { level: 1, label: 'Muy débil' };

        let score = 0;
        if (p.length >= 8) score++;
        if (p.length >= 12) score++;
        if (/[A-Z]/.test(p)) score++;
        if (/[0-9]/.test(p)) score++;
        if (/[^a-zA-Z0-9]/.test(p)) score++;

        if (score <= 1) return { level: 2, label: 'Débil' };
        if (score === 2) return { level: 3, label: 'Media' };
        if (score === 3) return { level: 4, label: 'Buena' };
        return { level: 5, label: 'Fuerte' };
    }

    // ── Registration ──────────────────────────────────────────────────────────

    async register({ fullName, username, email, password, securityQuestion, securityAnswer }) {
        const name = String(fullName || '').trim();
        const user = String(username || '').trim();
        const mail = String(email || '').trim().toLowerCase();
        const pass = String(password || '');
        const question = String(securityQuestion || '').trim();
        const answer = String(securityAnswer || '').trim().toLowerCase();

        if (!name) return { ok: false, error: 'El nombre completo es obligatorio.' };

        const userErr = this.validateUsername(user);
        if (userErr) return { ok: false, error: userErr };

        const emailErr = this.validateEmail(mail);
        if (emailErr) return { ok: false, error: emailErr };

        const passErr = this.validatePassword(pass);
        if (passErr) return { ok: false, error: passErr };

        if (!question) return { ok: false, error: 'Selecciona una pregunta de seguridad.' };
        if (answer.length < 2) return { ok: false, error: 'La respuesta de seguridad es demasiado corta.' };

        const answerSalt = this.generateSalt();
        const answerHash = await this.hashPassword(answer, answerSalt);

        try {
            const { data, error } = await db.auth.signUp({
                email: mail,
                password: pass,
                options: {
                    data: {
                        username: user,
                        displayName: name,
                        securityQuestion: question,
                        answerSalt,
                        answerHash
                    }
                }
            });

            if (error) return { ok: false, error: this._mapAuthError(error) };
            if (!data.user) return { ok: false, error: 'No se pudo crear la cuenta. Intenta de nuevo.' };

            try {
                await db.from('user_profiles').upsert({
                    id: data.user.id,
                    email: mail,
                    username: user,
                    security_question: question
                }, { onConflict: 'id' });
            } catch (profileErr) {
                console.warn('register: could not upsert user_profiles:', profileErr);
            }

            return { ok: true, user: this._publicUser(data.user) };
        } catch (e) {
            console.error('register error:', e);
            return { ok: false, error: 'Error al conectar. Verifica tu conexión e intenta de nuevo.' };
        }
    }

    // ── Login ─────────────────────────────────────────────────────────────────

    async login({ username, password }) {
        const user = String(username || '').trim();
        const pass = String(password || '');

        if (!user || !pass) return { ok: false, error: 'Usuario o contraseña incorrectos.' };

        let mail = user;
        if (!user.includes('@')) {
            try {
                const { data: rpcData, error: rpcErr } = await db.rpc('get_email_by_username', { p_username: user });
                if (rpcErr || !rpcData) {
                    return { ok: false, error: 'Usuario no encontrado. Ingresa tu email o verifica tu usuario.' };
                }
                mail = rpcData;
            } catch {
                return { ok: false, error: 'Usuario no encontrado. Ingresa tu email o verifica tu usuario.' };
            }
        }

        try {
            const { data, error } = await db.auth.signInWithPassword({ email: mail, password: pass });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            if (!data.user) return { ok: false, error: 'Usuario o contraseña incorrectos.' };

            return { ok: true, user: this._publicUser(data.user) };
        } catch (e) {
            console.error('login error:', e);
            return { ok: false, error: 'Error al conectar. Verifica tu conexión e intenta de nuevo.' };
        }
    }

    // ── Session ───────────────────────────────────────────────────────────────

    getActiveSession() {
        // Synchronous snapshot — Supabase stores session in localStorage internally.
        // Returns a session-like object compatible with auth-ui.js expectations.
        try {
            // Access the raw Supabase session from its internal storage key
            const keys = Object.keys(localStorage);
            const sbKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
            if (!sbKey) return null;
            const raw = localStorage.getItem(sbKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const supaSession = parsed?.session ?? parsed;
            if (!supaSession?.user) return null;
            if (supaSession.expires_at && Date.now() / 1000 > supaSession.expires_at) return null;
            return this._sessionFromSupaUser(supaSession.user);
        } catch {
            return null;
        }
    }

    async getActiveSessionAsync() {
        try {
            const { data } = await db.auth.getSession();
            if (!data?.session?.user) return null;
            return this._sessionFromSupaUser(data.session.user);
        } catch {
            return null;
        }
    }

    onAuthStateChange(callback) {
        return db.auth.onAuthStateChange((event, session) => {
            callback(event, session ? this._sessionFromSupaUser(session.user) : null);
        });
    }

    async logout() {
        try {
            await db.auth.signOut();
        } catch (e) {
            console.error('logout error:', e);
        }
    }

    // ── Password recovery (security questions) ────────────────────────────────
    // Security question data is stored in user_metadata, not queryable by username
    // from the client without knowing the user's session. Recovery flow:
    // Step 1 — user enters their email → we fetch their metadata via a sign-in attempt
    // with a dummy password to get the user record. Instead we store sq data in a
    // public 'user_profiles' table, but since that table may not exist yet we keep
    // a graceful fallback using the session-based approach.

    getSecurityQuestion(usernameOrEmail) {
        // Can only retrieve SQ for the currently logged-in user synchronously.
        // For recovery (not logged in), we need the async version.
        const session = this.getActiveSession();
        if (!session) return null;
        const meta = this._getRawMetadata();
        return meta?.securityQuestion || null;
    }

    async getSecurityQuestionForRecovery(email) {
        // We can't query another user's metadata without their session.
        // Store SQ in a public profiles table for recovery. If not available, return null.
        try {
            const { data } = await db
                .from('user_profiles')
                .select('security_question')
                .eq('email', email.toLowerCase().trim())
                .maybeSingle();
            return data?.security_question || null;
        } catch {
            return null;
        }
    }

    async verifySecurityAnswer(usernameOrEmail, answer) {
        const ans = String(answer || '').trim().toLowerCase();
        // For logged-in user (SQ setup flow)
        const meta = this._getRawMetadata();
        if (!meta?.answerHash || !meta?.answerSalt) {
            await this.hashPassword(ans, 'dummy-salt-00000000000000000000000000000000');
            return false;
        }
        const hash = await this.hashPassword(ans, meta.answerSalt);
        return hash === meta.answerHash;
    }

    async resetPassword(usernameOrEmail, answer, newPassword) {
        const passErr = this.validatePassword(String(newPassword || ''));
        if (passErr) return { ok: false, error: passErr };

        // Supabase password reset requires an email link flow for unauthenticated users.
        // Since we have security questions, we verify the answer then update via the session.
        const verified = await this.verifySecurityAnswer(usernameOrEmail, answer);
        if (!verified) return { ok: false, error: 'No fue posible verificar tu identidad.' };

        try {
            const { error } = await db.auth.updateUser({ password: newPassword });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            return { ok: true };
        } catch (e) {
            console.error('resetPassword error:', e);
            return { ok: false, error: 'Error al guardar. Intenta de nuevo.' };
        }
    }

    hasSecurityQuestion(username) {
        const meta = this._getRawMetadata();
        return !!(meta?.securityQuestion && meta?.answerHash);
    }

    async setSecurityQuestion(username, currentPassword, question, answer) {
        const q = String(question || '').trim();
        const ans = String(answer || '').trim().toLowerCase();

        if (!q) return { ok: false, error: 'Selecciona una pregunta de seguridad.' };
        if (ans.length < 2) return { ok: false, error: 'La respuesta es demasiado corta.' };

        // Verify current password by re-authenticating
        const session = this.getActiveSession();
        if (!session) return { ok: false, error: 'No hay sesión activa.' };

        try {
            const { error: signInErr } = await db.auth.signInWithPassword({
                email: session.email,
                password: currentPassword
            });
            if (signInErr) return { ok: false, error: 'Contraseña incorrecta.' };
        } catch {
            return { ok: false, error: 'Error al verificar contraseña.' };
        }

        const answerSalt = this.generateSalt();
        const answerHash = await this.hashPassword(ans, answerSalt);

        try {
            const { error } = await db.auth.updateUser({
                data: { securityQuestion: q, answerSalt, answerHash }
            });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            return { ok: true };
        } catch (e) {
            console.error('setSecurityQuestion error:', e);
            return { ok: false, error: 'Error al guardar. Intenta de nuevo.' };
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _getRawMetadata() {
        try {
            const keys = Object.keys(localStorage);
            const sbKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
            if (!sbKey) return null;
            const raw = localStorage.getItem(sbKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const supaSession = parsed?.session ?? parsed;
            return supaSession?.user?.user_metadata || null;
        } catch {
            return null;
        }
    }

    _sessionFromSupaUser(user) {
        const meta = user.user_metadata || {};
        return {
            userId: user.id,
            username: meta.username || user.email?.split('@')[0] || 'usuario',
            fullName: meta.displayName || meta.username || 'Usuario',
            email: user.email
        };
    }

    _publicUser(supaUser) {
        const meta = supaUser.user_metadata || {};
        return {
            id: supaUser.id,
            fullName: meta.displayName || meta.username || 'Usuario',
            username: meta.username || supaUser.email?.split('@')[0] || 'usuario',
            email: supaUser.email
        };
    }

    _mapAuthError(error) {
        const msg = error?.message || '';
        if (msg.includes('Invalid login')) return 'Email o contraseña incorrectos.';
        if (msg.includes('Email not confirmed')) return 'Confirma tu email antes de ingresar.';
        if (msg.includes('User already registered')) return 'Ese email ya está registrado.';
        if (msg.includes('Password should be')) return 'La contraseña debe tener al menos 6 caracteres.';
        if (msg.includes('network') || msg.includes('fetch')) return 'Error al conectar. Verifica tu conexión e intenta de nuevo.';
        return msg || 'Error desconocido. Intenta de nuevo.';
    }
}
