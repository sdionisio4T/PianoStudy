# Resumen sesión remota — 2026-08-09

Modo remoto. Trabajo hecho sobre la rama actual (`gemini`), sin crear ramas, sin commits ni push. Todo queda como cambios sin commitear en el working tree — revisar con `git status` / `git diff`.

Se ejecutó la **Fase 0 de seguridad** completa según `DIAGNOSTICO_Y_PLAN.md`, en el orden que no dependía de que cargues los secrets en Supabase primero, y después el bloque que sí depende de eso (preparado con TODOs). Más tarde en la misma sesión se ejecutó también la **Fase 1 de backup y disaster recovery** (ver sección dedicada más abajo).

---

## Archivos tocados — Fase 0 (seguridad)

- `app.js`
- `index.html`
- `assets/js/modules/AIAnalysisEngine.js`
- `assets/js/modules/AuthManager.js`
- `supabase/functions/anthropic-proxy/index.ts`
- `supabase/functions/gemini-proxy/index.ts`

No se tocó nada más en esta parte (ni `AudioAnalyzer.js`, ni `ArtistsManager.js`, ni `FavoriteSongsManager.js`, ni `ProgressTracker.js`, ni `README.md`).

---

## Qué se hizo, tarea por tarea

### 0.6 — Borrar la API key del cliente (`app.js`, `index.html`)

- Eliminado `localStorage.setItem('pianostudy-ai-api-key', ...)` y los dos `localStorage.getItem('pianostudy-ai-api-key')`.
- Eliminado el handler `data-action="ai-key-save"` en `app.js`.
- Eliminado el `<input id="anthropic-api-key">` y el botón "Guardar" en `index.html` (sección Ajustes → IA). Se dejó el indicador de estado pero ahora es estático ("IA Activa"), porque la disponibilidad de la IA ya no depende de que el usuario cargue nada — depende del proxy server-side.
- `initializeAIEngine()` ahora instancia `new AIAnalysisEngine()` siempre (sin key), y las dos instanciaciones sueltas (`new AIAnalysisEngine('')` en `showAnalysisSection`/análisis y en el chat de preguntas) se limpiaron a `new AIAnalysisEngine()`.

**Decisión tomada sin consultar** (cae dentro de lo pre-aprobado en el modo remoto): el indicador "IA Activa/Inactiva" dejó de reflejar si hay key configurada (ya no aplica) y ahora siempre muestra "IA Activa". Si querés que refleje si el usuario tiene sesión iniciada (porque el proxy exige JWT), es un cambio chico a futuro — no lo hice porque no estaba pedido explícitamente y agregaba una decisión de UX no trivial.

### 0.4 — `AIAnalysisEngine.js` sin apiKey en el cliente

- Constructor ya no recibe ni guarda `apiKey`.
- `callGemini()` ya no hace `fetch` directo a la API de Google. Ahora llama `db.functions.invoke('gemini-proxy', { body: { prompt, systemPrompt } })` (usa el cliente de `supabase-client.js`, que automáticamente adjunta el JWT del usuario si hay sesión activa).
- `answerQuestion()` perdió el chequeo `if (!this.apiKey) return fallback` porque ya no existe ese concepto — ahora siempre intenta la llamada real y cae al fallback local solo si el proxy falla (network, 401, 429, etc.), igual que antes.
- La forma de la respuesta esperada (`data.candidates[0].content.parts[0].text`) no cambió, porque el proxy sigue devolviendo `{ status, body }` donde `body` es la respuesta cruda de Gemini.

### 0.11 — Sacar console.log de respuestas LLM

- Los dos `console.log` de `AIAnalysisEngine.js` (`[callGemini] error body` y `[callGemini] respuesta completa`, este último volcaba el JSON completo de cada respuesta de Gemini a la consola) se eliminaron al reescribir `callGemini()`.
- Grep en `app.js` y en todos los módulos de `assets/js/modules/` no encontró ningún otro `console.log`/`debug`/`info` relacionado a respuestas de IA. El único `console.log` que queda en `app.js` (línea ~3565, "Selección: X segundos") no tiene que ver con LLM y no es un leak de datos sensibles — se dejó como está.

### 0.8 — SHA-256 → PBKDF2 en `AuthManager.js`

- `hashPassword(password, salt)` ahora usa `crypto.subtle.importKey('raw', ..., 'PBKDF2', ...)` + `crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, ..., 256)` en vez de `crypto.subtle.digest('SHA-256', ...)`.
- La firma de la función no cambió (mismo input/output: hex string), así que no hubo que tocar `register()`, `verifySecurityAnswer()`, `resetPassword()` ni `setSecurityQuestion()` — todos siguen llamando a `hashPassword` igual que antes.

**⚠️ Importante — rompe compatibilidad hacia atrás:** cualquier usuario que ya haya configurado su pregunta de seguridad ANTES de este cambio tiene guardado un hash SHA-256 (`answerHash`/`answerSalt` en `user_metadata`). Después de este cambio, `verifySecurityAnswer()` va a generar hashes PBKDF2 y **no van a coincidir con los hashes viejos**, así que esos usuarios no van a poder recuperar su contraseña por pregunta de seguridad hasta que la reconfiguren. Esto NO afecta el login normal (eso lo maneja Supabase Auth con bcrypt, intacto). Es una decisión de producto que te dejo para que evalúes: podés (a) aceptarlo tal cual y avisar a los pocos usuarios que la tengan configurada, o (b) pedirme que agregue un flujo de migración (detectar hash viejo, verificar con SHA-256 como fallback, y re-hashear con PBKDF2 en el próximo uso). No lo implementé porque agrega complejidad no pedida y quería que decidieras vos.

### 0.9 — Auditoría de `.innerHTML` en `app.js`

- Revisé exhaustivamente los ~50 usos de `.innerHTML =` en `app.js`, más los de `ArtistsManager.js`, `FavoriteSongsManager.js` y `auth-ui.js`.
- **No se encontró ningún vector XSS sin sanear.** Todo el contenido dinámico que viene de usuario o DB (nombres de licks, artistas, canciones, frases, respuestas de IA, nombres de usuario) ya pasa por `escapeHtml()` (de `utils/sanitizers.js`) o por `escSafe()` (equivalente local en `auth-ui.js`), o se inyecta vía `textContent` en vez de `innerHTML` (notificaciones, toasts).
- No se modificó ningún archivo para esta tarea — quedó confirmado que el diagnóstico original ("auditar y verificar") ya estaba en buen estado, tal como anotaba el propio `DIAGNOSTICO_Y_PLAN.md` en la sección "cosas que sí están bien".

### 0.2 / 0.3 — Refactor de los proxies (`anthropic-proxy/index.ts`, `gemini-proxy/index.ts`)

Cambios idénticos en estructura para ambos archivos:

- La API key ya **no** se lee del body del request (`apiKey` del cliente). Ahora se lee de `Deno.env.get('ANTHROPIC_API_KEY')` / `Deno.env.get('GEMINI_API_KEY')`.
- Si la env var no está configurada, el proxy responde `500` con `{ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }` (o el equivalente de Gemini) en vez de fallar de forma confusa.
- Hay un comentario `TODO` explícito arriba de cada lectura de env var recordando que **vos tenés que cargar `ANTHROPIC_API_KEY` y `GEMINI_API_KEY` en Supabase Dashboard → Project Settings → Edge Functions → Secrets** antes de desplegar (ese es el paso 0.1, ver más abajo).

