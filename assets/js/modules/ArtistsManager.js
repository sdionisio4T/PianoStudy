import { artists, styleColors, styleLabels } from '../data/artists.js';
import { escapeHtml } from '../utils/sanitizers.js';

// Portada local: evita que la experiencia dependa de las miniaturas externas
// de Wikimedia, que actualmente están fallando/bloqueadas en el navegador.
const LOCAL_ARTIST_COVER = new URL('../../img/artists/piano-jazz-cover.jpg', import.meta.url).href;

// Miniaturas canónicas verificadas en Wikimedia Commons. No se usa una imagen
// cuando la búsqueda no identifica con certeza al músico: en esos casos queda
// la portada de piano local en vez de mostrar a otra persona por error.
const CURATED_ARTIST_PHOTOS = {
    'oscar-peterson': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Oscar_Peterson.jpg/330px-Oscar_Peterson.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'ray-charles': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/Ray_Charles_classic_piano_pose.jpg/250px-Ray_Charles_classic_piano_pose.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'ahmad-jamal': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e6/Ahmad_jamal.jpg/120px-Ahmad_jamal.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'otis-spann': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Otis_Spann_%26_Little_Johnnie_Jones_-_Mississippi_Blues_Trail_Marker.jpg/330px-Otis_Spann_%26_Little_Johnnie_Jones_-_Mississippi_Blues_Trail_Marker.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'mose-allison': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Mose_Allison.jpg/250px-Mose_Allison.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'bud-powell': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/Bud_Powell_%281953_publicity_photo_-_cropped%29.jpg/250px-Bud_Powell_%281953_publicity_photo_-_cropped%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'thelonious-monk': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Thelonious_Monk%2C_Minton%27s_Playhouse%2C_New_York%2C_N.Y.%2C_ca._Sept._1947_%28William_P._Gottlieb_06191%29.jpg/250px-Thelonious_Monk%2C_Minton%27s_Playhouse%2C_New_York%2C_N.Y.%2C_ca._Sept._1947_%28William_P._Gottlieb_06191%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'barry-harris': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Barry_Harris_1981.jpg/250px-Barry_Harris_1981.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'hank-jones': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/Hank_Jones.jpg/250px-Hank_Jones.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'horace-silver': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/Horace_Silver_by_Dmitri_Savitski_1989.jpg/250px-Horace_Silver_by_Dmitri_Savitski_1989.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'bobby-timmons': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Bobby_Timmons%2C_1963.jpg/250px-Bobby_Timmons%2C_1963.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'cedar-walton': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Cedar_Walton_Dachau_2001.JPG/250px-Cedar_Walton_Dachau_2001.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'wynton-kelly': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Wynton_Kelly.jpg/250px-Wynton_Kelly.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'junior-mance': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/Junior_Mance.jpg/250px-Junior_Mance.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'chucho-valdes': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Chucho_Vald%C3%A9s_%26_The_Afro-Cuban_Messengers_-_29.jpg/330px-Chucho_Vald%C3%A9s_%26_The_Afro-Cuban_Messengers_-_29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'gonzalo-rubalcaba': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Gonzalo_Rubalcaba_at_MIFF_%28cropped%29.jpg/250px-Gonzalo_Rubalcaba_at_MIFF_%28cropped%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'michel-camilo': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Michel_Camilo_in_concert.jpg/330px-Michel_Camilo_in_concert.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'hilario-duran': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/Hilario_Duran.jpg/250px-Hilario_Duran.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'alfredo-rodriguez': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/07/Alfredo_Rodriguez_Music.jpg/330px-Alfredo_Rodriguez_Music.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'bebo-valdes': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Bebo_Vald%C3%A9s_-_2008_%28cropped%29.jpg/250px-Bebo_Vald%C3%A9s_-_2008_%28cropped%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'lili-martinez': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Lil%C3%AD_Mart%C3%ADnez_Gri%C3%B1%C3%A1n.jpg/250px-Lil%C3%AD_Mart%C3%ADnez_Gri%C3%B1%C3%A1n.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'ernesto-lecuona': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/Ernesto_Lecuona.JPG/250px-Ernesto_Lecuona.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'armando-manzanero': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Bustos_de_Armando_Manzanero_%28cropped%29.jpg/250px-Bustos_de_Armando_Manzanero_%28cropped%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'agustin-lara': 'https://upload.wikimedia.org/wikipedia/commons/4/44/Agust%C3%ADn_Lara%2C_circa_1950s.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled',
    'frank-dominguez': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/Frank_A_Dominguez.jpg/250px-Frank_A_Dominguez.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    'hector-martignon': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Hector-martignon.jpg/330px-Hector-martignon.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail'
};

