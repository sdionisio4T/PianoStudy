import { describe, it, expect } from 'vitest';
import { AuthManager } from '../assets/js/modules/AuthManager.js';

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