### 0.5 — Verificación de JWT en los proxies

- Ambos proxies ahora exigen header `Authorization` en cada request; si falta, devuelven `401`.
- Con ese header arman un cliente de Supabase (`createClient` desde `https://esm.sh/@supabase/supabase-js@2`, import remoto — patrón estándar en Supabase Edge Functions) usando `SUPABASE_URL` y `SUPABASE_ANON_KEY` (estas dos ya vienen inyectadas automáticamente por Supabase en el entorno de las Edge Functions, no hace falta cargarlas vos).
- Llaman a `supabaseClient.auth.getUser()` para validar el JWT contra el auth server real (no es un decode local sin verificar). Si el token es inválido/expiró, devuelven `401`.
- El `user.id` que devuelve esa validación es el que se usa como key del rate limiting (punto siguiente).

### 0.7 — Rate limiting básico en los proxies

- Implementado con un `Map<string, number[]>` en memoria por instancia del edge function: por cada `user_id`, guarda los timestamps de sus últimos requests y descarta los que tienen más de 60 segundos.
- Si un usuario supera **10 requests en la ventana de 60 segundos**, el proxy responde `429` con `{ error: 'Too many requests, slow down.' }`.
- **Limitación conocida (documentada en comentario en el código):** al ser en memoria y no compartido, se resetea en cada cold start y no es consistente entre instancias si Supabase escala el edge function horizontalmente. Es una primera línea de defensa razonable para el volumen actual, no un límite duro a prueba de abuso distribuido. Si en el futuro hay más tráfico, la mejora natural es mover el contador a una tabla de Postgres o a Redis/Upstash.

---

## Decisiones que tomé sin preguntar (dentro de lo pre-aprobado)

1. Indicador "IA Activa" ahora es estático en vez de depender de una key en localStorage (ver 0.6).
2. Rate limit fijado en 10 req/min por usuario, tal como pedía la tarea — no lo hice configurable ni con variable de entorno porque no se pidió.
3. Verificación de JWT vía `supabaseClient.auth.getUser()` (validación real contra el auth server) en vez de un decode local del token — es la forma correcta y no agrega complejidad relevante.
4. No implementé migración de hashes SHA-256 → PBKDF2 para respuestas de seguridad ya existentes (ver nota en 0.8) — te lo dejo para que decidas.

## Qué NO se tocó y por qué

- `2.4` (política del bucket `recordings` con lectura pública) — es una decisión de producto explícita del diagnóstico ("¿es feature o descuido?"), no estaba en la lista de tareas que aprobaste para esta sesión.
- `AudioAnalyzer.js`, `ArtistsManager.js`, `FavoriteSongsManager.js`, `ProgressTracker.js`, `SupabaseDataManager.js` — no requerían cambios para ninguna de las tareas de Fase 0 aprobadas.
- No se corrió `supabase functions deploy` ni ningún comando contra Supabase — modo remoto no toca servicios externos.
- No se hizo `git add`/`commit`/`push`.

---

## Qué falta de tu lado (obligatorio antes de que esto funcione en producción)

### Paso 0.1 — el bloqueante real

**Tenés que cargar dos secrets en Supabase Dashboard → Project Settings → Edge Functions → Secrets:**

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

Sin esto, `anthropic-proxy` y `gemini-proxy` van a responder `500 Server misconfigured` en cuanto los despliegues, porque el código ahora los busca en `Deno.env` y ya no acepta que el cliente los mande.

### Después de cargar los secrets

1. Desplegar las dos funciones actualizadas:
   ```
   supabase functions deploy anthropic-proxy
   supabase functions deploy gemini-proxy
   ```
2. Probar el flujo de análisis de IA en la app real (Q&A y análisis de grabación) — yo no pude probarlo porque no tengo acceso a Supabase real desde acá.
3. Decidir qué hacer con los usuarios que ya tenían pregunta de seguridad configurada antes del cambio de PBKDF2 (ver nota en 0.8): avisarles que la reconfiguren, o pedirme que agregue compatibilidad con el hash viejo.
4. Revisar el diff completo con `git status` / `git diff` y decidir cómo agrupar los commits (sugerencia abajo).
5. Las tareas `0.10` (política de bucket `recordings`) y el resto de la Fase 1 en adelante siguen pendientes — no formaban parte de lo aprobado para esta sesión.

---

---

## Fase 1 — Backup y disaster recovery

Aprobada y ejecutada en el mismo día, después de la Fase 0. Tareas cubiertas: 1.2, 1.3, 1.5, 1.6, 1.7 (el resto de la Fase 1 — backup automático a Backblaze/R2, upgrade a Supabase Pro — sigue pendiente, no estaba en el alcance aprobado para esta sesión).

### Archivos nuevos — Fase 1

- `.gitignore` (nuevo — no existía ninguno en el repo)
- `scripts/git/mirror_to_gitlab.sh`
- `scripts/backup/backup_db_weekly.ps1`
- `scripts/backup/backup_storage_monthly.ps1`
- `scripts/backup/README.md`
- `supabase/migrations/README.md`
- `supabase/migrations/0001_initial_schema.sql`
- `supabase/migrations/0002_favorite_songs.sql`
- `supabase/migrations/0003_storage_policies.sql`
- `RUNBOOK_DISASTER_RECOVERY.md`

Ninguno de estos scripts se ejecutó contra Supabase o GitLab durante la sesión — modo remoto no toca servicios externos. Quedan listos para que los corras vos.

### 1.2 — Mirror a GitLab (`scripts/git/mirror_to_gitlab.sh`)

- Script bash (Git Bash en Windows) que agrega un remote `gitlab-mirror` (si no existe, pidiendo la URL como primer argumento la primera vez) y después pushea con `git push --all` + `git push --tags`.
- **Decisión deliberada:** NO usa `git push --mirror`. Ese flag borra en destino cualquier ref que no exista localmente — es potencialmente destructivo si el repo de GitLab llegó a tener algo propio. Usé `--all` + `--tags`, que es aditivo/seguro.
- No lo ejecuté (requeriría credenciales de GitLab que no tengo, y sería un push a un servicio externo — justo lo que el modo remoto prohíbe). Vos tenés que: crear el repo vacío en GitLab/Gitea, tener SSH key o token configurado, y correr el script a mano.

### 1.3 — Backup semanal de DB (`scripts/backup/backup_db_weekly.ps1`)

- PowerShell, usa `npx supabase db dump --db-url $env:SUPABASE_DB_URL -f <archivo>`.
- Requiere la variable de entorno `SUPABASE_DB_URL` (connection string con password) — el script la lee del entorno, nunca la tiene hardcodeada. Instrucciones de setup en `scripts/backup/README.md`.
- Guarda en `backups/db/backup_<fecha>.sql`, loggea en `backups/db/backup_db.log`, y rota automáticamente dejando solo los últimos 4 backups (~1 mes si corre semanal, tal como pedía la tarea).
- Instrucciones completas para registrarlo en Windows Task Scheduler (con los argumentos exactos de `powershell.exe`) están en `scripts/backup/README.md`.
- **No lo pude ejecutar ni probar de verdad** — no tengo el `SUPABASE_DB_URL` ni acceso a tu proyecto real. La sintaxis de `supabase db dump` puede variar entre versiones del CLI; el script loggea el error y sugiere correr `npx supabase db dump --help` si falla.

