-- Migración 0003: bucket de storage "recordings" y sus políticas
-- Fuente: README.md, sección "Storage bucket".
-- El bucket en sí (nombre "recordings", acceso público habilitado a nivel bucket)
-- se crea desde el dashboard de Supabase Storage, no vía SQL — este archivo
-- documenta solo las policies de storage.objects que van en el SQL Editor.

-- Usuarios autenticados pueden subir a cualquier ruta dentro del bucket.
-- NOTA: no restringe a que cada usuario solo escriba en su propia carpeta
-- (ver DIAGNOSTICO_Y_PLAN.md sección 2.4 — pendiente de decisión de producto).
create policy "usuarios suben sus archivos"
on storage.objects for insert
to authenticated
with check (bucket_id = 'recordings');

-- Lectura pública para reproducción de audio.
-- NOTA: cualquiera con la URL puede descargar el archivo (bucket_id = 'recordings'
-- sin filtrar por carpeta/usuario). Es una decisión de producto explícita
-- pendiente de confirmar (ver DIAGNOSTICO_Y_PLAN.md 2.4) — no se cambia acá.
create policy "lectura publica recordings"
on storage.objects for select
to public
using (bucket_id = 'recordings');
