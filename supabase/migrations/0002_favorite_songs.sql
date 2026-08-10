-- Migración 0002: tabla favorite_songs
-- ⚠️ INFERIDA, NO VERIFICADA CONTRA EL SCHEMA REAL.
-- Esta tabla la usa el cliente (assets/js/modules/SupabaseDataManager.js:
-- loadFavoriteSongs, insertFavoriteSong, deleteFavoriteSong) pero NO estaba
-- documentada en README.md junto al resto del schema. Las columnas de abajo
-- son las que el código lee/escribe; RLS y tipos siguen el mismo patrón que
-- custom_artists (tabla más análoga: lista personal simple del usuario).
-- Antes de aplicar esta migración, correr `supabase db pull` y comparar contra
-- la tabla real — si difieren, reemplazar este archivo por el resultado real.

create table if not exists favorite_songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  artist text default '',
  youtube_url text default '',
  style text default '',
  notes text default '',
  created_at timestamptz default now()
);

alter table favorite_songs enable row level security;

create policy "usuarios ven sus canciones favoritas" on favorite_songs
  for all using (auth.uid() = user_id);
