# Runbook de Deploy — PianoStudy

Creado 2026-08-09 como parte de la Fase 2 (tarea 2.7) de `DIAGNOSTICO_Y_PLAN.md`.
Cubre el deploy **manual** del frontend (build de Vite) mientras no exista un
pipeline de CD real. `.github/workflows/ci.yml` (tarea 2.6) valida build+tests
en cada PR, pero **no despliega nada** — el deploy sigue siendo un paso manual
hasta que se decida automatizarlo (Fase 2 futura, fuera del alcance de esta sesión).

Esto es solo para el **frontend estático** (`index.html`, `app.js` dividido,
`styles.css`, etc.). Las **Supabase Edge Functions** (`anthropic-proxy`,
`gemini-proxy`) se despliegan por separado, ver sección 4.

---

## 1. Antes de cada deploy — checklist

- [ ] `git status` limpio, todo lo que vas a deployar está commiteado.
- [ ] `npm ci` sin errores (dependencias instaladas desde el lockfile, no desde `npm install`).
- [ ] `npm test` — los tests de Vitest pasan.
- [ ] `npm run build` — el build de Vite termina sin errores.
- [ ] Si tocaste algo de Fase 0 (proxies, `AIAnalysisEngine.js`, etc.): confirmá
      que `ANTHROPIC_API_KEY` y `GEMINI_API_KEY` estén cargadas en Supabase
      Secrets (paso 0.1, pendiente del usuario) — si no, la IA va a fallar en
      producción aunque el build sea exitoso.
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

El build/deploy del frontend **no** toca `anthropic-proxy` ni `gemini-proxy`.
Esas se despliegan con el CLI de Supabase, y solo hace falta repetirlo cuando
cambia el código de `supabase/functions/`:

```bash
npx supabase functions deploy anthropic-proxy
npx supabase functions deploy gemini-proxy
```

Requiere estar autenticado (`npx supabase login`) y con el proyecto linkeado
(`npx supabase link --project-ref <ref>`). Antes del primer deploy de estas
dos funciones con el código de Fase 0, confirmá que los secrets
`ANTHROPIC_API_KEY` y `GEMINI_API_KEY` ya estén cargados (paso 0.1) — si no,
las funciones responden `500` en cuanto reciban tráfico real.

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

## 6. Qué falta para que esto sea CI/CD real

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
