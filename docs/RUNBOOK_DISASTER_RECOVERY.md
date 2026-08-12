# Runbook de Disaster Recovery — PianoStudy

Creado 2026-08-09 como parte de la Fase 1 (backup y disaster recovery) de
`DIAGNOSTICO_Y_PLAN.md`. Este documento asume que ya configuraste los backups
descritos ahí (scripts en `scripts/backup/` y `scripts/git/`).

**Antes de necesitarlo de verdad: probalo una vez al año** contra un proyecto
Supabase de prueba (no el de producción) para confirmar que los pasos siguen
siendo válidos y que tenés todos los accesos que asume. Un runbook que nunca
se probó es una suposición, no un plan.

---

## 0. Qué se backupea y dónde vive cada cosa

| Qué | Dónde vive el backup | Frecuencia | Script |
|---|---|---|---|
| Código fuente | GitHub (`origin`) + mirror en GitLab/Gitea | cada push | `scripts/git/mirror_to_gitlab.sh` (manual) |
| Base de datos (tablas, RLS, RPC) | `backups/db/backup_YYYY-MM-DD.sql` (local) + Supabase backups automáticos (7-14 días según plan) | semanal | `scripts/backup/backup_db_weekly.ps1` |
| Storage bucket `recordings` | `backups/storage/YYYY-MM/` (local) | mensual | `scripts/backup/backup_storage_monthly.ps1` |
| Schema versionado (RLS/RPC como código) | `supabase/migrations/*.sql` (en git) | cuando cambia el schema | manual, ver `supabase/migrations/README.md` |
| Secrets (API keys, service role, password de DB) | **Solo en tu password manager** — nunca en git | — | — |

`backups/` está pensado para quedar **fuera de git** (ver nota en la sección 5)
porque puede contener audio de usuarios — no es apropiado versionarlo en el
mismo repo público/privado del código.

---

## 1. Escenario: perdiste la compu / se corrompió el working directory

1. Cloná el repo desde GitHub:
   ```
   git clone https://github.com/sdionisio4T/windsurf-project-2.git
   ```
2. Si GitHub también falla (ver escenario 2), cloná desde el mirror de GitLab.
3. Los `backups/` locales (DB y storage) NO están en git — si se perdieron
   junto con la compu, tu única copia es la que hayas subido a almacenamiento
   externo (Backblaze B2 / Cloudflare R2, ver Fase 1 Nivel 2 en
   `DIAGNOSTICO_Y_PLAN.md`, sección 5.3 — pendiente de implementar).
   **Mientras eso no esté, hacé una copia manual periódica de `backups/` a un
   disco externo o Drive.**

---

## 2. Escenario: se perdió la cuenta/repo de GitHub

1. Verificá que el mirror de GitLab (o Gitea) esté al día — si nunca corriste
   `scripts/git/mirror_to_gitlab.sh` o hace mucho que no lo corrés, este
   escenario te deja con código desactualizado. Correlo regularmente.
2. Cloná desde GitLab:
   ```
   git clone https://gitlab.com/tu-usuario/tu-repo.git
   ```
3. Recreá un repo en GitHub (o donde decidas alojar el proyecto) y pusheá
   el código recuperado ahí.
4. Reconfigurá cualquier integración que dependiera del repo de GitHub
   (webhooks, CI, despliegue).

---

## 3. Escenario: la base de datos se corrompió o se borró data crítica

**Primero evaluá si necesitás esto de verdad.** Si el problema es reciente
(dentro de la retención de tu plan Supabase — 7 días en free, 14 en Pro con
point-in-time recovery), es más seguro y más preciso usar el backup nativo de
Supabase (Dashboard → Database → Backups) que tu dump local semanal, porque
te da una restauración a un punto exacto en el tiempo sin perder los días
intermedios.

**Usá el backup local (`backups/db/backup_*.sql`) cuando:**
- El incidente es más viejo que la retención de tu plan Supabase, o
- Necesitás inspeccionar/recuperar datos específicos sin restaurar todo el proyecto.

### Pasos (restauración desde dump local)

⚠️ **Esto sobreescribe datos. Probalo primero contra un proyecto Supabase
de prueba, nunca directo en producción sin entender el impacto.**

1. Elegí el backup más reciente y bueno conocido en `backups/db/`.
2. Conectate con `psql` (viene con PostgreSQL, o usá el que trae `npx supabase`):
   ```
   psql "postgresql://postgres:TU_PASSWORD@db.XXXX.supabase.co:5432/postgres" -f backups/db/backup_2026-08-09.sql
   ```
3. Si el dump incluye `create table` para tablas que ya existen, vas a tener
   conflictos — depende de si el dump es "schema + data" completo (pensado
   para una base vacía) o si necesitás restaurar tabla por tabla. Revisá el
   contenido del `.sql` antes de correrlo a ciegas.