### 1.5 — Backup mensual del bucket `recordings` (`scripts/backup/backup_storage_monthly.ps1`)

- PowerShell, usa la REST API de Supabase Storage directamente (list + download), sin dependencias externas más allá de PowerShell.
- Requiere `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_URL` como variables de entorno. Usa **service_role**, no anon key, a propósito: así el backup no depende de que la policy de lectura pública del bucket siga existiendo (esa policy está marcada como pendiente de revisión en `DIAGNOSTICO_Y_PLAN.md` 2.4 — si la cambian a privada, este script sigue funcionando igual).
- Recorre el bucket recursivamente (maneja subcarpetas como `licks/<user_id>/` y `<user_id>/`, paginando de a 100 objetos), y guarda todo en `backups/storage/<año-mes>/` preservando la estructura original.
- Tampoco lo pude probar contra el proyecto real por la misma razón que 1.3. La lógica de "qué es carpeta vs qué es archivo" en la respuesta del list API de Supabase (id/metadata null = carpeta) está documentada en un comentario del script — si Supabase cambia esa forma de respuesta en el futuro, revisar ahí primero.

### 1.6 — RLS y RPC versionados (`supabase/migrations/`)

- `0001_initial_schema.sql`: copia fiel del bloque SQL que ya estaba documentado en `README.md` (tablas `licks`, `recordings`, `custom_artists`, `user_profiles`, `practice_sessions`, sus RLS, la función `get_email_by_username`, y el backfill).
- `0003_storage_policies.sql`: las dos policies de `storage.objects` que también estaban en `README.md`.
- **`0002_favorite_songs.sql` — esto sí es una decisión que tomé y que necesita tu verificación:** encontré que `assets/js/modules/SupabaseDataManager.js` usa una tabla `favorite_songs` (funciones `loadFavoriteSongs`, `insertFavoriteSong`, `deleteFavoriteSong`) que **no estaba documentada en ningún lado** — ni en `README.md` ni en el diagnóstico. Reconstruí su definición a partir de qué columnas lee/escribe el cliente (`id`, `user_id`, `name`, `artist`, `youtube_url`, `style`, `notes`, `created_at`) y le puse RLS siguiendo el mismo patrón que `custom_artists`/`practice_sessions`. **Esto es una inferencia, no una copia del schema real** — no tengo forma de confirmar que las columnas, tipos o policies reales coincidan. `supabase/migrations/README.md` explica esto en detalle y te pide correr `supabase db pull` para reconciliar.
- No apliqué ninguna de estas migraciones contra Supabase (modo remoto).

### 1.7 — `RUNBOOK_DISASTER_RECOVERY.md`

- Cubre 5 escenarios: perder la compu, perder la cuenta de GitHub, corrupción/pérdida de datos en la DB, pérdida del bucket `recordings`, y pérdida de credenciales/secrets.
- Cada escenario tiene pasos concretos que referencian los scripts de arriba, con comandos de ejemplo (incluyendo restauración vía REST API para storage).
- Incluye una advertencia explícita en la sección de restauración de DB: preferir el backup nativo de Supabase (point-in-time recovery) sobre el dump local cuando el incidente es reciente, porque es más preciso.
- Incluye un checklist de verificación post-recuperación y una sección de "pendiente" (backup a almacenamiento externo, automatizar restauración completa de storage, evaluar Supabase Pro) que no estaba en el alcance de esta sesión.

### Decisión adicional no pedida explícitamente: `.gitignore`

El repo no tenía `.gitignore`. Como los backups nuevos (`backups/db/*.sql`, `backups/storage/**`) pueden contener datos personales de usuarios (emails en el dump de DB, grabaciones de audio), creé un `.gitignore` mínimo que excluye `backups/` (y `node_modules/` por si el proyecto suma un bundler en Fase 2). Lo hice porque dejar esos backups versionables por accidente sería un problema de privacidad más grave que cualquiera de los que arreglamos en Fase 0 — me pareció una omisión de seguridad razonable de corregir sin preguntar, dado que ya estaba aprobado trabajar en backups.

### Qué falta de tu lado — Fase 1

1. Crear el repo vacío en GitLab/Gitea y correr `scripts/git/mirror_to_gitlab.sh <url>` una vez.
2. Setear `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_URL` como variables de entorno de usuario en Windows (instrucciones exactas en `scripts/backup/README.md`).
3. Probar `backup_db_weekly.ps1` y `backup_storage_monthly.ps1` a mano al menos una vez antes de programarlos.
4. Registrar ambos scripts en Windows Task Scheduler (pasos detallados en `scripts/backup/README.md`).
5. Correr `supabase db pull` y reconciliar `supabase/migrations/` con el schema real — en particular confirmar o corregir `0002_favorite_songs.sql`.
6. Revisar `RUNBOOK_DISASTER_RECOVERY.md` y probarlo una vez contra un proyecto Supabase de prueba (no producción).
7. Fase 1 completa (Nivel 2 de `DIAGNOSTICO_Y_PLAN.md`) todavía requiere: backup a Backblaze B2/Cloudflare R2 y decidir si conviene el upgrade a Supabase Pro — no implementado, queda para una próxima sesión si lo aprobás.

---

---

## Fase 2 — Arquitectura sostenible

Aprobada y ejecutada el mismo día, después de la Fase 1. Tareas cubiertas: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7 (2.4 — bundle local de essentia.js/basic-pitch — no estaba en el alcance aprobado, sigue pendiente).

Esta fase tocó código de producción real (no solo scripts/documentación nuevos como las Fases 0 y 1), así que el nivel de verificación fue más alto: cada paso se validó con `npm run build` real y, para el split de `app.js`, con una prueba en un browser real vía `vite preview` — no me quedé solo con "compila".

### Archivos nuevos y modificados — Fase 2

Nuevos:
- `package.json`, `package-lock.json`, `vite.config.js`
- `.env.development`, `.env.production`
- `assets/js/app/app-state.js`, `app-ui.js`, `app-controllers.js`, `app-audio-flow.js`, `app-init.js`
- `_pendiente_revision/app.js` (el `app.js` original, movido — ver más abajo) + `_pendiente_revision/README.md`
- `supabase/functions/_shared/rateLimiter.ts`
- `tests/setup.js`, `tests/sanitizers.test.js`, `tests/rateLimiter.test.js`, `tests/authManager.test.js`
- `.github/workflows/ci.yml`
- `RUNBOOK_DEPLOY.md`

Modificados:
- `index.html` (entry point del script apunta a `assets/js/app/app-init.js` en vez de `app.js`)
- `assets/js/modules/supabase-client.js` (URL/anon key ahora vienen de `import.meta.env.VITE_*`, con fallback a los valores previos)
- `supabase/functions/anthropic-proxy/index.ts`, `supabase/functions/gemini-proxy/index.ts` (usan el rate limiter compartido extraído)
- `.gitignore` (agregado `dist/`, `.env.local`, `.env.*.local`)

### 2.2 — Split de `app.js` (la parte de más riesgo de esta sesión)

`app.js` era una única clase `PianoStudyApp` de 4655 líneas con 171 métodos. Antes de tocar nada escribí un script que:

