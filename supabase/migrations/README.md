# Migraciones — cómo se armó esto y qué falta verificar

Estos archivos son una **reconstrucción** del schema de Supabase a partir de:

1. El bloque SQL documentado en `README.md` (raíz del proyecto) — tablas `licks`,
   `recordings`, `custom_artists`, `user_profiles`, `practice_sessions`, sus RLS
   y la función RPC `get_email_by_username`.
2. El uso real de tablas en `assets/js/modules/SupabaseDataManager.js`, de donde
   se detectó la tabla `favorite_songs` — **usada por la app pero no documentada
   en `README.md`**, así que su definición en `0002_favorite_songs.sql` es una
   inferencia razonable a partir de las columnas que el cliente lee/escribe
   (`id`, `user_id`, `name`, `artist`, `youtube_url`, `style`, `notes`,
   `created_at`), no una copia del schema real.

**Esto NO reemplaza al schema real de tu proyecto Supabase.** Es un punto de
partida versionado para que Fase 1 (backup/DR) tenga algo reproducible en git,
y para que detectes divergencias.

## Qué hacer cuando vuelvas

1. Correr `supabase db pull` (con el proyecto vinculado) para traer el schema
   real actual a `supabase/migrations/` y compararlo con estos archivos.
2. Si `favorite_songs` en producción tiene columnas distintas a las de
   `0002_favorite_songs.sql`, reemplazar ese archivo por el resultado real de
   `db pull` (o corregirlo a mano) — hoy es una hipótesis, no un hecho verificado.
3. Verificar si hay policies o funciones adicionales en el dashboard de Supabase
   que no estén ni en `README.md` ni en estos archivos (por ejemplo, cualquier
   cambio hecho directo en el SQL Editor que no se haya documentado).
4. Una vez confirmado que estos archivos reflejan la realidad, todo cambio de
   schema futuro debería hacerse editando/agregando migraciones acá y aplicando
   con `supabase db push`, no directo en el dashboard — así el historial de git
   queda como fuente de verdad (punto 1.6 del roadmap, y precondición para
   Fase 3 según `DIAGNOSTICO_Y_PLAN.md`).

## Orden de aplicación

Los archivos están numerados y se aplican en orden ascendente:

- `0001_initial_schema.sql` — tablas base + RLS + RPC (fuente: `README.md`)
- `0002_favorite_songs.sql` — tabla `favorite_songs` (inferida, ver arriba)
- `0003_storage_policies.sql` — políticas del bucket `recordings` (fuente: `README.md`)
- `0004_plan_columns.sql` — columnas `plan`/`paid_until` en `user_profiles`, esqueleto de Fase 3 (Stripe). Segura de aplicar ya: todos quedan en `plan = 'free'` por defecto, no cambia el comportamiento actual.
- `0005_ai_consent.sql` — columnas `ai_data_consent`/`ai_data_consent_at` en `user_profiles`, para el consentimiento de uso de datos musicales en IA (ver `legal/politica-de-privacidad.md` sección 4). También segura de aplicar ya: default `false`, no activa nada por sí sola.

Ninguno de estos archivos se ejecutó contra Supabase durante esta sesión —
modo remoto no toca servicios externos. Son documentación versionada, lista
para que vos decidas cuándo y cómo aplicarla (o reconciliarla con `db pull`).

`0004` y `0005` sí se pueden aplicar de forma independiente y segura antes de
reconciliar `0001`-`0003` con `db pull`, porque son columnas nuevas con
default que no tocan datos existentes ni políticas ya en producción.
