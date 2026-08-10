// Setup global para Vitest. assets/js/modules/supabase-client.js espera un
// `supabase` global (inyectado en el browser real por el script CDN de
// @supabase/supabase-js). Bajo Node/Vitest ese global no existe, así que se
// stubea acá para poder importar módulos que dependen de supabase-client.js
// (como AuthManager.js) sin que el import top-level explote.
globalThis.supabase = {
    createClient: () => ({
        auth: {},
        from: () => ({}),
    }),
};
