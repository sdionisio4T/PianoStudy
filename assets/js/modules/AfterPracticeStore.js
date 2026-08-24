// AfterPracticeStore
// ─────────────────────────────────────────────────────────────────────────────
// Persistencia local de las tomas B ("después de practicar") asociadas a un
// análisis. Vive en IndexedDB porque los blobs de audio no caben cómodos en
// localStorage. Solo guarda una toma por análisis: regrabar reemplaza.
//
// Contrato:
//   const key = `${recordingId}.${timestamp}`
//   await saveTake(key, blob, { duration })
//   const take = await getTake(key)   // → { blob, mime, duration, createdAt } | null
//   await deleteTake(key)
//
// Falla silenciosamente si IndexedDB no está disponible (modo privado antiguo,
// storage lleno). El caller debe manejar null como "no hay toma".

// DB propia y aislada: no compartimos con 'pianostudy' que ya usa
// loadAnalysisAudioFromDb para el store analysis_audio. Si abriéramos la
// misma DB a la misma versión, onupgradeneeded no se dispararía y este
// store nunca se crearía (NotFoundError al hacer transaction).
const DB_NAME = 'pianostudy_afterpractice';
const DB_VERSION = 1;
const STORE_NAME = 'afterPracticeTakes';

let _dbPromise = null;

function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB no disponible'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _dbPromise;
}

function _tx(db, mode) {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

export async function saveTake(key, blob, meta = {}) {
    if (!key || !(blob instanceof Blob)) return false;
    try {
        const db = await _openDb();
        const record = {
            blob,
            mime: blob.type || 'audio/webm',
            duration: Number(meta.duration) || 0,
            createdAt: Date.now(),
        };
        await new Promise((resolve, reject) => {
            const req = _tx(db, 'readwrite').put(record, String(key));
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
        });
        return true;
    } catch (err) {
        console.warn('[AfterPracticeStore] saveTake falló:', err);
        return false;
    }
}

export async function getTake(key) {
    if (!key) return null;
    try {
        const db = await _openDb();
        return await new Promise((resolve, reject) => {
            const req = _tx(db, 'readonly').get(String(key));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn('[AfterPracticeStore] getTake falló:', err);
        return null;
    }
}

export async function deleteTake(key) {
    if (!key) return false;
    try {
        const db = await _openDb();
        await new Promise((resolve, reject) => {
            const req = _tx(db, 'readwrite').delete(String(key));
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
        });
        return true;
    } catch (err) {
        console.warn('[AfterPracticeStore] deleteTake falló:', err);
        return false;
    }
}