1. Localizó los 171 métodos por su firma (indentación de 4 espacios, patrón consistente en todo el archivo — verifiqué que no hubiera métodos con firma multilínea ni campos de clase tipo arrow function que rompieran el patrón).
2. Categorizó cada uno en uno de los 5 dominios pedidos, siguiendo la propia descripción de `DIAGNOSTICO_Y_PLAN.md` (`app-ui.js` = DOM/eventos, `app-state.js` = estado, `app-controllers.js` = lógica de features, `app-audio-flow.js` = grabación/editor de frases/análisis IA, `app-init.js` = arranque).
3. Extrajo cada método **byte a byte** (sin reescribir código a mano) a su archivo destino.

**Decisión de diseño clave:** en vez de partir la clase en 5 clases separadas (que hubiera obligado a rediseñar qué es "público" entre ellas y cómo se pasan referencias — alto riesgo de romper algo que no puedo probar contra Supabase real), usé el **patrón mixin**: los 4 archivos de dominio exportan objetos planos (`stateMixin`, `uiMixin`, etc.) con los métodos, y `app-init.js` los combina sobre un único `PianoStudyApp.prototype` con `Object.assign`. El resultado es el mismo objeto único con el mismo `this` de siempre — cero cambio de comportamiento, es reorganización de archivos, no un rediseño.

El constructor se convirtió en `initState(app)` (una función que recibe la instancia y le asigna los mismos campos que antes; internamente reemplacé `this` por el parámetro `app`) porque un constructor real no se puede "mezclar" vía `Object.assign` — solo puede haber uno, definido en la clase.

**Verificación aplicada (en este orden, cada una tuvo que pasar antes de seguir):**
1. Script de reconstrucción: tomé los 171 métodos de los 5 archivos nuevos, los reordené como estaban originalmente y comparé el resultado contra el `app.js` original, ignorando solo diferencias de líneas en blanco. **Resultado: idéntico, carácter por carácter.** Esto descarta que se haya perdido, duplicado o alterado código durante la extracción.
2. Detecté que cada mixin necesitaba sus propios `import` (los módulos ES no comparten imports entre archivos): escribí un análisis que, por archivo, distingue usos "libres" de un símbolo (ej. `getRecordingPublicUrl(...)`) de usos vía `this.` (ej. `this.deleteLick(...)`, que no necesita import porque resuelve por prototype) y usos que son la propia definición del método. Con eso agregué exactamente los imports que faltaban en cada archivo — no de más, no de menos.
3. `npm run build` (Vite) compiló los 21 módulos sin errores de resolución de imports — esto valida en la práctica que los imports que agregué a mano en el paso 2 están completos y correctos.
4. **Prueba en un browser real** (herramienta de preview): levanté `vite preview`, cargué la app, y con JavaScript inyectado llamé directamente `window.app.showSection('licks')`, `'artists'`, `'favorites'`, `'progress'` y `window.app.performSearch()` — todos ejecutaron sin error, y confirmé que los 4 mixins están correctamente mezclados en el prototype (`typeof window.app.showSection === 'function'`, ídem para métodos de cada uno de los otros 3 dominios). La consola del browser solo mostró dos errores, **ambos preexistentes y no relacionados con el split**: un `EvalError` de CSP (probablemente essentia.js intentando usar `eval`, no toqué la CSP ni esos scripts) y un `NotAllowedError` de micrófono (esperable, el browser de la sandbox no tiene permiso de mic — no es un bug).

Lo que **no** pude probar: cualquier flujo que requiera sesión autenticada real contra Supabase (login, grabar y guardar un lick, ver análisis guardados, etc.) — la sandbox no tiene credenciales de usuario real y no iba a intentar loguearme con datos de producción sin tu autorización explícita. Antes de confiar 100% en el split, probá vos esos flujos.

El `app.js` original **no se borró** (regla del modo remoto) — se movió a `_pendiente_revision/app.js` con una nota explicando por qué está ahí y qué verificar antes de borrarlo definitivamente.

### 2.1 — Setup de Vite

- `package.json` con `vite` y `vitest` como devDependencies, scripts `dev`/`build`/`preview`/`test`.
- `vite.config.js` mínimo: `outDir: dist`, `assetsDir: assets-build`. Cache-busting automático confirmado (los archivos de salida llevan hash: `index-COEzuNin.js`, `index-DkoivcZu.css`).
- Los `<script src="https://...">` de CDN (Supabase JS, essentia.js, basic-pitch, YouTube iframe API) quedaron intactos en `index.html` — Vite los deja pasar sin tocarlos porque no son parte del grafo de módulos ES. Solo bundleó `auth-ui.js` + `app-init.js` (y todo lo que importan transitivamente) en un único chunk.
- `npm install` reportó 5 vulnerabilidades (3 moderate, 1 high, 1 critical) — **todas la misma cadena**: una vulnerabilidad conocida de `esbuild` (GHSA-67mh-4wv8-2f99) que solo afecta al dev server local (`npm run dev`), no a lo que se buildea/despliega. Arreglarla de raíz requiere subir a Vite 8 (breaking change) — no lo hice sin que lo pruebes vos primero. Mientras tanto, el riesgo real es bajo (requiere tener el dev server corriendo Y visitar un sitio malicioso en el mismo navegador al mismo tiempo).
- **CSP y `vite dev`:** la CSP de `index.html` (vía `<meta>`) no incluye `ws://localhost` en `connect-src`, así que el WebSocket de HMR de `npm run dev` probablemente va a fallar en consola (el resto de la app debería seguir funcionando, solo sin auto-reload). Para probar cambios de verdad, usá `npm run build && npm run preview` — es lo que yo usé para validar, sirve el build de producción real y no pelea con la CSP.

### 2.3 — Variables de entorno