const STUDY_FOCUS = {
    blues: 'Escucha cómo construye frases sobre el blues y deja espacio entre respuestas.',
    bebop: 'Identifica una frase que conecte los acordes y tócala lentamente en las doce tonalidades.',
    hardbop: 'Presta atención al groove de la mano izquierda y a cómo responde la melodía.',
    latinjazz: 'Sigue la clave, localiza el patrón rítmico y llévalo a ocho compases propios.',
    soncubano: 'Escucha el montuno: marca su célula rítmica antes de intentar tocarla.',
    bolero: 'Observa el acompañamiento, la respiración de las frases y el uso del silencio.',
    jazzcolombiano: 'Busca qué elemento de la música colombiana transforma el lenguaje jazzístico.',
    bossanova: 'Mantén el pulso suave: acompaña con voicings pequeños sin sobrecargar el ritmo.'
};

function weekKey(date = new Date()) {
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dayKey(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function seededIndex(seed, length) {
    let hash = 0;
    for (const char of seed) hash = ((hash << 5) - hash) + char.charCodeAt(0) | 0;
    return Math.abs(hash) % Math.max(length, 1);
}

function normalizeStyle(style) {
    const aliases = { 'hard-bop': 'hardbop', 'latin-jazz': 'latinjazz', 'son-cubano': 'soncubano', 'jazz-colombiano': 'jazzcolombiano' };
    return aliases[style] || style || '';
}

function safeYoutubeUrl(artist) {
    if (artist.youtubeSearch) {
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(artist.youtubeSearch)}`;
    }
    try {
        const url = new URL(artist.youtubeUrl || '');
        return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

// Wikimedia dejó de aceptar varias de las rutas antiguas de miniaturas
// (`.../thumb/.../440px-...`) y responde 400. Las entradas del catálogo
// conservan esa URL por compatibilidad; para mostrarla usamos el archivo
// original, que sigue siendo una ruta pública y está permitida por la CSP.
function artistImageUrl(artist) {
    return CURATED_ARTIST_PHOTOS[artist.id] || artist.photo || LOCAL_ARTIST_COVER;
}

function songLinkHref(song, artist) {
    if (song?.youtubeUrl) {
        try {
            const url = new URL(song.youtubeUrl);
            if (['https:', 'http:'].includes(url.protocol)) return url.href;
        } catch { /* invalid URL — cae al search */ }
    }
    const query = song?.searchQuery || `${song?.title || ''} ${artist?.name || ''}`.trim();
    return query ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` : '';
}

function songsListHtml(artist, { max = 5, compact = false } = {}) {
    const songs = Array.isArray(artist?.songs) ? artist.songs.slice(0, max) : [];
    if (!songs.length) return '';
    const items = songs.map(song => {
        const href = songLinkHref(song, artist);
        const yearPart = song.year ? ` <span class="artist-song-year">(${escapeHtml(String(song.year))})</span>` : '';
        const title = escapeHtml(song.title || '');
        if (!href) return `<li class="artist-song-item">${title}${yearPart}</li>`;
        return `<li class="artist-song-item"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><i class="fab fa-youtube"></i> ${title}</a>${yearPart}</li>`;
    }).join('');
    const label = compact ? 'Escucha' : 'Canciones recomendadas';
    return `<div class="artist-songs"><span class="artist-songs-label"><i class="fas fa-music"></i> ${label}:</span><ul class="artist-songs-list">${items}</ul></div>`;
}

function styleBadge(artist) {
    const color = styleColors[artist.style] || '#888';
    const label = styleLabels[artist.style] || artist.style;
    return `<span class="artist-style-badge" style="background:${color}22;color:${color};border-color:${color}55">${escapeHtml(label)}</span>`;
}

function artistCardHtml(artist, state, isCustom = false) {
    const url = safeYoutubeUrl(artist);
    const album = artist.albums?.[0];
    const saved = state.savedArtistIds.includes(artist.id);
    const completed = state.completedArtistIds.includes(artist.id);
    const imageUrl = artistImageUrl(artist);
    const image = imageUrl
        ? `<div class="artist-image-shell"><img class="artist-card-photo" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(artist.name)}" loading="lazy" onerror="this.classList.add('artist-image-failed')"><div class="artist-card-monogram" aria-hidden="true">${escapeHtml(artist.name.charAt(0))}</div></div>`
        : `<div class="artist-card-monogram" aria-hidden="true">${escapeHtml(artist.name.charAt(0))}</div>`;

    return `
        <article class="artist-card-v2 ${isCustom ? 'artist-custom' : ''}">
            ${image}
            <div class="artist-card-body">
                <div class="artist-card-top">
                    <h4 class="artist-card-name">${escapeHtml(artist.name)}</h4>
                    ${styleBadge(artist)}
                    ${isCustom ? '<span class="artist-style-badge artist-mine-badge">Mi colección</span>' : ''}
                </div>
                <p class="artist-card-desc">${escapeHtml(artist.description || '')}</p>
                ${songsListHtml(artist, { max: 3, compact: true }) || (album ? `<p class="artist-listen-note"><i class="fas fa-compact-disc"></i> Empieza por <strong>${escapeHtml(album.title)}</strong> (${escapeHtml(String(album.year))})</p>` : '')}
                <p class="artist-study-focus"><i class="fas fa-lightbulb"></i> ${escapeHtml(STUDY_FOCUS[artist.style] || 'Elige una idea musical y llévala a tu práctica.')}</p>
                <div class="artist-card-actions">
                    ${url ? `<a class="btn-small youtube-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><i class="fab fa-youtube"></i> Escuchar</a>` : ''}
                    ${!isCustom ? `<button class="btn-small artist-action ${saved ? 'is-active' : ''}" data-action="artist-save-weekly" data-id="${escapeHtml(artist.id)}"><i class="${saved ? 'fas' : 'far'} fa-bookmark"></i> ${saved ? 'Guardado' : 'Guardar'}</button>` : ''}
                    ${!isCustom ? `<button class="btn-small artist-action ${completed ? 'is-complete' : ''}" data-action="artist-complete" data-id="${escapeHtml(artist.id)}"><i class="fas fa-check"></i> ${completed ? 'Estudiado' : 'Marcar estudiado'}</button>` : ''}
                    ${isCustom ? `<button class="btn-small btn-danger" data-action="custom-artist-delete" data-id="${escapeHtml(String(artist.id || ''))}"><i class="fas fa-trash"></i> Eliminar</button>` : ''}
                </div>
            </div>
        </article>`;
}

export class ArtistsManager {
    constructor(app) {
        this.app = app;
        this.customArtists = [];
        this.preferredStyle = '';
        this._searchTimer = null;
        this._activeFilter = 'all';
        this._searchTerm = '';
        this._page = 1;
        this._pageSize = 12;
        this._catalogPage = [];
        this._catalogCount = artists.length;
        this._catalogIsRemote = false;
        this._eventsBound = false;
    }

    async init() {
        await Promise.all([this.loadCustomArtists(), this.loadPreferredStyle()]);
        this.renderDashboardCard();
        await this.render();
        if (!this._eventsBound) {
            this.bindEvents();
            this._eventsBound = true;
        }
    }

    async loadPreferredStyle() {
        try {
            const { getMyProfile } = await import('./SupabaseDataManager.js');
            const profile = await getMyProfile();
            this.preferredStyle = normalizeStyle(profile?.default_style);
        } catch {
            this.preferredStyle = '';
        }
    }

    _stateKey() {
        return this.app.userKey ? this.app.userKey('pianostudy-artist-study') : 'pianostudy-artist-study';
    }

    _getStudyState() {
        try {
            const parsed = JSON.parse(localStorage.getItem(this._stateKey()) || '{}');
            return {
                savedArtistIds: Array.isArray(parsed.savedArtistIds) ? parsed.savedArtistIds : [],
                completedArtistIds: Array.isArray(parsed.completedArtistIds) ? parsed.completedArtistIds : []
            };
        } catch {
            return { savedArtistIds: [], completedArtistIds: [] };
        }
    }

    _saveStudyState(state) {
        try { localStorage.setItem(this._stateKey(), JSON.stringify(state)); } catch { /* storage unavailable */ }
    }

    getDailyArtist() {
        const state = this._getStudyState();
        const completedIds = new Set(state.completedArtistIds || []);
        const available = artists.filter(a => !completedIds.has(a.id));
        const pool = available.length ? available : artists;
        return pool[seededIndex(dayKey(), pool.length)];
    }

    _dailyCardHtml(compact = false) {
        const artist = this.getDailyArtist();
        if (!artist) return '';
        const state = this._getStudyState();
        const completed = state.completedArtistIds.includes(artist.id);
        const saved = state.savedArtistIds.includes(artist.id);
        const url = safeYoutubeUrl(artist);
        const album = artist.albums?.[0];
        const imageUrl = artistImageUrl(artist);
        const image = imageUrl
            ? `<div class="artist-featured-shell"><img class="artist-featured-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(artist.name)}" onerror="this.classList.add('artist-image-failed')"><div class="artist-featured-monogram" aria-hidden="true">${escapeHtml(artist.name.charAt(0))}</div></div>`
            : `<div class="artist-featured-monogram">${escapeHtml(artist.name.charAt(0))}</div>`;

        const songsBlock = songsListHtml(artist, { max: compact ? 3 : 5, compact });
        const albumFallback = !songsBlock && album
            ? `<p class="artist-weekly-listen"><i class="fas fa-headphones"></i> Escucha inicial: <strong>${escapeHtml(album.title)}</strong> (${escapeHtml(String(album.year))})</p>`
            : '';

        return `
            <section class="artist-weekly-card ${compact ? 'artist-weekly-card--compact' : ''}">
                ${image}
                <div class="artist-weekly-content">
                    <span class="artist-weekly-eyebrow"><i class="fas fa-calendar-day"></i> Artista del día</span>
                    <div class="artist-weekly-title-row"><h3>${escapeHtml(artist.name)}</h3>${styleBadge(artist)}</div>
                    ${!compact ? `<p class="artist-weekly-description">${escapeHtml(artist.description || '')}</p>` : ''}
                    <div class="artist-mission"><i class="fas fa-bullseye"></i><span><strong>Misión de estudio:</strong> ${escapeHtml(STUDY_FOCUS[artist.style] || 'Escucha atentamente y aplica una idea en tu práctica.')}</span></div>
                    ${songsBlock}
                    ${albumFallback}
                    <div class="artist-weekly-actions">
                        ${url ? `<a class="btn-small youtube-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><i class="fab fa-youtube"></i> Explorar más</a>` : ''}
                        <button class="btn-small artist-action ${saved ? 'is-active' : ''}" data-action="artist-save-weekly" data-id="${escapeHtml(artist.id)}"><i class="${saved ? 'fas' : 'far'} fa-bookmark"></i> ${saved ? 'Guardado' : 'Guardar'}</button>
                        <button class="btn-small artist-action ${completed ? 'is-complete' : ''}" data-action="artist-complete" data-id="${escapeHtml(artist.id)}"><i class="fas fa-check"></i> ${completed ? 'Misión completada' : 'Completar misión'}</button>
                    </div>
                </div>
            </section>`;
    }

    renderDashboardCard() {
        const el = document.getElementById('artist-recommendation');
        if (!el) return;
        const artist = this.getDailyArtist();
        if (!artist) {
            el.innerHTML = '<span style="color:var(--text-secondary);font-size:0.85rem">Sin artistas disponibles</span>';
            return;
        }
        const imageUrl = artistImageUrl(artist);
        const firstSong = Array.isArray(artist.songs) && artist.songs[0] ? artist.songs[0] : null;
        const firstAlbum = artist.albums?.[0];
        const listenText = firstSong?.title || firstAlbum?.title || '';
        const styleLabel = styleLabels[artist.style] || artist.style || '';
        const listenHref = firstSong
            ? songLinkHref(firstSong, artist)
            : safeYoutubeUrl(artist);
        el.innerHTML = `
            <div class="dashboard-artist">
                <div class="dashboard-artist-avatar">
                    <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(artist.name)}" onerror="this.classList.add('artist-image-failed')">
                    <div class="dashboard-artist-monogram" aria-hidden="true">${escapeHtml(artist.name.charAt(0))}</div>
                </div>
                <p class="dashboard-artist-name">${escapeHtml(artist.name)}</p>
                ${styleLabel ? `<p class="dashboard-artist-style">${escapeHtml(styleLabel)}</p>` : ''}
                ${listenText ? `<p class="dashboard-artist-listen">Empieza por «${escapeHtml(listenText)}»</p>` : ''}
                ${listenHref ? `<a class="dashboard-artist-youtube" href="${escapeHtml(listenHref)}" target="_blank" rel="noopener noreferrer"><i class="fab fa-youtube"></i> Escuchar en YouTube</a>` : ''}
            </div>
        `;
    }

    async loadCustomArtists() {
        try {
            const { loadCustomArtistsFromDB } = await import('./SupabaseDataManager.js');
            const { data, error } = await loadCustomArtistsFromDB();
            if (!error && data) this.customArtists = data.map(r => ({ id: r.id, name: r.name, style: normalizeStyle(r.style) || 'blues', description: r.description || '', youtubeUrl: r.youtube_url || '', youtubeSearch: r.youtube_url ? null : r.name, albums: [], isCustom: true }));
        } catch (e) { console.error('ArtistsManager.loadCustomArtists:', e); }
    }

    async loadCatalogPage() {
        try {
            const { loadArtistCatalogPage } = await import('./SupabaseDataManager.js');
            const { data, count, error } = await loadArtistCatalogPage({
                page: this._page,
                pageSize: this._pageSize,
                style: this._activeFilter,
                search: this._searchTerm
            });
            // Un catálogo vacío normalmente significa que la migración fue
            // aplicada pero aún no se importaron artistas: conservamos el
            // catálogo local hasta que exista contenido editorial remoto.
            if (!error && data.length) {
                this._catalogIsRemote = true;
                this._catalogCount = count;
                this._catalogPage = data.map(row => ({
                    id: row.id,
                    name: row.name,
                    style: normalizeStyle(row.primary_style),
                    description: row.description || '',
                    photo: row.photo_url || '',
                    youtubeUrl: row.artist_study_guides?.[0]?.listening_url || '',
                    youtubeSearch: row.artist_study_guides?.[0]?.listening_url ? null : `${row.name} piano`,
                    albums: (row.artist_releases || []).sort((a, b) => a.sort_order - b.sort_order).map(release => ({ title: release.title, year: release.release_year || '' }))
                }));
                return;
            }
        } catch { /* La migración puede no estar desplegada aún. */ }

        this._catalogIsRemote = false;
        const filtered = this._filterArtists(artists);
        this._catalogCount = filtered.length;
        const start = (this._page - 1) * this._pageSize;
        this._catalogPage = filtered.slice(start, start + this._pageSize);
        if (!this._catalogPage.length && this._page > 1) {
            this._page--;
            await this.loadCatalogPage();
        }
    }

    async render() {
        const section = document.getElementById('artists');
        if (!section) return;
        await this.loadCatalogPage();
        const pageArtists = this._catalogPage;
        const customMatches = this._filterArtists(this.customArtists);
        const state = this._getStudyState();
        const totalPages = Math.max(1, Math.ceil(this._catalogCount / this._pageSize));
        const from = this._catalogCount ? (this._page - 1) * this._pageSize + 1 : 0;
        const to = Math.min(this._page * this._pageSize, this._catalogCount);

        section.innerHTML = `
            <div class="artists-page">
                <div class="artists-full">
                    <div class="artists-toolbar"><h2><i class="fas fa-users"></i> Artistas</h2><button class="btn-primary" data-action="artist-add"><i class="fas fa-plus"></i> Agregar artista</button></div>
                    ${this._dailyCardHtml()}
                    <div class="context-help"><i class="fas fa-circle-info" aria-hidden="true"></i><p>Descubre una referencia, escucha con intención y transforma una idea en tu práctica.</p></div>
                    <div class="artists-search-row"><input type="text" id="artist-search" placeholder="Buscar por nombre, estilo o descripción…" value="${escapeHtml(this._searchTerm)}" autocomplete="off"></div>
                    <div class="artists-filters"><button class="filter-btn ${this._activeFilter === 'all' ? 'active' : ''}" data-filter="all">Todos</button>${Object.entries(styleLabels).map(([key, label]) => `<button class="filter-btn ${this._activeFilter === key ? 'active' : ''}" data-filter="${key}" style="--fc:${styleColors[key]}">${escapeHtml(label)}</button>`).join('')}</div>
                    ${customMatches.length ? `<section class="my-artists-section"><h3><i class="fas fa-bookmark"></i> Mi colección</h3><div class="artists-list">${customMatches.map(artist => artistCardHtml(artist, state, true)).join('')}</div></section>` : ''}
                    <p class="artist-count-bottom" id="artist-count-bottom">Mostrando ${from}–${to} de ${this._catalogCount} artistas${this._catalogIsRemote ? '' : ' · catálogo local'}</p>
                    <div id="artists-list" class="artists-list">${pageArtists.length ? pageArtists.map(artist => artistCardHtml(artist, state)).join('') : `<p class="no-results">No se encontraron artistas para "<strong>${escapeHtml(this._searchTerm)}</strong>"</p>`}</div>
                    ${this._paginationHtml(totalPages)}
                </div>
            </div>`;
        this._bindInternalEvents(section);
    }

    _filterArtists(list) {
        let result = this._activeFilter === 'all' ? list : list.filter(a => a.style === this._activeFilter);
        if (this._searchTerm.trim()) {
            const q = this._searchTerm.toLowerCase();
            result = result.filter(a => a.name.toLowerCase().includes(q) || (a.style || '').toLowerCase().includes(q) || (styleLabels[a.style] || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q));
        }
        return result;
    }

    _paginationHtml(totalPages) {
        if (totalPages <= 1) return '';
        const pages = Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(page => page === 1 || page === totalPages || Math.abs(page - this._page) <= 1);
        const items = [];
        let previous = 0;
        pages.forEach(page => {
            if (page - previous > 1) items.push('<span class="artist-pagination-ellipsis">…</span>');
            items.push(`<button class="artist-page-btn ${page === this._page ? 'active' : ''}" data-action="artist-page" data-page="${page}" ${page === this._page ? 'aria-current="page"' : ''}>${page}</button>`);
            previous = page;
        });
        return `<nav class="artist-pagination" aria-label="Paginación de artistas"><button class="artist-page-btn artist-page-nav" data-action="artist-page" data-page="${this._page - 1}" ${this._page === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i> Anterior</button><div class="artist-page-numbers">${items.join('')}</div><button class="artist-page-btn artist-page-nav" data-action="artist-page" data-page="${this._page + 1}" ${this._page === totalPages ? 'disabled' : ''}>Siguiente <i class="fas fa-chevron-right"></i></button></nav>`;
    }

    _bindInternalEvents(section) {
        const searchInput = section.querySelector('#artist-search');
        if (searchInput) searchInput.addEventListener('input', e => { clearTimeout(this._searchTimer); this._searchTimer = setTimeout(() => { this._searchTerm = e.target.value; this._page = 1; this.render(); }, 300); });
        section.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => { this._activeFilter = btn.dataset.filter; this._page = 1; this.render(); }));
    }

    bindEvents() {
        document.addEventListener('click', e => {
            const target = e.target.closest('[data-action]');
            const action = target?.dataset.action;
            if (!action) return;
            if (action === 'artist-add') { this.showAddModal(); return; }
            if (action === 'artist-save') { this.saveCustomArtist(); return; }
            if (action === 'custom-artist-delete') { this.deleteCustomArtist(target.dataset.id); return; }
            if (action === 'artist-page') { this._page = Math.max(1, Number(target.dataset.page) || 1); this.render(); return; }
            if (action === 'artist-save-weekly') { this.toggleSaved(target.dataset.id); return; }
            if (action === 'artist-complete') this.toggleCompleted(target.dataset.id);
        });
    }

    _toggleArtistState(id, field) {
        const state = this._getStudyState();
        state[field] = state[field].includes(id) ? state[field].filter(item => item !== id) : [...state[field], id];
        this._saveStudyState(state);
        this.renderDashboardCard();
        this.render();
        return state[field].includes(id);
    }

    toggleSaved(id) {
        const saved = this._toggleArtistState(id, 'savedArtistIds');
        this.app.showNotification(saved ? 'Artista guardado para estudiar después' : 'Artista quitado de guardados', saved ? 'success' : 'info');
    }

    toggleCompleted(id) {
        const completed = this._toggleArtistState(id, 'completedArtistIds');
        this.app.showNotification(completed ? '¡Misión de artista completada!' : 'Misión marcada como pendiente', completed ? 'success' : 'info');
    }

    showAddModal() {
        const modalBody = document.getElementById('modal-body');
        if (!modalBody) return;
        modalBody.innerHTML = `<h3><i class="fas fa-user-plus"></i> Agregar artista</h3><div class="form-group"><label>Nombre *</label><input type="text" id="ca-name" placeholder="Nombre del artista"></div><div class="form-group"><label>Estilo *</label><select id="ca-style">${Object.entries(styleLabels).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div><div class="form-group"><label>Descripción</label><textarea id="ca-desc" rows="3" placeholder="Breve descripción…"></textarea></div><div class="form-group"><label>Link YouTube (opcional)</label><input type="url" id="ca-yt" placeholder="https://youtube.com/…"></div><div class="form-actions"><button class="btn-primary" data-action="artist-save"><i class="fas fa-save"></i> Guardar</button><button class="btn-secondary" data-action="modal-close"><i class="fas fa-times"></i> Cancelar</button></div>`;
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
            this.customArtists.push({ id: data.id, name, style: normalizeStyle(style) || 'blues', description, youtubeUrl, youtubeSearch: youtubeUrl ? null : name, albums: [], isCustom: true });
            document.getElementById('modal').classList.add('hidden');
            this.render();
            this.app.showNotification(`"${name}" agregado a tu colección`, 'success');
        } catch (e) { console.error('saveCustomArtist:', e); this.app.showNotification('Error al guardar artista', 'error'); }
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
        } catch (e) { console.error('deleteCustomArtist:', e); this.app.showNotification('Error al eliminar artista', 'error'); }
    }

    getDailyArtistName() { return this.getDailyArtist()?.name || ''; }
}
