import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthManager } from '../assets/js/modules/AuthManager.js';
import { db } from '../assets/js/modules/supabase-client.js';

describe('AuthManager.hashPassword (PBKDF2)', () => {
    const auth = new AuthManager();

    it('produce un hash hexadecimal de 64 caracteres (SHA-256 de 256 bits)', async () => {
        const hash = await auth.hashPassword('mi-respuesta-secreta', 'un-salt-cualquiera');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('es determinístico: misma contraseña + mismo salt = mismo hash', async () => {
        const h1 = await auth.hashPassword('firulais', 'salt-fijo');
        const h2 = await auth.hashPassword('firulais', 'salt-fijo');
        expect(h1).toBe(h2);
    });

    it('produce hashes distintos con salts distintos para la misma respuesta', async () => {
        const h1 = await auth.hashPassword('firulais', 'salt-a');
        const h2 = await auth.hashPassword('firulais', 'salt-b');
        expect(h1).not.toBe(h2);
    });
});

describe('AuthManager.generateSalt', () => {
    it('genera un salt hexadecimal de 32 caracteres (16 bytes) y distinto en cada llamada', () => {
        const auth = new AuthManager();
        const s1 = auth.generateSalt();
        const s2 = auth.generateSalt();
        expect(s1).toMatch(/^[0-9a-f]{32}$/);
        expect(s1).not.toBe(s2);
    });
});

describe('AuthManager.sendPasswordResetEmail', () => {
    // Nota: usamos globalThis.window mockeado para poder computar el redirectTo
    // (`${window.location.origin}/#recovery`) desde Node.
    beforeEach(() => {
        globalThis.window = { location: { origin: 'http://localhost:5173' } };
    });

    it('llama a supabase.auth.resetPasswordForEmail con el redirectTo correcto', async () => {
        const auth = new AuthManager();
        const mock = vi.fn().mockResolvedValue({ error: null });
        db.auth = { resetPasswordForEmail: mock };

        const result = await auth.sendPasswordResetEmail('user@example.com');

        expect(result.ok).toBe(true);
        expect(mock).toHaveBeenCalledWith('user@example.com', {
            redirectTo: 'http://localhost:5173/#recovery',
        });
    });

    it('rechaza cuando el username no resuelve a ningún email', async () => {
        const auth = new AuthManager();
        db.auth = { resetPasswordForEmail: vi.fn() };
        db.rpc = vi.fn().mockResolvedValue({ data: null, error: null });

        // Input sin '@' → intenta resolver por username → devuelve null → error.
        const result = await auth.sendPasswordResetEmail('usuario_inexistente');
        expect(result.ok).toBe(false);
        expect(db.auth.resetPasswordForEmail).not.toHaveBeenCalled();
    });

    it('devuelve error legible cuando Supabase responde con error', async () => {
        const auth = new AuthManager();
        db.auth = {
            resetPasswordForEmail: vi.fn().mockResolvedValue({
                error: { message: 'network issue' }
            }),
        };

        const result = await auth.sendPasswordResetEmail('user@example.com');
        expect(result.ok).toBe(false);
        // _mapAuthError traduce 'network' al mensaje amistoso.
        expect(String(result.error)).toContain('conectar');
    });
});

describe('AuthManager (regresión: pregunta de seguridad eliminada)', () => {
    it('ya no expone setSecurityQuestion / verifySecurityAnswer / resetPassword', () => {
        const auth = new AuthManager();
        expect(auth.setSecurityQuestion).toBeUndefined();
        expect(auth.verifySecurityAnswer).toBeUndefined();
        expect(auth.resetPassword).toBeUndefined();
        expect(auth.getSecurityQuestion).toBeUndefined();
        expect(auth.getSecurityQuestionForRecovery).toBeUndefined();
        expect(auth.hasSecurityQuestion).toBeUndefined();
    });
});
