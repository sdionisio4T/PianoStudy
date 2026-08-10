import { escapeHtml } from '../utils/sanitizers.js';
import { styleColors, styleLabels } from '../data/artists.js';

function songCardHtml(song) {
    const color = styleColors[song.style] || '#888';
    const label = styleLabels[song.style] || song.style || '';
    const ytUrl = song.youtube_url || '';
    return `
        <div class="fav-card" data-song-id="${escapeHtml(String(song.id))}">
            <div class="fav-card-body">
                <div class="fav-card-top">
                    <div class="fav-card-titles">
                        <h4 class="fav-card-name">${escapeHtml(song.name)}</h4>
                        ${song.artist ? `<span class="fav-card-artist">${escapeHtml(song.artist)}</span>` : ''}
                    </div>
                    ${label ? `<span class="artist-style-badge" style="background:${color}22;color:${color};border:1px solid ${color}55">${escapeHtml(label)}</span>` : ''}
                </div>
                ${song.notes ? `<p class="fav-card-notes">${escapeHtml(song.notes)}</p>` : ''}
                <div class="fav-card-actions">
                    ${ytUrl ? `<a class="btn-small fav-yt-btn" href="${escapeHtml(ytUrl)}" target="_blank" rel="noopener noreferrer">
                        <i class="fab fa-youtube"></i> Reproducir
                    </a>` : ''}
                    <button class="btn-small btn-danger fav-delete-btn" data-action="fav-delete" data-id="${escapeHtml(String(song.id))}">
                        <i class="fas fa-trash"></i> Eliminar
                    </button>
                </div>
            </div>
        </div>`;
}

function emptyHtml() {
    return `<div class="fav-empty">
        <i class="fas fa-heart" style="font-size:2.5rem;color:var(--accent-green,#00ff41);opacity:0.4"></i>
        <p>Agrega tus canciones favoritas para tenerlas siempre a mano</p>
    </div>`;
}

function authBannerHtml() {
    return `<div class="auth-required-banner">
        <p>Inicia sesión para guardar tus canciones favoritas</p>
        <button class="auth-header-btn auth-header-btn--primary" data-action="open-login">Ingresar</button>
    </div>`;
}

export class FavoriteSongsManager {
    constructor(app) {
        this.app = app;
        this.songs = [];
        this._activeFilter = 'all';
        this._eventsBound = false;
        this._isLoggedIn = false;
    }

    async init() {
        await this._checkSession();
        await this.load();
        this.render();
        if (!this._eventsBound) {
            this._bindGlobal();
            this._eventsBound = true;
        }
    }

    async _checkSession() {
        try {
            const { db } = await import('./supabase-client.js');
            const { data } = await db.auth.getSession();
            this._isLoggedIn = !!data?.session?.user;
        } catch {
            this._isLoggedIn = false;
        }
    }

    async load() {
        if (!this._isLoggedIn) { this.songs = []; return; }
        try {
            const { loadFavoriteSongs } = await import('./SupabaseDataManager.js');
            const { data, error } = await loadFavoriteSongs();
            if (!error) this.songs = data || [];
        } catch (e) {
            console.error('FavoriteSongsManager.load:', e);
        }
    }

    render() {
        const root = document.getElementById('favorites-root');
        if (!root) return;

        const filtered = this._filtered();
        const styles = [...new Set(this.songs.map(s => s.style).filter(Boolean))];

        root.innerHTML = `
            <div class="fav-page">
                <div class="fav-toolbar">
                    <h2><i class="fas fa-heart" style="color:#ff4d6d"></i> Canciones Favoritas</h2>
                    ${this._isLoggedIn ? `<button class="btn-primary" data-action="fav-add">
                        <i class="fas fa-plus"></i> Agregar canción
                    </button>` : ''}
                </div>

                <div class="context-help">
                    <i class="fas fa-circle-info" aria-hidden="true"></i>
                    <p>Guarda canciones y piezas que quieres aprender o que te sirven de referencia.</p>
                </div>

                ${!this._isLoggedIn ? authBannerHtml() : ''}

                ${this._isLoggedIn && styles.length > 0 ? `
                <div class="fav-filters">
                    <button class="filter-btn ${this._activeFilter === 'all' ? 'active' : ''}" data-fav-filter="all">Todos</button>
                    ${styles.map(s => {
                        const color = styleColors[s] || '#888';
                        const label = styleLabels[s] || s;
                        return `<button class="filter-btn ${this._activeFilter === s ? 'active' : ''}" data-fav-filter="${escapeHtml(s)}" style="--fc:${color}">${escapeHtml(label)}</button>`;
                    }).join('')}
                </div>` : ''}

                ${this._isLoggedIn ? `
                <div class="fav-list">
                    ${filtered.length ? filtered.map(s => songCardHtml(s)).join('') : emptyHtml()}
                </div>` : ''}
            </div>`;

        this._bindInternal(root);
    }

