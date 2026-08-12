# Runbook de Deploy — PianoStudy

Creado 2026-08-09 como parte de la Fase 2 (tarea 2.7) de `DIAGNOSTICO_Y_PLAN.md` (sibling).
Cubre el deploy **manual** del frontend (build de Vite) mientras no exista un
pipeline de CD real. `.github/workflows/ci.yml` (tarea 2.6) valida build+tests
en cada PR, pero **no despliega nada** — el deploy sigue siendo un paso manual
hasta que se decida automatizarlo (Fase 2 futura, fuera del alcance de esta sesión).

Esto es solo para el **frontend estático** (`index.html`, `app.js` dividido,
`styles.css`, etc.). Las **Supabase Edge Functions** (`groq-proxy`,
`gemini-proxy`, `anthropic-proxy`) se despliegan por separado, ver sección 4.

---

## 1. Antes de cada deploy — checklist

- [ ] `git status` limpio, todo lo que vas a deployar está commiteado.
- [ ] `npm ci` sin errores (dependencias instaladas desde el lockfile, no desde `npm install`).
- [ ] `npm test` — los tests de Vitest pasan.
- [ ] `npm run build` — el build de Vite termina sin errores.
- [ ] Si tocaste algo de Fase 0 (proxies, `AIAnalysisEngine.js`, etc.): confirmá
      que al menos uno de `GROQ_API_KEY` o `GEMINI_API_KEY` esté cargado en
      Supabase Secrets — si no, la IA cae al fallback local en producción
      aunque el build sea exitoso. Con Groq sola alcanza (es el primario);
      Gemini es el respaldo automático.
- [ ] Revisá `dist/index.html` generado: confirmá que los `<script>` de CDN
      (Supabase JS, essentia.js, basic-pitch, YouTube API) siguen ahí sin tocar
      y que el bundle propio (`assets-build/index-*.js`) aparece con hash.

## 2. Build local

```bash
npm ci
npm test
npm run build
```

Esto genera `dist/` con:
- `index.html` (con los `<script>`/`<link>` propios reescritos a rutas hasheadas
  bajo `assets-build/`, y los `<script src="https://...">` de CDN intactos).
- `assets-build/index-<hash>.js` — todo el JS propio bundleado y minificado.
- `assets-build/index-<hash>.css` — `styles.css` bundleado y minificado.

El hash en el nombre de archivo es el cache-busting automático: cada build con
contenido distinto genera un nombre distinto, así que no hace falta invalidar
caché de CDN a mano.

Probá el resultado localmente antes de subirlo:

```bash
npm run preview
```

Abre en `http://localhost:4173` — es el build de producción real, no el dev
server, así que es la forma más fiel de probar antes de deployar.

## 3. Deploy del frontend — opciones

El proyecto es compatible con cualquier hosting estático (ver `README.md`).
Pasos concretos para las tres opciones que ya menciona el README:

### Opción A — Netlify

1. Si es la primera vez: conectar el repo de GitHub en el dashboard de Netlify.
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Netlify corre el build en cada push a `main` automáticamente una vez
   configurado — esto es lo más cercano a CD real sin escribir un workflow de
   deploy propio. Si preferís deploy manual: `netlify deploy --prod --dir=dist`
   (requiere `netlify-cli` instalado y autenticado).

### Opción B — Vercel

1. Conectar el repo en el dashboard de Vercel (primera vez).
2. Framework preset: "Vite" (Vercel lo detecta automáticamente).
3. Build command: `npm run build` / Output directory: `dist`.
4. Deploy manual alternativo: `vercel --prod` (requiere `vercel-cli` autenticado).

### Opción C — GitHub Pages

Requiere un ajuste que las otras dos opciones no necesitan: GitHub Pages sirve
el sitio bajo `https://usuario.github.io/nombre-repo/`, un subpath, no la raíz
del dominio. Vite necesita saberlo:

1. En `vite.config.js`, agregar `base: '/nombre-repo/'` (reemplazando por el
   nombre real del repo). **No está seteado hoy** — el config actual asume
   deploy en la raíz del dominio (Netlify/Vercel), no en un subpath.
2. Build: `npm run build`.
3. Publicar el contenido de `dist/` en la rama `gh-pages` (manual, o con la
   action oficial `actions/deploy-pages` si se quiere automatizar más adelante).
4. Activar GitHub Pages en Settings → Pages, apuntando a esa rama.

**Recomendación:** si no hay una razón específica para usar GitHub Pages,
Netlify o Vercel son más simples acá porque no requieren tocar `base` ni
gestionar una rama de publicación aparte.

## 4. Deploy de las Supabase Edge Functions (separado del frontend)

El build/deploy del frontend **no** toca las edge functions. Esas se despliegan
con el CLI de Supabase, y solo hace falta repetirlo cuando cambia el código de
`supabase/functions/`:

```bash
npx supabase functions deploy groq-proxy
npx supabase functions deploy gemini-proxy
npx supabase functions deploy anthropic-proxy
npx supabase functions deploy delete-account
```

`delete-account` es la función que Ajustes → "Eliminar mi cuenta" invoca del
lado del cliente. Requiere `SUPABASE_SERVICE_ROLE_KEY` cargada como secret para
poder cerrar la sesión global del usuario (`auth.admin.signOut`) además de
marcar `deleted_at`/`deletion_scheduled_for` en `user_profiles`. Sin service
role la marca en DB igual se hace, pero la sesión no se invalida server-side —
el cliente hace su `signOut` local igual, así que en la práctica el impacto es
mínimo.

