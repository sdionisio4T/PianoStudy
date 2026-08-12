-- Migración 0006: soft-delete de cuentas.
-- Ver docs/DIAGNOSTICO_Y_PLAN.md y assets/js/app/app-controllers.js (deleteAccount).
--
-- El borrado no es inmediato. Cuando el usuario pide eliminar su cuenta desde
-- Ajustes, la Edge Function `delete-account` setea `deleted_at = now()` y
-- `deletion_scheduled_for = now() + 30 days`. El usuario tiene 30 días para
-- cancelar (login → modal "cuenta programada para eliminación"). Pasado el
-- plazo, un cron externo (documentado en docs/RUNBOOK_DEPLOY.md, aún pendiente)
-- borra el registro en auth.users, y las tablas dependientes caen por
-- ON DELETE CASCADE.

alter table user_profiles
  add column if not exists deleted_at timestamptz,
  add column if not exists deletion_scheduled_for timestamptz;

-- Índice parcial: solo indexa las filas marcadas para borrado, para que el
-- cron de purga pueda encontrarlas rápido sin agrandar el índice general.
create index if not exists user_profiles_deletion_scheduled_idx
  on user_profiles (deletion_scheduled_for)
  where deleted_at is not null;

comment on column user_profiles.deleted_at is 'Timestamp en el que el usuario pidió eliminar su cuenta. NULL = cuenta activa. NOT NULL = soft-deleted, se purgará cuando llegue deletion_scheduled_for.';
comment on column user_profiles.deletion_scheduled_for is 'Fecha planificada de purga definitiva (usualmente deleted_at + 30 días). Si el usuario cancela antes, se pone en NULL junto con deleted_at.';