- `supabase-client.js` ahora lee `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, con fallback a los valores hardcodeados anteriores (por si alguien abre `index.html` directo sin pasar por Vite).
- `.env.development` y `.env.production` — **ambos con los mismos valores** porque no existe un proyecto Supabase separado para desarrollo. Documenté esto explícitamente en los propios archivos para que quede claro que hoy "dev" y "prod" pegan a la misma base de datos real.
- Ninguno de los dos valores es secreto (la anon key de Supabase está diseñada para viajar al cliente, RLS controla el acceso real) — por eso ambos archivos se pueden commitear sin problema, no van al `.gitignore`.
- Verificado con `grep` sobre el bundle generado: el valor de `SUPABASE_URL` aparece inlineado correctamente en el JS de salida, y no queda ningún `import.meta.env` sin resolver.

### 2.5 — Tests con Vitest

13 tests en 3 archivos (más de los ~5 pedidos):

- `tests/sanitizers.test.js` (6 tests): `escapeHtml` escapa caracteres especiales y maneja null/undefined; `sanitizeFileName` remueve caracteres peligrosos y tiene fallback a `'file'`; `validateAudioBlob` acepta/rechaza tipos MIME.
- `tests/rateLimiter.test.js` (3 tests): permite hasta el límite y bloquea el siguiente request, cuenta usuarios por separado, vuelve a permitir después de que pasa la ventana de tiempo (con `vi.useFakeTimers`).
- `tests/authManager.test.js` (4 tests): `hashPassword` (PBKDF2) produce hex de 64 caracteres, es determinístico con el mismo salt, produce hashes distintos con salts distintos; `generateSalt` produce hex de 32 caracteres y es aleatorio entre llamadas.

**Decisión no pedida explícitamente pero necesaria para poder testear el rate limiter:** extraje la lógica de `isRateLimited` (que antes vivía duplicada inline en cada proxy) a `supabase/functions/_shared/rateLimiter.ts`, un módulo sin ninguna dependencia de Deno (solo `Map` + `Date.now()`), y actualicé los dos proxies para importarlo en vez de tener la copia propia. Doble beneficio: es testeable con Vitest tal cual pedía la tarea, y de paso eliminé la duplicación entre los dos proxies. Volví a correr `npm run build` después de este cambio para confirmar que no rompí nada en los proxies (aunque esos archivos no los bundlea Vite — igual verifiqué sintaxis).

**Detalle técnico:** `AuthManager.js` importa `supabase-client.js`, que depende de un global `supabase` (inyectado en el browser real por el script de CDN). Bajo Node/Vitest ese global no existe, así que agregué `tests/setup.js` que lo stubea antes de que se evalúen los imports de los tests — es el patrón estándar de Vitest para esto, no un hack específico de este proyecto.

### 2.6 — GitHub Actions

- `.github/workflows/ci.yml`: corre en cada PR contra `main` y en cada push a `main`. Pasos: checkout → setup Node 20 con cache de npm → `npm ci` → `npm test` → `npm run build`.
- **Importante: este workflow valida, no despliega.** No sube nada a ningún hosting — eso lo cubre `RUNBOOK_DEPLOY.md` como proceso manual por ahora.
- Verificado localmente corriendo la misma secuencia que el workflow (`rm -rf node_modules && npm ci && npm test && npm run build`) — pasa limpio.

### 2.7 — `RUNBOOK_DEPLOY.md`

- Checklist pre-deploy (tests, build, secrets de Supabase cargados).
- Pasos de deploy manual para las 3 opciones que ya mencionaba `README.md`: Netlify, Vercel, GitHub Pages — con la advertencia específica de que GitHub Pages necesita `base: '/nombre-repo/'` en `vite.config.js` (no seteado hoy, porque el config asume deploy en la raíz del dominio) mientras que Netlify/Vercel no.
- Aclara que el deploy de las Edge Functions (`supabase functions deploy`) es un proceso totalmente separado del deploy del frontend.
- Pasos de rollback por plataforma.
- Sección de "qué falta para que esto sea CD real" (deploy automático desde el workflow, ambiente de staging separado).

### Qué falta de tu lado — Fase 2

1. **Probar la app dividida contra Supabase real**: login, grabar, guardar un lick, ver análisis — todo lo que requiere sesión autenticada, que no pude ejercitar en la sandbox.
2. Una vez conforme con el punto anterior, podés borrar `_pendiente_revision/app.js` (ya no lo referencia nada).
3. Decidir si vale la pena resolver la vulnerabilidad de `esbuild` en el dev server subiendo a Vite 8 (breaking change, no lo hice sin tu ok).
4. Si vas a usar GitHub Pages para el deploy: agregar `base: '/nombre-repo/'` a `vite.config.js` antes del primer deploy ahí (no hace falta para Netlify/Vercel).
5. Elegir plataforma de hosting y hacer el primer deploy manual siguiendo `RUNBOOK_DEPLOY.md`.
6. Commitear `package-lock.json` (está en el working tree, no en `.gitignore`) — es necesario para que `npm ci` en GitHub Actions sea reproducible.
7. Fase 2.4 (bundle local de essentia.js/basic-pitch) sigue pendiente, no estaba en el alcance aprobado para esta sesión.

---

## Términos de Servicio y Política de Privacidad

Pedido aparte, fuera de las Fases del roadmap — preparación para habilitar Stripe (Fase 3) y para dejar cubierto el consentimiento de datos musicales antes de avanzar con NeuralJam (Fase 4).

### Archivos nuevos

- `legal/terminos-de-servicio.md`
- `legal/politica-de-privacidad.md`

### Qué tiene cada uno

- **Descripción del servicio, información de contacto y jurisdicción** — activas en ambos documentos, tal como las pide Stripe para aprobar una cuenta de pagos, independientemente de que Stripe todavía no esté configurado.
- **Sección de uso de datos musicales para IA (activa, no comentada, como pediste):** en los dos documentos hay una sección dedicada que explica que tus grabaciones, frases MIDI e interacciones con la IA (incluyendo NeuralJam a futuro) se usan por defecto SOLO para darte el servicio, y que usarlas para mejorar el modelo requiere un consentimiento aparte, explícito, revocable, no empaquetado dentro de la aceptación general de los Términos. Incluye una aclaración honesta sobre la limitación técnica real de este tipo de consentimientos: si un modelo ya se entrenó con tus datos antes de que retires el permiso, no se puede "desentrenar" esa versión específica, aunque sí se deja de usar tu información hacia adelante.
- **Sección de pagos/Stripe — comentada con `<!-- PENDIENTE: activar cuando se configure Stripe -->`, como pediste:** en Términos son las subsecciones 8.1 a 8.6 (planes, cómo se cobra, renovación automática, cancelación, reembolsos, cambios de precio); en Privacidad son la sección de "con quién compartimos tus datos" (el ítem de Stripe) y la sección 11 completa de "Datos de pago". Todo el contenido ya está redactado y estructurado — alcanza con quitar las marcas de comentario cuando Stripe esté configurado, no hace falta reescribir nada.
- **Política de reembolsos como sección estándar de Stripe:** la pediste comentada (instrucción 3) pero también la listaste como sección estándar que Stripe exige que exista (instrucción 5). Resolví la aparente contradicción así: el contenido detallado de reembolsos queda comentado junto con el resto de Stripe (8.5), pero la sección de "Planes y pagos" en Términos tiene una línea activa aclarando que hoy PianoStudy es gratuito y no se procesan pagos — así la estructura que Stripe espera existe y es visible, sin inventar una política de reembolsos para una función que todavía no existe.

### Decisiones que tomé sin preguntar (y por qué)

1. **No inventé datos reales** (nombre legal del titular, email de contacto, país/jurisdicción, dirección) porque no los tengo — dejé placeholders entre corchetes bien visibles (`[EMAIL DE CONTACTO]`, `[PAÍS / PROVINCIA — DEFINIR JURISDICCIÓN]`, etc.) en vez de asumir un país o inventar una razón social. Publicar cualquiera de los dos documentos sin completar esos placeholders sería peor que no publicarlos.
2. **Edad mínima sin definir** (`[13/16/18 — DEFINIR EDAD MÍNIMA]`): no tengo forma de saber qué edad mínima aplica según tu jurisdicción real ni tu decisión de producto, así que dejé las tres opciones más comunes como referencia en vez de elegir una arbitrariamente.
3. **Honestidad sobre el estado real de la infraestructura, no lo ideal:** la Política de Privacidad dice explícitamente que hoy no hay botón de autoservicio para exportar/borrar datos (coincide con lo que ya sabíamos del diagnóstico — tareas 5.5/5.6 de `DIAGNOSTICO_Y_PLAN.md`, no implementadas) y que las grabaciones en el bucket `recordings` son técnicamente accesibles por URL directa (coincide con la tarea 0.10/2.4 pendiente). Preferí que el documento sea honesto sobre el estado actual a que prometa capacidades que el producto todavía no tiene — lo segundo genera un riesgo legal real si alguna vez alguien audita la política contra el comportamiento real de la app.
4. **Advertencia de "borrador, no publicar todavía" al principio de cada archivo:** agregué un aviso destacado en ambos documentos porque son textos legales reales que un usuario podría aceptar creyendo que son definitivos. No es una sección que hayas pedido, pero publicar un ToS/Privacidad sin revisión legal y con placeholders sin completar es un riesgo que me pareció importante dejar explícito en el propio documento, no solo acá.

### Qué falta de tu lado

1. **Completar todos los placeholders entre corchetes** en ambos archivos: nombre legal/razón social, email de contacto, país y jurisdicción, edad mínima, plazo de respuesta a pedidos de datos.
2. **Revisión legal profesional antes de publicar** — en particular por el tratamiento de datos de menores, el consentimiento de IA (cada vez más regulado, ej. GDPR art. 6/22 y el AI Act europeo si vas a tener usuarios en la UE) y los requisitos concretos de Stripe para tu jurisdicción.
3. ~~Construir el mecanismo de consentimiento real para uso de datos en entrenamiento de IA~~ — **hecho en la ronda siguiente de esta misma sesión**, ver la sección "Fase 3 (esqueleto Stripe) y consentimiento de datos de IA" más abajo: `ConsentManager.js` + migración `0005_ai_consent.sql` + modal integrado en `auth-ui.js`.
4. Cuando actives Stripe: descomentar las secciones marcadas, completar los placeholders específicos de esa sección (features del plan Premium, precios, plazo de aviso de renovación, política de reembolsos concreta), y enlazar `legal/terminos-de-servicio.md`/`legal/politica-de-privacidad.md` desde la UI de checkout (Stripe lo exige para aprobar la cuenta).
5. Si en algún momento tenés usuarios en la Unión Europea o California, este borrador no cubre en detalle las obligaciones específicas de GDPR/CCPA (por ejemplo, base legal de tratamiento, DPO, transferencias internacionales de datos) — señalarlo al abogado que lo revise.

---

## Fase 3 (esqueleto Stripe), consentimiento de datos de IA, prompts y README técnico

Cuarta ronda de esta misma sesión remota, aprobada después de los documentos legales. Todo verificado con `npm run build` + `npm test` (13 tests) después de cada bloque de cambios, y una prueba en browser real (vía `vite preview`) para el bloque que toca el flujo de auth en vivo.

### 1. Esqueleto de Fase 3 (Stripe) — inerte a propósito

**Archivos nuevos:**
- `supabase/migrations/0004_plan_columns.sql` — columnas `plan` (default `'free'`, con check constraint `free`/`premium`) y `paid_until` en `user_profiles`. Segura de aplicar ya: no cambia el comportamiento de nadie.
- `supabase/functions/stripe-webhook/index.ts` — webhook completo y funcional en su estructura (no comentado como bloque, a diferencia del gate — ver más abajo por qué la distinción): verifica la firma de Stripe con `constructEventAsync` + `SubtleCryptoProvider` (Deno no soporta la verificación síncrona que usa Node crypto), y maneja `checkout.session.completed`, `customer.subscription.deleted` e `invoice.payment_failed`. Usa la service role key porque el webhook lo llama Stripe, no un usuario con JWT.
- Ambos proxies (`anthropic-proxy`, `gemini-proxy`) tienen ahora un bloque de premium gate **comentado**, insertado justo después de la verificación de JWT.

**Decisión de diseño — por qué el webhook está activo pero el gate está comentado:** son dos cosas distintas. El webhook no lo llama nadie hasta que Stripe esté configurado y registrado, así que dejarlo con código real y funcional no tiene riesgo — es un endpoint inerte hasta que Stripe le mande tráfico. El gate de premium, en cambio, vive en un endpoint que la app usa **ahora mismo** (`gemini-proxy` es el que sirve el análisis de IA gratuito hoy) — si lo hubiera dejado activo, aunque el código fuera perfecto, bloquearía a todos los usuarios porque nadie tiene `plan = 'premium'` todavía (el default es `'free'` para todos). Por eso ese bloque específico está comentado con `// TODO: conectar cuando se configure Stripe`, igual que las secciones de Stripe en los documentos legales.

