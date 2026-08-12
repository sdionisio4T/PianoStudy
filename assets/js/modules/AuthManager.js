import { db } from './supabase-client.js';

export class AuthManager {
    // ── Crypto helpers ────────────────────────────────────────────────────────
    // Se mantienen exportados: son usados por tests y por si se reutilizan a
    // futuro. La recuperación de contraseña ya NO usa hashPassword (ver
    // sendPasswordResetEmail más abajo).

    generateSalt() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

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

    async register({ fullName, username, email, password }) {
        const name = String(fullName || '').trim();
        const user = String(username || '').trim();
        const mail = String(email || '').trim().toLowerCase();
        const pass = String(password || '');

        if (!name) return { ok: false, error: 'El nombre completo es obligatorio.' };

        const userErr = this.validateUsername(user);
        if (userErr) return { ok: false, error: userErr };

        const emailErr = this.validateEmail(mail);
        if (emailErr) return { ok: false, error: emailErr };

        const passErr = this.validatePassword(pass);
        if (passErr) return { ok: false, error: passErr };

        try {
            const { data, error } = await db.auth.signUp({
                email: mail,
                password: pass,
                options: {
                    data: {
                        username: user,
                        displayName: name
                    }
                }
            });

            if (error) return { ok: false, error: this._mapAuthError(error) };
            if (!data.user) return { ok: false, error: 'No se pudo crear la cuenta. Intenta de nuevo.' };

            try {
                await db.from('user_profiles').upsert({
                    id: data.user.id,
                    email: mail,
                    username: user
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

        const mail = await this._resolveEmail(user);
        if (!mail) return { ok: false, error: 'Usuario no encontrado. Ingresa tu email o verifica tu usuario.' };

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

    async _resolveEmail(usernameOrEmail) {
        const val = String(usernameOrEmail || '').trim();
        if (!val) return null;
        if (val.includes('@')) return val.toLowerCase();
        try {
            const { data, error } = await db.rpc('get_email_by_username', { p_username: val });
            if (error || !data) return null;
            return data;
        } catch {
            return null;
        }
    }

    // ── Session ───────────────────────────────────────────────────────────────

    getActiveSession() {
        // Snapshot síncrono — Supabase guarda la sesión en localStorage.
        try {
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

    // ── Password recovery (email link, sin pregunta de seguridad) ─────────────
    // Reemplaza el flujo viejo (setSecurityQuestion / verifySecurityAnswer /
    // resetPassword con pregunta) que estaba roto para usuarios sin sesión
    // cacheada y además era un antipatrón conocido.

    async sendPasswordResetEmail(emailOrUsername) {
        const mail = await this._resolveEmail(emailOrUsername);
        if (!mail) {
            return { ok: false, error: 'No encontramos ninguna cuenta con ese usuario o email.' };
        }
        const emailErr = this.validateEmail(mail);
        if (emailErr) return { ok: false, error: emailErr };

        try {
            const redirectTo = `${window.location.origin}/#recovery`;
            const { error } = await db.auth.resetPasswordForEmail(mail, { redirectTo });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            return { ok: true };
        } catch (e) {
            console.error('sendPasswordResetEmail error:', e);
            return { ok: false, error: 'Error al conectar. Verifica tu conexión e intenta de nuevo.' };
        }
    }

    async applyNewPasswordFromRecovery(newPassword) {
        // Solo se puede llamar cuando la sesión temporal de recovery ya está
        // activa (Supabase la establece al procesar el hash con access_token
        // del link del email). Ver app-init.js.
        const passErr = this.validatePassword(String(newPassword || ''));
        if (passErr) return { ok: false, error: passErr };

        try {
            const { error } = await db.auth.updateUser({ password: newPassword });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            return { ok: true };
        } catch (e) {
            console.error('applyNewPasswordFromRecovery error:', e);
            return { ok: false, error: 'Error al guardar. Intenta de nuevo.' };
        }
    }

    // ── Cambios desde Ajustes (usuario ya logueado) ───────────────────────────

    async changePassword(currentPassword, newPassword) {
        const passErr = this.validatePassword(String(newPassword || ''));
        if (passErr) return { ok: false, error: passErr };

        const session = this.getActiveSession();
        if (!session) return { ok: false, error: 'No hay sesión activa.' };

        // Re-autenticar con la contraseña actual para evitar que un atacante
        // con acceso momentáneo a una sesión abierta cambie la contraseña sin
        // conocer la original.
        try {
            const { error: signInErr } = await db.auth.signInWithPassword({
                email: session.email,
                password: currentPassword
            });
            if (signInErr) return { ok: false, error: 'Contraseña actual incorrecta.' };
        } catch {
            return { ok: false, error: 'Error al verificar la contraseña actual.' };
        }

        try {
            const { error } = await db.auth.updateUser({ password: newPassword });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            return { ok: true };
        } catch (e) {
            console.error('changePassword error:', e);
            return { ok: false, error: 'Error al guardar. Intenta de nuevo.' };
        }
    }

    async changeEmail(newEmail) {
        const mail = String(newEmail || '').trim().toLowerCase();
        const emailErr = this.validateEmail(mail);
        if (emailErr) return { ok: false, error: emailErr };

        try {
            // Supabase envía un mail de confirmación al nuevo email. El cambio
            // se aplica solo cuando el usuario lo confirma.
            const { error } = await db.auth.updateUser({ email: mail });
            if (error) return { ok: false, error: this._mapAuthError(error) };
            return { ok: true };
        } catch (e) {
            console.error('changeEmail error:', e);
            return { ok: false, error: 'Error al guardar. Intenta de nuevo.' };
        }
    }

    async updateDisplayName({ displayName, username }) {
        const name = String(displayName || '').trim();
        const user = String(username || '').trim();

        if (name && name.length < 1) return { ok: false, error: 'El nombre no puede estar vacío.' };
        if (user) {
            const userErr = this.validateUsername(user);
            if (userErr) return { ok: false, error: userErr };
        }

        const patch = {};
        if (name) patch.displayName = name;
        if (user) patch.username = user;

        try {
            const { error } = await db.auth.updateUser({ data: patch });
            if (error) return { ok: false, error: this._mapAuthError(error) };

            // Reflejar el cambio de username también en user_profiles para que
            // el RPC get_email_by_username siga funcionando post-cambio.
            if (user) {
                const session = this.getActiveSession();
                if (session?.userId) {
                    try {
                        await db.from('user_profiles')
                            .update({ username: user })
                            .eq('id', session.userId);
                    } catch (profileErr) {
                        console.warn('updateDisplayName: username sync failed:', profileErr);
                    }
                }
            }
            return { ok: true };
        } catch (e) {
            console.error('updateDisplayName error:', e);
            return { ok: false, error: 'Error al guardar. Intenta de nuevo.' };
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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