4. Después de restaurar, correr un smoke test manual: login, cargar licks,
   ver grabaciones — confirmar que la app funciona antes de dar el incidente
   por cerrado.

---

## 4. Escenario: se perdió o corrompió el bucket `recordings`

1. Recreá el bucket `recordings` en Supabase Storage si hace falta (dashboard,
   o aplicando `supabase/migrations/0003_storage_policies.sql` para las
   policies — el bucket en sí se crea desde el dashboard).
2. Restaurá los archivos desde el backup mensual más reciente en
   `backups/storage/YYYY-MM/`. Ejemplo de re-subida de un archivo individual
   vía REST API (PowerShell):
   ```powershell
   $headers = @{
       'apikey' = $env:SUPABASE_SERVICE_ROLE_KEY
       'Authorization' = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
   }
   Invoke-RestMethod -Method Post `
     -Uri "$($env:SUPABASE_URL)/storage/v1/object/recordings/<user_id>/<archivo>.webm" `
     -Headers $headers -InFile "backups\storage\2026-08\<user_id>\<archivo>.webm"
   ```
3. Para restaurar el bucket completo, iterar todos los archivos bajo
   `backups/storage/YYYY-MM/` y repetir el paso anterior por cada uno
   (mismo patrón que usa `scripts/backup/backup_storage_monthly.ps1` para
   listar, pero en sentido inverso — subir en vez de bajar). No existe hoy un
   script ya armado para esto porque restaurar storage completo es una
   operación rara y de alto impacto que conviene hacer con supervisión
   directa, no automatizada.
4. **Importante:** el backup mensual solo captura el estado del último mes.
   Cualquier grabación subida después del último backup y perdida en el
   incidente no es recuperable con este mecanismo — es la razón por la que
   el diagnóstico marca el bucket `recordings` como "el punto más vulnerable"
   (ver `DIAGNOSTICO_Y_PLAN.md`, sección 5.2.C).

---

## 5. Escenario: perdiste acceso a secrets/credenciales

Esto es lo único que este runbook **no puede recuperar por sí mismo** —
depende de qué tengas guardado en tu password manager:

- **`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`**: si las perdiste, generá keys
  nuevas en Anthropic Console / Google AI Studio y cargalas de nuevo en
  Supabase Dashboard → Edge Functions → Secrets.
- **`SUPABASE_DB_URL`** (con password de la DB): Dashboard → Project Settings
  → Database → Connection string. Si perdiste el password de la DB, se puede
  resetear desde ahí (esto invalida el password anterior — actualizá el
  script `backup_db_weekly.ps1`/variable de entorno después).
- **`SUPABASE_SERVICE_ROLE_KEY`**: Dashboard → Project Settings → API. Se
  puede regenerar (rotarla) si sospechás que se filtró — pero eso invalida
  la key vieja en cualquier lado donde esté en uso.
- **`SUPABASE_URL` / anon key**: estas no son secretas (están hardcodeadas en
  `assets/js/modules/supabase-client.js` a propósito, es su uso previsto) —
  se recuperan leyendo el código.

**Recomendación:** guardá las credenciales de arriba en un password manager
(1Password, Bitwarden, etc.), no en un archivo de texto ni en git. Si en algún
momento aparecen en un commit por error, tratalas como comprometidas y rotalas.

---

## 6. Checklist de verificación post-recuperación

Después de cualquier restauración, antes de considerar el incidente cerrado:

- [ ] La app carga sin errores de consola.
- [ ] Login/registro funciona.
- [ ] Se pueden ver licks, grabaciones, artistas y canciones favoritas existentes.
- [ ] Se puede grabar y guardar un nuevo lick de prueba.
- [ ] El análisis de IA responde (requiere `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`
      cargadas y las edge functions desplegadas — ver Fase 0).
- [ ] Las políticas RLS siguen activas (probar que un usuario no vea datos de otro).
- [ ] Actualizaste este runbook si algún paso resultó estar desactualizado.

---

## 7. Pendiente para fortalecer este plan (no implementado en esta sesión)

- Backup automático de `backups/` a almacenamiento externo (Backblaze B2 /
  Cloudflare R2) — hoy los backups locales dependen de esta misma compu.
- Script de restauración completa de storage (automatizar la sección 4.3).
- Automatizar la ejecución de `backup_db_weekly.ps1` y
  `backup_storage_monthly.ps1` vía Windows Task Scheduler (instrucciones en
  `scripts/backup/README.md`, pero el registro de las tareas en el
  Scheduler lo tenés que hacer vos).
- Decidir upgrade a Supabase Pro para point-in-time recovery si el proyecto
  escala (Fase 1 Nivel 2 de `DIAGNOSTICO_Y_PLAN.md`).
