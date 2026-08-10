const { createClient } = supabase;

// La URL y la anon key de Supabase NO son secretas (están diseñadas para
// viajar al cliente; el acceso real lo controla RLS en el servidor), así que
// es seguro tenerlas en .env.development/.env.production versionados en git.
// Fallback a los valores previos si Vite no inyectó las env vars (por
// ejemplo, si alguien todavía abre index.html directo sin pasar por el build).
const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://mtejpgwjdhzuqrqfdlud.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10ZWpwZ3dqZGh6dXFycWZkbHVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjA4OTAsImV4cCI6MjA4NjkzNjg5MH0.4s_Mo_PFxu7CF81nyDKs72DjvpUEt3huTobOvGymlko';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
