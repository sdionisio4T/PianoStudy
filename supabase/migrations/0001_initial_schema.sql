-- Migración 0001: schema inicial de PianoStudy
-- Fuente: README.md (raíz del proyecto), sección "Supabase — Base de datos y almacenamiento".
-- Reconstruida y versionada el 2026-08-09 como parte de la Fase 1 (backup/DR).
-- Ver supabase/migrations/README.md antes de aplicar — reconciliar con `supabase db pull`.

-- ── Tablas ───────────────────────────────────────────────────────────────────

create table if not exists licks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  style text default '',
  notes text default '',
  file_path text,
  order_index integer default 0,
  created_at timestamptz default now()
);

create table if not exists recordings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  duration integer default 0,
  file_path text not null,
  created_at timestamptz default now()
);

create table if not exists custom_artists (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  style text default '',
  description text default '',
  tags text[] default '{}',
  created_at timestamptz default now()
);

-- Perfiles públicos: recuperación de contraseña por pregunta de seguridad + login por username
create table if not exists user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  username text unique,
  security_question text,
  created_at timestamptz default now()
);

create table if not exists practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  duration_seconds integer not null default 0,
  date date not null,
  created_at timestamptz default now()
);

-- ── Row Level Security ───────────────────────────────────────────────────────

alter table licks enable row level security;
alter table recordings enable row level security;
alter table custom_artists enable row level security;
alter table user_profiles enable row level security;
alter table practice_sessions enable row level security;

create policy "usuarios ven sus licks" on licks
  for all using (auth.uid()::text = user_id);

create policy "usuarios ven sus grabaciones" on recordings
  for all using (auth.uid()::text = user_id);

create policy "usuarios ven sus artistas" on custom_artists
  for all using (auth.uid()::text = user_id);

create policy "usuarios gestionan su perfil" on user_profiles
  for all using (auth.uid() = id);

create policy "usuarios ven sus sesiones" on practice_sessions
  for all using (auth.uid() = user_id);

-- ── RPC segura: resolver username → email sin exponer user_profiles ──────────

create or replace function get_email_by_username(p_username text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select email
  from user_profiles
  where lower(username) = lower(p_username)
  limit 1;
$$;

revoke all on function get_email_by_username(text) from public;
grant execute on function get_email_by_username(text) to anon, authenticated;

-- ── Backfill para usuarios existentes (idempotente — solo inserta lo que falta) ──

insert into user_profiles (id, email, username, security_question)
select
  au.id,
  au.email,
  au.raw_user_meta_data->>'username',
  au.raw_user_meta_data->>'securityQuestion'
from auth.users au
where not exists (
  select 1 from user_profiles up where up.id = au.id
)
on conflict (id) do update
  set
    username = excluded.username,
    security_question = excluded.security_question;
