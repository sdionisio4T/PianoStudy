-- Migración 0008: eliminación del sistema de pregunta de seguridad.
-- Ver assets/js/modules/AuthManager.js y auth-ui.js.
--
-- La recuperación de contraseña pasa a hacerse por link por email
-- (supabase.auth.resetPasswordForEmail). La pregunta de seguridad era un
-- antipatrón: OWASP y NIST desaconsejan preguntas de seguridad como método
-- de recuperación (respuestas adivinables por OSINT, reutilizadas entre
-- servicios, falsa sensación de segundo factor). Además el flujo actual
-- estaba roto: el hash de la respuesta vive en user_metadata que solo se
-- podía leer del localStorage propio, así que "olvidé mi contraseña" desde
-- un navegador nuevo nunca funcionaba.
--
-- Se elimina la columna del profile. Los campos `securityQuestion`/`answerHash`/
-- `answerSalt` que quedan en auth.users.raw_user_meta_data son huérfanos
-- inofensivos — están en una tabla del schema `auth` de Supabase, no se
-- pueden borrar con SQL directo. Si se quiere purgarlos, hay un TODO en
-- docs/RUNBOOK_DEPLOY.md con el script one-shot (service role key, admin API).

alter table user_profiles
  drop column if exists security_question;
