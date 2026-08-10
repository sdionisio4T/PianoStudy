import { artists, styleColors, styleLabels } from '../data/artists.js';
import { escapeHtml } from '../utils/sanitizers.js';

function getDailyArtist() {
    const seed = new Date().toDateString();
    const index = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
    return artists[index % artists.length];
}

function ytUrl(artist) {
    if (artist.youtubeSearch) {
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(artist.youtubeSearch)}`;
    }
    return artist.youtubeUrl || '';
}

function styleBadge(artist) {
    const color = styleColors[artist.style] || '#888';
    const label = styleLabels[artist.style] || artist.style;
    return `<span class="artist-style-badge" style="background:${color}22;color:${color};border:1px solid ${color}55">${escapeHtml(label)}</span>`;
}

function artistCardHtml(artist, isCustom = false) {
    const url = ytUrl(artist);
    return `
        <div class="artist-card-v2 ${isCustom ? 'artist-custom' : ''}">
            <div class="artist-card-body">
                <div class="artist-card-top">
                    <h4 class="artist-card-name">${escapeHtml(artist.name)}</h4>
                    ${styleBadge(artist)}
                    ${isCustom ? `<span class="artist-style-badge artist-mine-badge">Mi colección</span>` : ''}
                </div>
                <p class="artist-card-desc">${escapeHtml(artist.description || '')}</p>
                <div class="artist-card-actions">
                    ${url ? `<a class="btn-small youtube-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
                        <i class="fab fa-youtube"></i> Ver en YouTube
                    </a>` : ''}
                    ${isCustom ? `<button class="btn-small btn-danger" data-action="custom-artist-delete" data-id="${escapeHtml(String(artist.id || ''))}">
                        <i class="fas fa-trash"></i> Eliminar
                    </button>` : ''}
                </div>
            </div>
        </div>`;
}

export class ArtistsManager {
    constructor(app) {
        this.app = app;
        this.customArtists = [];
        this._searchTimer = null;
        this._activeFilter = 'all';
        this._searchTerm = '';
        this._eventsBound = false;
    }

    async init() {
        await this.loadCustomArtists();
        this.renderDashboardCard();
        this.render();
        if (!this._eventsBound) {
            this.bindEvents();
            this._eventsBound = true;
        }
    }

    renderDashboardCard() {
        const el = document.getElementById('artist-recommendation');
        if (!el) return;
        const artist = getDailyArtist();
        if (!artist) return;
        const color = styleColors[artist.style] || '#888';
        const label = styleLabels[artist.style] || artist.style;
        const url = ytUrl(artist);
        el.innerHTML = `
            <strong style="font-size:1rem">${escapeHtml(artist.name)}</strong>
            <span class="artist-style-badge" style="background:${color}22;color:${color};border:1px solid ${color}55;margin:0.3rem 0;display:inline-block">${escapeHtml(label)}</span>
            <span style="display:block;font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.5rem">${escapeHtml((artist.description || '').slice(0, 90))}…</span>
            ${url ? `<a class="btn-small youtube-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="margin-top:0.25rem">
                <i class="fab fa-youtube"></i> Ver en YouTube
            </a>` : ''}`;
    }

    async loadCustomArtists() {
        try {
            const { loadCustomArtistsFromDB } = await import('./SupabaseDataManager.js');
            const { data, error } = await loadCustomArtistsFromDB();
            if (!error && data) {
                this.customArtists = data.map(r => ({
                    id: r.id,
                    name: r.name,
                    style: r.style || 'blues',
                    description: r.description || '',
                    youtubeUrl: r.youtube_url || '',
                    youtubeSearch: r.youtube_url ? null : r.name,
                    albums: [],
                    isCustom: true
                }));
            }
        } catch (e) {
            console.error('ArtistsManager.loadCustomArtists:', e);
        }
    }

    render() {
        const section = document.getElementById('artists');
        if (!section) return;

        const allArtists = [...artists, ...this.customArtists];
        const filtered = this._filterArtists(allArtists);

        section.innerHTML = `
            <div class="artists-page">
                <div class="artists-full">
                    <div class="artists-toolbar">
                        <h2><i class="fas fa-users"></i> Artistas</h2>
                        <button class="btn-primary" data-action="artist-add">
                            <i class="fas fa-plus"></i> Agregar artista
                        </button>
                    </div>

                    <div class="context-help">
                        <i class="fas fa-circle-info" aria-hidden="true"></i>
                        <p>Explora artistas recomendados por estilo. Agrégalos a tus favoritos y mira sus videos en YouTube.</p>
                    </div>

                    <div class="artists-search-row">
                        <input type="text" id="artist-search" placeholder="Buscar por nombre, estilo o descripción…" value="${escapeHtml(this._searchTerm)}" autocomplete="off">
                    </div>

                    <div class="artists-filters">
                        <button class="filter-btn ${this._activeFilter === 'all' ? 'active' : ''}" data-filter="all">Todos</button>
                        ${Object.entries(styleLabels).map(([key, label]) =>
                            `<button class="filter-btn ${this._activeFilter === key ? 'active' : ''}" data-filter="${key}" style="--fc:${styleColors[key]}">${escapeHtml(label)}</button>`
                        ).join('')}
                    </div>

                    <p class="artist-count-bottom" id="artist-count-bottom">Mostrando ${filtered.length} de ${allArtists.length} artistas</p>

                    <div id="artists-list" class="artists-list">
                        ${filtered.length
                            ? filtered.map(a => artistCardHtml(a, !!a.isCustom)).join('')
                            : `<p class="no-results">No se encontraron artistas para "<strong>${escapeHtml(this._searchTerm)}</strong>"</p>`
                        }
                    </div>
                </div>
            </div>`;

        this._bindInternalEvents(section);
    }

    _filterArtists(list) {
        let result = list;
        if (this._activeFilter !== 'all') {
            result = result.filter(a => a.style === this._activeFilter);
        }
        if (this._searchTerm.trim()) {
            const q = this._searchTerm.toLowerCase();
            result = result.filter(a =>
                a.name.toLowerCase().includes(q) ||
                (a.style || '').toLowerCase().includes(q) ||
                (styleLabels[a.style] || '').toLowerCase().includes(q) ||
                (a.description || '').toLowerCase().includes(q)
            );
        }
        return result;
    }

    _bindInternalEvents(section) {
        const searchInput = section.querySelector('#artist-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(this._searchTimer);
                this._searchTimer = setTimeout(() => {
                    this._searchTerm = e.target.value;
                    this._rerenderList();
                }, 300);
            });
        }

        section.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._activeFilter = btn.dataset.filter;
                this._rerenderList();
            });
        });
    }

    _rerenderList() {
        const section = document.getElementById('artists');
        if (!section) return;

        const allArtists = [...artists, ...this.customArtists];
        const filtered = this._filterArtists(allArtists);

        const listEl = section.querySelector('#artists-list');
        const countEl = section.querySelector('#artist-count-bottom');
        const filterBtns = section.querySelectorAll('.filter-btn');

        if (listEl) {
            listEl.innerHTML = filtered.length
                ? filtered.map(a => artistCardHtml(a, !!a.isCustom)).join('')
                : `<p class="no-results">No se encontraron artistas para "<strong>${escapeHtml(this._searchTerm)}</strong>"</p>`;
        }
        if (countEl) countEl.textContent = `Mostrando ${filtered.length} de ${allArtists.length} artistas`;
        filterBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === this._activeFilter);
        });
    }

    bindEvents() {
        document.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (!action) return;
            if (action === 'artist-add') { this.showAddModal(); return; }
            if (action === 'artist-save') { this.saveCustomArtist(); return; }
            if (action === 'custom-artist-delete') {
                const id = e.target.closest('[data-action]').dataset.id;
                this.deleteCustomArtist(id);
            }
        });
    }

    showAddModal() {
        const modalBody = document.getElementById('modal-body');
        if (!modalBody) return;
        modalBody.innerHTML = `
            <h3><i class="fas fa-user-plus"></i> Agregar artista</h3>
            <div class="form-group">
                <label>Nombre *</label>
                <input type="text" id="ca-name" placeholder="Nombre del artista">
            </div>
            <div class="form-group">
                <label>Estilo *</label>
                <select id="ca-style">
                    ${Object.entries(styleLabels).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Descripción</label>
                <textarea id="ca-desc" rows="3" placeholder="Breve descripción…"></textarea>
            </div>
            <div class="form-group">
                <label>Link YouTube (opcional)</label>
                <input type="url" id="ca-yt" placeholder="https://youtube.com/…">
            </div>
            <div class="form-actions">
                <button class="btn-primary" data-action="artist-save"><i class="fas fa-save"></i> Guardar</button>
                <button class="btn-secondary" data-action="modal-close"><i class="fas fa-times"></i> Cancelar</button>
            </div>`;
        document.getElementById('modal').classList.remove('hidden');
    }

    async saveCustomArtist() {
        const name = document.getElementById('ca-name')?.value.trim();
        const style = document.getElementById('ca-style')?.value;
        const description = document.getElementById('ca-desc')?.value.trim();
        const youtubeUrl = document.getElementById('ca-yt')?.value.trim();

        if (!name) { this.app.showNotification('El nombre es obligatorio', 'error'); return; }

        try {
            const { insertCustomArtist } = await import('./SupabaseDataManager.js');
            const { data, error } = await insertCustomArtist({ name, style, description, youtube_url: youtubeUrl });
            if (error) throw error;

            this.customArtists.push({
                id: data.id,
                name, style, description,
                youtubeUrl,
                youtubeSearch: youtubeUrl ? null : name,
                albums: [],
                isCustom: true
            });

            document.getElementById('modal').classList.add('hidden');
            this.render();
            this.app.showNotification(`"${escapeHtml(name)}" agregado a tu colección`, 'success');
        } catch (e) {
            console.error('saveCustomArtist:', e);
            this.app.showNotification('Error al guardar artista', 'error');
        }
    }

    async deleteCustomArtist(id) {
        if (!await this.app.showConfirm('¿Eliminar este artista de tu colección?')) return;
        try {
            const { deleteCustomArtist } = await import('./SupabaseDataManager.js');
            const { error } = await deleteCustomArtist(id);
            if (error) throw error;
            this.customArtists = this.customArtists.filter(a => String(a.id) !== String(id));
            this.render();
            this.app.showNotification('Artista eliminado', 'info');
        } catch (e) {
            console.error('deleteCustomArtist:', e);
            this.app.showNotification('Error al eliminar artista', 'error');
        }
    }

    getDailyArtistName() {
        return getDailyArtist()?.name || '';
    }
}
