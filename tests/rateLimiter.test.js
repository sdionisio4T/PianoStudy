import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRateLimiter } from '../supabase/functions/_shared/rateLimiter.ts';

afterEach(() => {
    vi.useRealTimers();
});

describe('createRateLimiter', () => {
    it('permite hasta el límite de requests y bloquea la siguiente', () => {
        const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

        expect(limiter.isRateLimited('user-1')).toBe(false); // 1
        expect(limiter.isRateLimited('user-1')).toBe(false); // 2
        expect(limiter.isRateLimited('user-1')).toBe(false); // 3
        expect(limiter.isRateLimited('user-1')).toBe(true);  // 4 — excede el límite
    });

    it('cuenta cada usuario por separado', () => {
        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

        expect(limiter.isRateLimited('user-a')).toBe(false);
        expect(limiter.isRateLimited('user-b')).toBe(false); // usuario distinto, no comparte contador
        expect(limiter.isRateLimited('user-a')).toBe(true);
    });

    it('vuelve a permitir requests después de que pasa la ventana', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-09T00:00:00Z'));

        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
        expect(limiter.isRateLimited('user-1')).toBe(false);
        expect(limiter.isRateLimited('user-1')).toBe(true);

        vi.setSystemTime(new Date('2026-08-09T00:01:01Z')); // +61s, ventana de 60s ya pasó
        expect(limiter.isRateLimited('user-1')).toBe(false);
    });
});