    _filtered() {
        if (this._activeFilter === 'all') return this.songs;
        return this.songs.filter(s => s.style === this._activeFilter);
    }

    _bindInternal(root) {
        root.querySelectorAll('[data-fav-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                this._activeFilter = btn.dataset.favFilter;
                this.render();
            });
        });
    }

    _bindGlobal() {
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'fav-add') { this.showAddModal(); return; }
            if (action === 'fav-save') { this.save(); return; }
            if (action === 'fav-delete') {
                this.deleteSong(btn.dataset.id);
            }
        });
    }

    showAddModal() {
        const modalBody = document.getElementById('modal-body');
        if (!modalBody) return;
        modalBody.innerHTML = `
            <h3><i class="fas fa-heart"></i> Agregar canción favorita</h3>
            <div class="form-group">
                <label>Nombre de la canción *</label>
                <input type="text" id="fav-name" placeholder="Ej: Autumn Leaves">
            </div>
            <div class="form-group">
                <label>Artista / Intérprete</label>
                <input type="text" id="fav-artist" placeholder="Ej: Bill Evans">
            </div>
            <div class="form-group">
                <label>URL de YouTube</label>
                <input type="url" id="fav-url" placeholder="https://youtube.com/watch?v=...">
            </div>
            <div class="form-group">
                <label>Estilo</label>
                <select id="fav-style">
                    <option value="">— Sin estilo —</option>
                    ${Object.entries(styleLabels).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Notas personales</label>
                <textarea id="fav-notes" rows="3" placeholder="Qué me gusta de esta canción…"></textarea>
            </div>
            <div class="form-actions">
                <button class="btn-primary" data-action="fav-save"><i class="fas fa-save"></i> Guardar</button>
                <button class="btn-secondary" data-action="modal-close"><i class="fas fa-times"></i> Cancelar</button>
            </div>`;
        document.getElementById('modal').classList.remove('hidden');
    }

    async save() {
        const name = document.getElementById('fav-name')?.value.trim();
        const artist = document.getElementById('fav-artist')?.value.trim();
        const youtube_url = document.getElementById('fav-url')?.value.trim();
        const style = document.getElementById('fav-style')?.value;
        const notes = document.getElementById('fav-notes')?.value.trim();

        if (!name) { this.app.showNotification('El nombre es obligatorio', 'error'); return; }

        try {
            const { insertFavoriteSong } = await import('./SupabaseDataManager.js');
            const { data, error } = await insertFavoriteSong({ name, artist, youtube_url, style, notes });
            if (error) throw error;
            this.songs.unshift(data);
            document.getElementById('modal').classList.add('hidden');
            this.render();
            this.app.showNotification(`"${escapeHtml(name)}" agregada a favoritas`, 'success');
        } catch (e) {
            console.error('FavoriteSongsManager.save:', e);
            this.app.showNotification('Error al guardar la canción', 'error');
        }
    }

    async deleteSong(id) {
        if (!await this.app.showConfirm('¿Eliminar esta canción de favoritas?')) return;
        try {
            const { deleteFavoriteSong } = await import('./SupabaseDataManager.js');
            const { error } = await deleteFavoriteSong(id);
            if (error) throw error;
            this.songs = this.songs.filter(s => String(s.id) !== String(id));
            this.render();
            this.app.showNotification('Canción eliminada', 'info');
        } catch (e) {
            console.error('FavoriteSongsManager.deleteSong:', e);
            this.app.showNotification('Error al eliminar la canción', 'error');
        }
    }
}