**Tensión que dejé señalada en un comentario, sin resolver yo:** el gate tal como está escrito bloquea el endpoint COMPLETO detrás de premium. Pero `DIAGNOSTICO_Y_PLAN.md` describe el plan free como "análisis, Q&A limitado" — no vacío. Gatear todo `gemini-proxy` contradice ese plan de producto. Lo dejé andando como lo pediste (comentado, listo para descomentar), pero con una nota explícita en el código de que conviene decidir un gate más granular (por ejemplo, límite de uso distinto por plan en vez de bloqueo total) antes de activarlo en serio — no tomé esa decisión de producto por vos.

**Gap que dejé documentado, no resuelto:** el webhook necesita saber a qué usuario de Supabase corresponde cada evento de Stripe. Para `checkout.session.completed` asumí que el Checkout Session se crea con `client_reference_id = <supabase_user_id>` — eso es estándar de Stripe, pero el código que crea esa sesión (la "UI de upgrade/paywall", tarea 3.6 del roadmap) no existe todavía, así que hoy esto es un contrato documentado, no algo probado. Para `customer.subscription.deleted` asumí un `metadata.supabase_user_id` en la suscripción; dejé una nota sugiriendo que agregar una columna `stripe_customer_id` a `user_profiles` sería más robusto a futuro — no la agregué porque me pediste específicamente solo `plan` y `paid_until` en la migración 0004, y expandir el schema de pagos es una decisión que preferí dejarte a vos en vez de tomarla en silencio.

### 2. UI de consentimiento para datos de IA

**Archivos nuevos:**
- `supabase/migrations/0005_ai_consent.sql` — columnas `ai_data_consent` (boolean, default `false`) y `ai_data_consent_at` (timestamptz) en `user_profiles`.
- `assets/js/modules/ConsentManager.js` — clase que chequea si el usuario ya respondió (`ai_data_consent_at IS NULL` = nunca se le preguntó) y, si no, muestra un modal. Instancia única exportada (`consentManager`).

**Archivos modificados:**
- `assets/js/modules/SupabaseDataManager.js` — dos funciones nuevas: `getMyProfile()` (lee `plan`, `paid_until`, `ai_data_consent`, `ai_data_consent_at` del usuario logueado) y `setAiDataConsent(consent)` (graba la respuesta con timestamp).
- `assets/js/modules/auth-ui.js` — una línea agregada al final de `renderLoggedIn()`: `consentManager.checkAndPrompt()`. Ese es el único punto de integración necesario porque `renderLoggedIn()` ya se llama desde los 4 lugares donde la app sabe que hay una sesión activa (login, registro, restauración de sesión al cargar la página, y el evento `USER_UPDATED` de Supabase) — no hizo falta duplicar la llamada en cada uno.

**Decisión de diseño — "primera vez que inicia sesión" interpretado como "primera vez sin responder", no "el primer login histórico":** el pedido decía que el modal debía aparecer "la primera vez que el usuario inicia sesión". Lo interpreté como: se pregunta la primera vez que hay una sesión activa Y el usuario todavía no respondió (`ai_data_consent_at` sigue en `null`) — no como "solo en el primer login después de crear la cuenta". La diferencia importa para los usuarios que ya tenían cuenta antes de que este consentimiento existiera: con la interpretación literal ("primer login") nunca se les preguntaría nada, porque su "primer login" ya pasó. Con la interpretación que usé, se les pregunta la primera vez que inician sesión después de este cambio, que es lo que tiene sentido de producto. `checkAndPrompt()` es un no-op si ya se preguntó en esta carga de página o si el usuario ya respondió antes (sea que sí o que no).

