import { db } from './supabase-client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUserId() {
    const { data } = await db.auth.getSession();
    return data?.session?.user?.id || null;
}

function skeletonHTML(rows = 3) {
    return Array.from({ length: rows }, () =>
        `<div class="skeleton-card"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`
    ).join('');
}

function errorHTML(message, retryFn) {
    const id = `retry-${Date.now()}`;
    setTimeout(() => {
        document.getElementById(id)?.addEventListener('click', retryFn);
    }, 0);
    return `<div class="db-error-banner">
        <i class="fas fa-exclamation-circle"></i>
        <span>${message}</span>
        <button id="${id}" class="btn-small">Reintentar</button>
    </div>`;
}

const ERR_MSG = 'Error al conectar. Verifica tu conexión e intenta de nuevo.';

// ── Licks ─────────────────────────────────────────────────────────────────────

export async function loadLicksFromDB() {
    const userId = await getUserId();
    if (!userId) return { data: [], error: null };

    const { data, error } = await db
        .from('licks')
        .select('*')
        .eq('user_id', userId)
        .order('order_index', { ascending: true });

    return { data: data || [], error };
}

export async function insertLick({ name, style, notes, order_index, file_path }) {
    const userId = await getUserId();
    if (!userId) return { data: null, error: new Error('No session') };

    const row = { user_id: userId, name, style, notes: notes || '', order_index: order_index ?? 0 };
    if (file_path) row.file_path = file_path;

    const { data, error } = await db
        .from('licks')
        .insert(row)
        .select()
        .single();

    return { data, error };
}

export async function uploadLickAudio(audioBlob, lickId) {
    const userId = await getUserId();
    if (!userId) return { filePath: null, error: new Error('No session') };

    const ext = audioBlob.type.includes('webm') ? 'webm' : 'wav';
    const filePath = `licks/${userId}/${lickId}.${ext}`;

    const { error } = await db.storage
        .from('recordings')
        .upload(filePath, audioBlob, { contentType: audioBlob.type || 'audio/wav', upsert: true });

    if (error) return { filePath: null, error };
    return { filePath, error: null };
}

export async function updateLick(lickId, fields) {
    const { data, error } = await db
        .from('licks')
        .update(fields)
        .eq('id', lickId)
        .select()
        .single();

    return { data, error };
}

export async function deleteLick(lickId) {
    const { error } = await db.from('licks').delete().eq('id', lickId);
    return { error };
}

export async function updateLickOrder(licks) {
    const userId = await getUserId();
    if (!userId) return;
    const updates = licks.map((lick, i) => ({ id: lick.id, user_id: userId, order_index: i }));
    await db.from('licks').upsert(updates, { onConflict: 'id' });
}

// ── Recordings ────────────────────────────────────────────────────────────────

export async function loadRecordingsFromDB() {
    const userId = await getUserId();
    if (!userId) return { data: [], error: null };

    const { data, error } = await db
        .from('recordings')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    return { data: data || [], error };
}

export async function uploadRecording(audioBlob, name, duration) {
    const userId = await getUserId();
    if (!userId) return { data: null, error: new Error('No session') };

    const filePath = `${userId}/${Date.now()}.webm`;

    const { error: uploadError } = await db.storage
        .from('recordings')
        .upload(filePath, audioBlob, { contentType: 'audio/webm;codecs=opus', upsert: false });

    if (uploadError) return { data: null, error: uploadError };

    const { data, error } = await db
        .from('recordings')
        .insert({ user_id: userId, name, duration, file_path: filePath })
        .select()
        .single();

    return { data, error };
}

export function getRecordingPublicUrl(filePath) {
    const { data } = db.storage.from('recordings').getPublicUrl(filePath);
    return data?.publicUrl || null;
}

export async function deleteRecording(recordingId, filePath) {
    await db.storage.from('recordings').remove([filePath]);
    const { error } = await db.from('recordings').delete().eq('id', recordingId);
    return { error };
}

// ── Custom Artists ────────────────────────────────────────────────────────────

export async function loadCustomArtistsFromDB() {
    const userId = await getUserId();
    if (!userId) return { data: [], error: null };

    const { data, error } = await db
        .from('custom_artists')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    return { data: data || [], error };
}

export async function insertCustomArtist({ name, style, description, tags, youtube_url }) {
    const userId = await getUserId();
    if (!userId) return { data: null, error: new Error('No session') };

    const row = { user_id: userId, name, style: style || '', description: description || '', tags: tags || [] };
    if (youtube_url) row.youtube_url = youtube_url;

    const { data, error } = await db
        .from('custom_artists')
        .insert(row)
        .select()
        .single();

    return { data, error };
}

export async function deleteCustomArtist(artistId) {
    const { error } = await db.from('custom_artists').delete().eq('id', artistId);
    return { error };
}

// ── Favorite Songs ────────────────────────────────────────────────────────────

export async function loadFavoriteSongs() {
    const userId = await getUserId();
    if (!userId) return { data: [], error: null };

    const { data, error } = await db
        .from('favorite_songs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    return { data: data || [], error };
}

export async function insertFavoriteSong({ name, artist, youtube_url, style, notes }) {
    const userId = await getUserId();
    if (!userId) return { data: null, error: new Error('No session') };

    const { data, error } = await db
        .from('favorite_songs')
        .insert({
            user_id: userId,
            name,
            artist: artist || '',
            youtube_url: youtube_url || '',
            style: style || '',
            notes: notes || ''
        })
        .select()
        .single();

    return { data, error };
}

export async function deleteFavoriteSong(songId) {
    const { error } = await db.from('favorite_songs').delete().eq('id', songId);
    return { error };
}

// ── Practice Sessions ─────────────────────────────────────────────────────────

export async function insertPracticeSession({ duration_seconds, date }) {
    const userId = await getUserId();
    if (!userId) return { data: null, error: new Error('No session') };

    const row = {
        user_id: userId,
        duration_seconds: Math.max(0, Math.floor(Number(duration_seconds) || 0)),
        date
    };

    const { data, error } = await db
        .from('practice_sessions')
        .insert(row)
        .select()
        .single();

    return { data, error };
}

export async function loadPracticeSessionsRange({ fromDate, toDate }) {
    const userId = await getUserId();
    if (!userId) return { data: [], error: null };

    const { data, error } = await db
        .from('practice_sessions')
        .select('*')
        .eq('user_id', userId)
        .gte('date', fromDate)
        .lte('date', toDate)
        .order('date', { ascending: true });

    return { data: data || [], error };
}

// ── User profile / consentimiento de IA ──────────────────────────────────────

export async function getMyProfile() {
    const userId = await getUserId();
    if (!userId) return null;

    const { data, error } = await db
        .from('user_profiles')
        .select('plan, paid_until, ai_data_consent, ai_data_consent_at')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('getMyProfile error:', error);
        return null;
    }
    return data;
}

export async function setAiDataConsent(consent) {
    const userId = await getUserId();
    if (!userId) return { error: new Error('No session') };

    const { error } = await db
        .from('user_profiles')
        .update({ ai_data_consent: !!consent, ai_data_consent_at: new Date().toISOString() })
        .eq('id', userId);

    return { error };
}

// ── UI helpers (exported for use in app.js) ───────────────────────────────────

export { skeletonHTML, errorHTML, ERR_MSG };
