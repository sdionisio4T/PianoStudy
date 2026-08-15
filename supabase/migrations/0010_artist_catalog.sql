-- Catálogo editorial de artistas para PianoStudy.
-- Esta migración no reemplaza custom_artists: esa tabla sigue siendo la
-- colección privada de cada usuario. artists es el catálogo público curado.

create table if not exists public.artists (
  id text primary key,
  name text not null,
  primary_style text not null,
  substyles text[] not null default '{}',
  country text default '',
  era text default '',
  level text not null default 'intermedio'
    check (level in ('inicial', 'intermedio', 'avanzado')),
  description text not null default '',
  instrument text not null default 'piano',
  photo_url text default '',
  photo_source_url text default '',
  photo_license text default '',
  source text not null default 'editorial',
  source_url text default '',
  source_updated_at timestamptz,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists artists_published_style_name_idx
  on public.artists (is_published, primary_style, name);

create table if not exists public.artist_releases (
  id uuid primary key default gen_random_uuid(),
  artist_id text not null references public.artists(id) on delete cascade,
  title text not null,
  release_year integer,
  listening_url text default '',
  is_entry_point boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists artist_releases_artist_sort_idx
  on public.artist_releases (artist_id, sort_order, release_year);

create table if not exists public.artist_study_guides (
  artist_id text primary key references public.artists(id) on delete cascade,
  study_focus text not null default '',
  weekly_mission text not null default '',
  listening_title text default '',
  listening_url text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.artist_relations (
  artist_id text not null references public.artists(id) on delete cascade,
  related_artist_id text not null references public.artists(id) on delete cascade,
  relation_type text not null default 'similar',
  sort_order integer not null default 0,
  primary key (artist_id, related_artist_id),
  check (artist_id <> related_artist_id)
);

create table if not exists public.user_artist_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  artist_id text not null references public.artists(id) on delete cascade,
  saved_at timestamptz,
  completed_at timestamptz,
  last_viewed_at timestamptz,
  notes text not null default '',
  primary key (user_id, artist_id)
);

alter table public.artists enable row level security;
alter table public.artist_releases enable row level security;
alter table public.artist_study_guides enable row level security;
alter table public.artist_relations enable row level security;
alter table public.user_artist_progress enable row level security;

-- Catálogo público, solo editable desde dashboard/service role.
create policy "catalogo de artistas visible" on public.artists
  for select using (is_published = true);
create policy "lanzamientos de artistas visibles" on public.artist_releases
  for select using (exists (
    select 1 from public.artists a where a.id = artist_releases.artist_id and a.is_published = true
  ));
create policy "guias de artistas visibles" on public.artist_study_guides
  for select using (exists (
    select 1 from public.artists a where a.id = artist_study_guides.artist_id and a.is_published = true
  ));
create policy "relaciones de artistas visibles" on public.artist_relations
  for select using (exists (
    select 1 from public.artists a where a.id = artist_relations.artist_id and a.is_published = true
  ));

create policy "usuarios gestionan su progreso de artistas" on public.user_artist_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