**Decisión de diseño — sin botón de cerrar en el modal:** el modal tiene dos botones ("Sí, quiero ayudar" / "No, gracias") y ningún ícono de cerrar ni cierre con Escape. Es intencional: el consentimiento tiene que ser una elección activa, no algo que se descarta sin responder — si se pudiera cerrar sin elegir, el modal volvería a aparecer en cada sesión hasta el infinito. "No, gracias" es una opción tan fácil y visible como "Sí", así que no es un patrón oscuro, es el mismo criterio que un banner de cookies con Aceptar/Rechazar al mismo nivel visual.

**Cómo se ve:** reusa las clases CSS `auth-overlay`/`auth-modal` que ya existen en `styles.css` (las mismas del modal de login/registro y del de configurar pregunta de seguridad) — no agregué CSS nuevo, para mantener consistencia visual sin duplicar estilos.

**Verificación:** build + tests pasando, y una prueba en browser real vía `vite preview` — confirmé que la app sigue arrancando sin errores nuevos en consola con el nuevo módulo importado, y que el HTML/JS del modal de consentimiento llegó completo al bundle final (`grep` sobre el archivo de salida). No pude probar el flujo completo con una sesión real (login → aparece el modal → elegís → se graba en `user_profiles`) porque la sandbox no tiene credenciales de un usuario real contra Supabase — falta que lo prueben con una cuenta real.

### 3. Prompts de IA mejorados

Antes de tocar nada, verifiqué dónde vive realmente cada prompt: **los proxies (`anthropic-proxy`, `gemini-proxy`) son puramente de transporte — reciben `prompt`/`payload` ya armado del cliente, no tienen ningún texto de prompt propio.** Todo el prompt engineering está en `assets/js/modules/AIAnalysisEngine.js`, en `buildAnalysisPrompt()` y `buildQuestionPrompt()`. Ahí fue el único lugar que modifiqué para esta tarea.