Requiere estar autenticado (`npx supabase login`) y con el proyecto linkeado
(`npx supabase link --project-ref <ref>`). Antes del primer deploy de las
funciones de IA, confirmá que al menos `GROQ_API_KEY` esté cargada como secret
(y opcionalmente `GEMINI_API_KEY` como respaldo). Si ninguna está cargada, las
funciones responden `500` en cuanto reciban tráfico real — el cliente lo
detecta y cae al fallback local.

### Cargar los secrets

Dos formas equivalentes:

**A. Por el Dashboard (recomendado la primera vez):**
Supabase Dashboard → tu proyecto → **Project Settings → Edge Functions →
Manage Secrets → Add new secret** → nombre `GROQ_API_KEY`, valor la key.
Repetir para `GEMINI_API_KEY` si querés el respaldo.

**B. Por CLI:**
```bash
npx supabase secrets set GROQ_API_KEY=gsk_xxxxx
npx supabase secrets set GEMINI_API_KEY=AIzaxxxxx
```

Los secrets están disponibles para las funciones inmediatamente después de
cargarlos — no hace falta re-deployar la función.

## 5. Rollback

Si un deploy del frontend rompe algo:

- **Netlify/Vercel:** ambos guardan un historial de deploys — desde el
  dashboard, "Rollback" al deploy anterior es un click, no requiere volver a
  buildear.
- **GitHub Pages:** revertir el commit en la rama `gh-pages` (o re-publicar el
  `dist/` de un build anterior si lo guardaste).
- **Edge Functions:** no hay rollback con un click vía CLI — hay que volver a
  desplegar la versión anterior del código (`git checkout <commit-anterior> --
  supabase/functions/` y volver a correr `supabase functions deploy`).

## 6. Ajustes de Auth (recuperación de contraseña por link)

La sección Ajustes de la app permite cambio de contraseña, cambio de email,
descarga de datos personales (RGPD) y eliminación de cuenta (soft-delete a 30
días). La recuperación de contraseña olvidada usa el flujo nativo de Supabase
(`resetPasswordForEmail`) — reemplazó al flujo de pregunta de seguridad, que
además de ser un antipatrón estaba roto para usuarios sin sesión cacheada.

Antes del primer deploy con este código, en el proyecto Supabase:

1. **Authentication → URL Configuration → Redirect URLs**: agregar los orígenes
   permitidos donde debe aterrizar el link del mail. En producción, tu URL de
   producción con `/#recovery` (por ejemplo `https://pianostudy.app/#recovery`).
   Para desarrollo local, `http://localhost:5173/#recovery` y
   `http://localhost:4173/#recovery` (preview de Vite).

2. **Authentication → Email Templates → Reset Password**: verificar que el link
   del template usa `{{ .ConfirmationURL }}` (que ya toma el `redirectTo` que
   pasa el cliente). No hace falta customizar el HTML.

3. Aplicar las migraciones nuevas en orden con `npx supabase db push`:
   `0006_soft_delete_accounts.sql`, `0007_default_style.sql`,
   `0008_drop_security_question.sql`.

### TODO — purga real de cuentas soft-deleted

Falta un cron (fuera del alcance de este PR) que corra a diario y borre las
cuentas cuya fecha `deletion_scheduled_for` ya pasó. Cualquiera de estas dos
opciones sirve:

- **Supabase Scheduled Function** (pg_cron sobre Postgres) — la más simple:
  ```sql
  select cron.schedule(
    'purge-deleted-accounts',
    '0 3 * * *',   -- 03:00 UTC cada día
    $$
      delete from auth.users
      where id in (
        select id from user_profiles
        where deleted_at is not null
          and deletion_scheduled_for < now()
      );
    $$
  );
  ```
  Aprovecha `on delete cascade` en las FKs de `licks`/`recordings`/etc. para
  arrastrar todo. **Antes de habilitarlo**, verificar en las migraciones que
  todas las tablas dependientes efectivamente tengan `references auth.users(id)
  on delete cascade` — `0001_initial_schema.sql` lo pone en `user_profiles` y
  `practice_sessions` pero las tablas con `user_id text` (licks, recordings,
  custom_artists) no lo heredan y hay que borrarlas explícitamente.

- **GitHub Action programada** — más flexible si se quiere logging o
  notificaciones. Requiere guardar la service role key como secret de Actions.

### TODO opcional — purgar los hash de pregunta de seguridad viejos

La columna `security_question` de `user_profiles` cayó con la migración
`0008_drop_security_question.sql`, pero los campos `securityQuestion`,
`answerHash` y `answerSalt` que había en `auth.users.raw_user_meta_data` siguen
ahí como metadata huérfana inofensiva. Si querés limpiarlos, un script one-shot
con service role key:

```bash
# Deno
deno run --allow-env --allow-net scripts/purge-sq-metadata.ts
```

donde el script itera `supabase.auth.admin.listUsers()` y hace
`supabase.auth.admin.updateUserById(id, { user_metadata: { securityQuestion: null,
answerHash: null, answerSalt: null } })`. No es urgente.

## 7. Qué falta para que esto sea CI/CD real

Pendiente, fuera del alcance de esta sesión:

- Automatizar el deploy del frontend en el propio workflow de GitHub Actions
  (`.github/workflows/ci.yml` hoy solo valida, no publica) — agregar un job
  que dispare Netlify/Vercel deploy hooks, o `actions/deploy-pages` si se
  elige GitHub Pages.
- Automatizar `supabase functions deploy` en CI cuando cambie
  `supabase/functions/**` (requiere guardar un token de Supabase como secret
  de GitHub Actions).
- Ambiente de staging separado (hoy dev y prod apuntan al mismo proyecto
  Supabase — ver nota en `.env.development`).
