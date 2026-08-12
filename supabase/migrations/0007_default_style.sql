-- Migración 0007: estilo musical por defecto para el análisis de IA.
-- Ver assets/js/app/app-controllers.js (renderSettings) y AIAnalysisEngine.js.
--
-- Guarda la preferencia del usuario para que el motor de IA use ese estilo
-- (bebop, hard bop, son cubano, latin jazz, bolero, jazz colombiano, blues,
-- o vacío = auto) como fallback cuando la grabación no declara uno.

alter table user_profiles
  add column if not exists default_style text default '';

comment on column user_profiles.default_style is 'Estilo musical preferido del usuario para prompts de IA cuando la grabación no especifica uno. Valores esperados: "", "bebop", "hard-bop", "son-cubano", "latin-jazz", "bolero", "jazz-colombiano", "blues". Vacío = sin preferencia.';