Cambios:
- **Guía específica por estilo** (`AIAnalysisEngine.STYLE_GUIDANCE`, un diccionario nuevo): son cubano, bebop, hard bop, latin jazz, jazz colombiano, bolero y blues — exactamente los 7 valores que ya usa el selector de estilo de licks en la UI (los verifiqué contra `index.html` antes de escribirlos, no los inventé). Cada uno describe qué escuchar concretamente en ese estilo (por ejemplo, en bebop: escalas bebop con nota cromática de paso, encierres cromáticos, progresiones ii-V-I; en jazz colombiano: coherencia entre fraseo jazzístico y células rítmicas de bambuco/currulao). Se inyecta en el prompt cuando `metadata.style` coincide con uno de esos valores, y el prompt le indica al modelo priorizar esa guía por sobre las reglas genéricas de tempo.
- **Jazz colombiano específicamente reforzado**, con una nota explícita en la persona del modelo ("un área donde hay muy poco material pedagógico disponible") — era el estilo con menos cobertura en la versión anterior del prompt (no tenía guía propia, solo aparecía nombrado de pasada).
- **Referentes ampliados**: se agregaron Bud Powell, Thelonious Monk, Michel Camilo, Edy Martínez, Antonio Arnedo (antes solo aparecían en `buildAnalysisPrompt`, faltaban en `buildQuestionPrompt`, ahora están en los dos).
- **Instrucciones de formato más estrictas**: se agregó una advertencia explícita de no envolver la respuesta en \`\`\`json ni agregar texto antes/después — es un fallo común de Gemini (respeta el "responde solo JSON" la mayoría de las veces, pero a veces igual agrega el bloque de código) que el prompt anterior no cubría.
- **`buildQuestionPrompt` reforzado** para que identifique el estilo antes de responder sobre ritmo/groove, y para que pida aclaración en vez de dar un consejo genérico cuando no hay contexto suficiente — antes lo mencionaba de forma más débil ("si no tienes contexto, pide que aclare").

**No se tocó el fallback local** (`getFallbackAnalysis`/`getFallbackAnswer`, las respuestas que se muestran si la IA falla o no hay key configurada) — son texto estático, no prompts, quedan igual que antes.

**Hallazgo aparte, corregido de paso:** al revisar `tests/sanitizers.test.js` para verificar que todo seguía consistente, encontré que el proyecto tiene **dos copias de `sanitizers.js`** — una en `utils/sanitizers.js` (raíz) y otra en `assets/js/utils/sanitizers.js`. Confirmé que absolutamente todo el código de la app (incluido el split de Fase 2) importa la copia de `assets/js/utils/`, y que la copia de la raíz no la referencia nada — es código huérfano, probablemente un resto de una reorganización de carpetas anterior a esta sesión. Mi test la estaba importando por error (copié mal la ruta relativa al escribirlo en la ronda de Fase 2). Lo corregí para que apunte a la copia real que usa la app — sin este ajuste, el test pasaba igual pero no estaba validando el código que la app usa de verdad. **No borré `utils/sanitizers.js`** (no lo creé yo esta sesión, y no era parte de lo pedido) — queda como una pequeña limpieza pendiente para vos.

### 4. README técnico completo

Reescribí `README.md` de punta a punta. El anterior era más una landing page de producto (lista de features con emojis, estilos musicales con artistas, instrucciones de instalación genéricas, un bloque de SQL de Supabase pegado inline). El nuevo está enfocado en documentación técnica para alguien que va a tocar el código:

- Índice, stack, estructura de carpetas completa con qué hace cada archivo.
- Explicación del patrón mixin del split de Fase 2 (por qué mixin y no 5 clases separadas).
- Cómo correr en local, con la advertencia de CSP/HMR que ya habíamos detectado en Fase 2.
- Tabla de variables de entorno (cliente vía Vite + secrets de servidor en Supabase), separando claramente qué es secreto y qué no.
- Cómo correr los tests y qué cubre cada archivo.
- Deploy (resumen, remite a `RUNBOOK_DEPLOY.md` para el detalle).
- **Diagrama de flujo de la IA** en Mermaid (se renderiza nativo en GitHub): browser → `AIAnalysisEngine.js` → `gemini-proxy` (JWT → rate limit → gate de premium comentado) → API de Gemini, con la rama de fallback local si algo falla.
- Sección de base de datos que remite a `supabase/migrations/` en vez de duplicar SQL inline (evita que se desincronicen dos copias del mismo schema, que es exactamente el problema que encontré con `favorite_songs` en la Fase 1).
- Resumen de estado de seguridad y roadmap de Fase 3, con links a todos los documentos relacionados.

**Contenido que se perdió a propósito respecto al README anterior** (marcado acá para que decidas si querés recuperarlo en otro lado): la lista exhaustiva de artistas por estilo (9 categorías × 3 artistas cada una), la sección de compatibilidad de navegadores/OS, los atajos de teclado, y la sección de solución de problemas para el usuario final (micrófono no detectado, etc.). Son todos de cara al usuario final, no al desarrollador — como el pedido era específicamente "README técnico", los saqué de acá, pero si los querés en algún lado (un README de usuario aparte, o contenido in-app), no quedaron guardados en ningún otro archivo — están solo en el `README.md` anterior, que ahora quedó sobreescrito (recuperable del historial de git si hace falta, ya que no se commiteó ningún cambio todavía).

**También corregido de paso:** el README anterior decía "Licencia MIT — ver LICENSE", pero no existe ningún archivo `LICENSE` en el repo — era un link roto preexistente. No inventé un archivo de licencia (esa es una decisión de producto/legal, no algo para asumir); dejé una nota explícita en la sección de Licencia señalando que falta decidir esto.

### Qué falta de tu lado — esta ronda

1. Probar el flujo completo de consentimiento de IA con una sesión real (login → aparece el modal → elegís una opción → se graba correctamente en `user_profiles.ai_data_consent`).
2. Decidir la granularidad del gate de premium antes de descomentarlo (bloqueo total del endpoint vs. límite de uso distinto por plan) — ver la nota de tensión con el plan free documentada en el código.
3. Cuando construyas el flujo de Checkout Session de Stripe (tarea 3.6, no incluida en esta sesión): asegurate de pasar `client_reference_id` con el id de usuario de Supabase — el webhook depende de eso.
4. Evaluar si conviene agregar `stripe_customer_id` a `user_profiles` en una migración futura, para no depender de `metadata` en los eventos de suscripción.
5. Limpiar `utils/sanitizers.js` (raíz) — código huérfano que nada usa, se puede borrar con confianza (o preguntarme para que lo mueva a `_pendiente_revision/` si preferís no borrarlo directo).
6. Decidir si el contenido de cara al usuario que saqué del README anterior (artistas por estilo, atajos, troubleshooting) va a algún lado — no se preservó en ningún archivo nuevo.
7. Decidir la licencia del proyecto (o confirmar que no querés una) y agregar el archivo `LICENSE` si corresponde.

---

## Orden sugerido para los commits cuando vuelvas

Se puede hacer en 3 commits lógicos, o uno solo si preferís simplicidad:

1. **`fix(security): eliminar API key del cliente y usar proxy server-side para IA`**
   `app.js`, `index.html`, `assets/js/modules/AIAnalysisEngine.js`
   (tareas 0.4, 0.6, 0.11 — están todas acopladas porque tocan el mismo flujo)

2. **`fix(security): proxies de IA exigen JWT, rate-limit y leen la key del entorno`**
   `supabase/functions/anthropic-proxy/index.ts`, `supabase/functions/gemini-proxy/index.ts`
   (tareas 0.2, 0.3, 0.5, 0.7)

3. **`fix(security): PBKDF2 (100k iteraciones) para hash de respuesta de seguridad`**
   `assets/js/modules/AuthManager.js`
   (tarea 0.8 — separado porque tiene la implicación de romper hashes viejos, conviene que quede visible como commit propio)

La tarea 0.9 (auditoría de innerHTML) no generó cambios de código, así que no necesita commit — se puede mencionar en la descripción del PR/commit si querés dejar constancia de que se revisó.

Para la Fase 1, sugiero 3 commits adicionales:

4. **`chore(backup): scripts de backup semanal de DB y mensual de storage`**
   `scripts/backup/backup_db_weekly.ps1`, `scripts/backup/backup_storage_monthly.ps1`, `scripts/backup/README.md`, `.gitignore`
   (tareas 1.3, 1.5)

5. **`chore(git): script de mirror a GitLab`**
   `scripts/git/mirror_to_gitlab.sh`
   (tarea 1.2)

6. **`docs(supabase): versionar RLS/RPC como migraciones y agregar runbook de disaster recovery`**
   `supabase/migrations/*`, `RUNBOOK_DISASTER_RECOVERY.md`
   (tareas 1.6, 1.7 — van juntos porque el runbook referencia las migraciones)

Si preferís simplicidad, todo el bloque de Fase 1 también puede ir en un solo commit `chore(backup): setup de Fase 1 — mirror, scripts de backup y runbook de DR`.

Para la Fase 2, el orden importa más porque hay una dependencia real entre commits (el split de `app.js` solo tiene sentido si Vite ya sabe resolver los módulos, y los tests del rate limiter requieren que exista el módulo compartido). Sugiero:

7. **`build: setup de Vite (bundler, build config, env vars)`**
   `package.json`, `package-lock.json`, `vite.config.js`, `.env.development`, `.env.production`, `.gitignore` (los agregados de esta fase), `assets/js/modules/supabase-client.js`
   (tareas 2.1, 2.3 — van juntos porque el config de env vars no tiene efecto sin Vite corriendo)

8. **`refactor: dividir app.js monolítico en módulos por dominio`**
   `assets/js/app/*`, `index.html` (el cambio del script de entrada), `_pendiente_revision/*`
   (tarea 2.2 — separado porque es el cambio de mayor riesgo/revisión de toda la sesión, conviene que quede aislado y sea fácil de revertir solo)

9. **`test: extraer rate limiter a módulo compartido y agregar tests con Vitest`**
   `supabase/functions/_shared/rateLimiter.ts`, `supabase/functions/anthropic-proxy/index.ts`, `supabase/functions/gemini-proxy/index.ts`, `tests/*`
   (tarea 2.5 — agrupa la extracción del rate limiter con sus tests porque son el mismo cambio lógico)

10. **`ci: agregar GitHub Actions (build + test) y runbook de deploy`**
    `.github/workflows/ci.yml`, `RUNBOOK_DEPLOY.md`
    (tareas 2.6, 2.7)

No recomiendo aplastar la Fase 2 en un solo commit como sugerí para Fase 1 — acá el split de `app.js` (commit 8) es lo bastante grande y riesgoso como para que quede separable si hay que revertirlo sin tocar el resto.

11. **`docs(legal): borrador de Términos de Servicio y Política de Privacidad`**
    `legal/terminos-de-servicio.md`, `legal/politica-de-privacidad.md`
    Separado de todo lo demás porque no es código ni infraestructura — conviene que en el mensaje del PR quede claro que es un **borrador sin revisión legal**, con placeholders sin completar, para que nadie lo confunda con una versión lista para publicar solo por estar en el repo.

12. **`feat(payments): esqueleto de Fase 3 — columnas de plan y webhook de Stripe (inerte)`**
    `supabase/migrations/0004_plan_columns.sql`, `supabase/functions/stripe-webhook/`, el bloque de gate comentado en `supabase/functions/anthropic-proxy/index.ts` y `supabase/functions/gemini-proxy/index.ts`
    Conviene que el mensaje del commit deje explícito que el gate de premium está comentado a propósito y por qué (activarlo hoy bloquea a todos los usuarios).

13. **`feat(privacy): consentimiento explícito para uso de datos musicales en IA`**
    `supabase/migrations/0005_ai_consent.sql`, `assets/js/modules/ConsentManager.js`, los cambios en `assets/js/modules/SupabaseDataManager.js` y `assets/js/modules/auth-ui.js`
    Separado del commit de Stripe aunque ambos tocan `user_profiles` — son features independientes, conviene poder revertir una sin la otra.

14. **`fix(ai): mejorar prompts de análisis musical y corregir import de test`**
    `assets/js/modules/AIAnalysisEngine.js`, `tests/sanitizers.test.js`
    El fix del import va en el mismo commit porque lo encontré revisando consistencia mientras tocaba esta zona — no ameritaba un commit aparte.

15. **`docs: reescribir README.md como documentación técnica`**
    `README.md`
    Solo, para que el mensaje del commit pueda explicar qué contenido de cara al usuario se sacó (ver la sección de arriba) sin mezclarlo con cambios de código.
