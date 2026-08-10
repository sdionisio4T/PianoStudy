-- Migración 0004: columnas de plan para Fase 3 (Stripe) — ESQUELETO.
-- Preparación estructural: agrega las columnas necesarias para distinguir
-- usuarios free/premium, pero Stripe todavía no está configurado (ver
-- supabase/functions/stripe-webhook/index.ts). Es seguro aplicar esta
-- migración ya mismo: por defecto todos los usuarios quedan en 'free', no
-- cambia el comportamiento actual de la app para nadie.

alter table user_profiles
  add column if not exists plan text not null default 'free',
  add column if not exists paid_until timestamptz;

-- Restringe los valores posibles de `plan`. Si en el futuro se agregan más
-- niveles (ej. 'premium_anual' vs 'premium_mensual'), actualizar este check
-- en una migración nueva en vez de editar esta.
alter table user_profiles
  add constraint user_profiles_plan_check check (plan in ('free', 'premium'));

comment on column user_profiles.plan is 'Plan del usuario: free (default) o premium. Lo actualiza el webhook de Stripe, no se edita a mano salvo soporte.';
comment on column user_profiles.paid_until is 'Fecha hasta la que el plan premium está pagado. NULL si el usuario es free o si la suscripción no tiene vencimiento conocido todavía.';
