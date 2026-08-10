-- Migración 0005: consentimiento para uso de datos musicales en IA.
-- Ver legal/politica-de-privacidad.md sección 4 y legal/terminos-de-servicio.md
-- sección 6 — este consentimiento es aparte y explícito, no viene activado
-- por defecto (default false). Lo gestiona assets/js/modules/ConsentManager.js.

alter table user_profiles
  add column if not exists ai_data_consent boolean not null default false,
  add column if not exists ai_data_consent_at timestamptz;

comment on column user_profiles.ai_data_consent is 'Si el usuario dio consentimiento explícito para que sus datos musicales (grabaciones, frases MIDI, interacciones con la IA) se usen para mejorar modelos de IA. Default false — nunca se activa solo, requiere una acción explícita del usuario (ver ConsentManager.js).';
comment on column user_profiles.ai_data_consent_at is 'Cuándo se registró el consentimiento (o su última actualización, incluyendo retiro). NULL si nunca se pidió/respondió.';
