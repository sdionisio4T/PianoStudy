-- Migración 0009: actualizar el trigger handle_new_user para que no referencie
-- security_question (columna eliminada en 0008_drop_security_question.sql).
--
-- El trigger vive en el proyecto Supabase y se dispara cada vez que se crea
-- un auth.users. Como todavía referenciaba `security_question`, después de
-- correr 0008 cualquier signup nuevo fallaba con "Database error saving new
-- user" (HTTP 500 en /auth/v1/signup). Esta migración lo reescribe sin esa
-- columna. Nota: la definición original del trigger no vivía en el repo (se
-- había creado desde el dashboard), por eso no lo vimos hasta que rompió.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.user_profiles (id, email, username)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'username'
  )
  on conflict (id) do update
    set email = excluded.email,
        username = coalesce(excluded.username, user_profiles.username);
  return new;
end;
$function$;
