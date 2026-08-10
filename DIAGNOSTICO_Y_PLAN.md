# PianoStudy — Diagnóstico completo y plan de acción

Fecha: 2026-08-08
Autor del diagnóstico: revisión externa
Estado: material de trabajo, no ejecutado

Este documento consolida el diagnóstico de arquitectura, seguridad, funcionalidad, backup y el plan para integrar NeuralJam Mirror como sección premium.

---

## Tabla de contenidos

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Problemas de seguridad críticos](#2-problemas-de-seguridad-críticos)
3. [Arquitectura — fortalezas y debilidades](#3-arquitectura--fortalezas-y-debilidades)
4. [Funcionalidad — qué funciona bien y qué no](#4-funcionalidad--qué-funciona-bien-y-qué-no)
5. [Backup y disaster recovery](#5-backup-y-disaster-recovery)
6. [Plan de integración de NeuralJam Mirror como premium](#6-plan-de-integración-de-neuraljam-mirror-como-premium)
7. [Roadmap consolidado por fases](#7-roadmap-consolidado-por-fases)
8. [Checklist de acciones concretas](#8-checklist-de-acciones-concretas)
9. [Modo remoto — trabajo autónomo desde el celular](#9-modo-remoto--trabajo-autónomo-desde-el-celular)
10. [Referencias externas](#10-referencias-externas)

---

## 1. Resumen ejecutivo

**PianoStudy es un producto real, no un prototipo.** Está más maduro que muchas apps musicales en producción. Tiene features únicos (Essentia.js para MIR, basic-pitch de Spotify para audio-to-MIDI, prompts LLM especializados en jazz y música afrocubana).

**Está en un punto crítico:** suficientemente maduro para tener usuarios reales, pero con debilidades de seguridad que pueden volverse caras si se escala sin arreglarlas.

**El plan del usuario** de integrar NeuralJam Mirror como sección premium encaja perfectamente con la infraestructura actual: auth, DB, storage, LLM proxies, análisis de audio — todo ya existe. Estimación de integración: **15-25h** una vez arreglada la seguridad.

**No agregar features nuevas hasta cerrar la Fase 0 de seguridad.**

---

## 2. Problemas de seguridad críticos

### 2.1 API keys de Anthropic y Gemini viajan desde el cliente — 🔴 CRÍTICO

**Evidencia en el código:**

- `AIAnalysisEngine.js:2-7` — el constructor recibe `apiKey` como parámetro y lo mete en la URL de Gemini directamente
- `app.js:912-913` — la key se lee de `localStorage.getItem('pianostudy-ai-api-key')`
- `supabase/functions/anthropic-proxy/index.ts:25` — el proxy recibe `{ apiKey, payload }` del cliente
- `supabase/functions/gemini-proxy/index.ts:28` — el proxy recibe `{ apiKey, prompt, systemPrompt }` del cliente

**Consecuencias reales:**

1. Cualquier usuario abre DevTools → ve la key en localStorage → la copia → la usa desde su propia app
2. Un scraper malicioso captura la key en tránsito (HTTPS la cifra, pero el usuario tiene la key en su navegador)
3. Cuando escales, el costo puede explotar por uso no autorizado
4. Anthropic/Google pueden bloquear la key si detectan uso desde múltiples IPs
5. **No podés cobrar por premium con este problema abierto** — un usuario copia la key y no necesita pagar

**Cómo debería ser:**

- La key vive SOLO en el secret manager de Supabase Edge Functions: `Deno.env.get('GEMINI_API_KEY')`
- El cliente NUNCA la conoce
- El proxy la lee de su propio entorno, no del request
- El cliente autentica con Supabase Auth, el proxy verifica el JWT del usuario antes de responder

**Prioridad:** 🔴 URGENTE — bloquea cualquier plan de premium.

### 2.2 SHA-256 sin PBKDF2/argon2 para respuesta de seguridad — 🟡 MEDIO

**Evidencia:** `AuthManager.js:12-18` usa `crypto.subtle.digest('SHA-256', ...)` con salt.

**Problema:** SHA-256 con salt es rápido (billones de hashes por segundo con GPU). Para respuestas de seguridad (nombres de mascotas, ciudades, etc. — cortas y adivinables) es especialmente vulnerable a brute-force.

**Debería usar:** PBKDF2 con muchas iteraciones (100,000+) desde `crypto.subtle.deriveBits`, o argon2 vía WebAssembly.

**Nota:** las contraseñas de login están OK — las maneja Supabase Auth con bcrypt interno.

**Prioridad:** 🟡 MEDIA — es vector de recovery, no de login primario.

### 2.3 Sin rate limiting en los edge functions — 🟡 MEDIO

**Evidencia:** ni `anthropic-proxy` ni `gemini-proxy` implementan rate limiting.

**Riesgo:** un usuario (malicioso o con bug) puede martillar el endpoint y agotar tu cuota LLM mensual en minutos.

**Cómo mitigar:**
- Agregar límite por user_id (verificado vía JWT)
- Agregar límite por IP para no autenticados
- Usar Supabase Realtime o Redis para contar requests

**Prioridad:** 🟡 MEDIA — no es explotable hoy porque no hay muchos usuarios, pero se vuelve crítico al escalar.

### 2.4 Storage bucket "recordings" con lectura pública — ⚠️ VERIFICAR INTENCIÓN

**Evidencia (README:283-295):**
```sql
CREATE POLICY "lectura publica recordings"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'recordings');
```

**Consecuencia:** cualquier persona con la URL de un audio puede descargarlo. Las URLs son opacas pero pueden filtrarse (compartir link, DevTools, logs).

**Preguntas para el usuario:**
- ¿Los usuarios saben que sus grabaciones son técnicamente accesibles con la URL?
- ¿Es una feature (compartir) o un descuido?

**Cómo debería ser (opción segura):**
```sql
CREATE POLICY "usuarios ven sus recordings"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);
```

Reproducción vía signed URLs con expiración corta (1 hora) generadas por Supabase Storage.

**Prioridad:** ⚠️ VERIFICAR — dependiente de intención del producto.

### 2.5 Auditar uso de `.innerHTML` en `app.js` — 🟡 MEDIO

`app.js` tiene 4,673 líneas. Cualquier uso de `.innerHTML` con contenido que venga del usuario o de la DB (nombres de licks, notas, comentarios) sin pasar por `escapeHtml` del utility es un vector XSS.

**Acción:** grep de `\.innerHTML\s*=` en `app.js` y verificar cada caso.

### 2.6 Cosas de seguridad que SÍ están bien

Para no ser injusto:

- ✅ **CSP definida en HTML** — mitigación XSS explícita
- ✅ **Utility `escapeHtml`** en `utils/sanitizers.js` — bien implementada
- ✅ **RLS mencionado en README** — políticas correctas para tablas principales
- ✅ **RPC segura `get_email_by_username`** — no expone tabla `user_profiles`
- ✅ **Supabase anon key hardcodeada** — normal, es su uso previsto
- ✅ **HTTPS forzado** (implícito por Supabase)
- ✅ **Uso de `crypto.subtle`** — algoritmo débil pero API correcta

---

## 3. Arquitectura — fortalezas y debilidades

### 3.1 Fortalezas

**Elección técnica de audio processing — excelente:**
- **Essentia.js** — biblioteca MIR de Universitat Pompeu Fabra, referencia académica. Analiza tempo, tonalidad, loudness, MFCC, spectral centroid, rhythmic complexity.
- **basic-pitch de Spotify** (`index.html:30`) — estado del arte gratuito para audio-to-MIDI. Ya cargado y disponible.

Esta decisión es SUPERIOR a la mayoría de apps musicales del mercado.

**Prompt engineering de nivel profesional:**
`AIAnalysisEngine.buildAnalysisPrompt()` (líneas 60-100) tiene 40+ líneas con:
- Reglas por rango de tempo
- Interpretación de complejidad dinámica
- Referencias explícitas a Chucho Valdés, Rubalcaba, Bill Evans, Oscar Peterson
- Teoría aplicada por estilo (son cubano, mambo, bebop, blues)

**Modularización correcta:**
Separación clara por responsabilidad — `AuthManager`, `SupabaseDataManager`, `AudioAnalyzer`, `AIAnalysisEngine`, `ArtistsManager`, `YouTubeManager`, `FavoriteSongsManager`, `ProgressTracker`. Import/export ES6, arquitectura de clases.

**UX detalles bien resueltos:**
- Timer mobile con posición fixed
- Meta tags PWA-ready
- Compatibilidad iOS/Android explícita
- CSP como header en HTML

### 3.2 Debilidades

**`app.js` con 4,673 líneas — el problema más grande a mediano plazo:**

Es el mismo síntoma del "archivo dios" que aparece en muchos proyectos. Cuando se acerca a 10,000 líneas (que va camino):
- Editar es lento
- Cada cambio riesga romper otras cosas
- Nuevos features requieren entender todo el archivo
- Testing manual es la única opción viable
- Refactor se vuelve infeasible

**Split urgente sugerido por dominio:**
- `app-ui.js` — DOM manipulation, event handlers
- `app-state.js` — estado global de la app
- `app-controllers.js` — lógica de features
- `app-audio-flow.js` — flujo de grabación/análisis
- `app-init.js` — arranque y wiring

**Sin bundler ni build step:**
- Cada módulo es un HTTP request
- Sin minificación, sin tree-shaking, sin cache-busting automático
- No podés usar TypeScript, SASS, ni features JS transpilables
- **Vite en 15 minutos resuelve esto** — no crítico pero low-hanging fruit

**CDN sin fallback:**
Si `unpkg.com` o `cdn.jsdelivr.net` caen:
- essentia.js no carga → análisis de audio muerto
- basic-pitch no carga → audio-to-MIDI muerto
- Supabase client no carga → toda la app muerta

Deberían estar bundled locales o al menos con fallback.

**Sin tests visibles:**
En una app de ~9,600 líneas sin tests, cada cambio es riesgo. Si tenés usuarios activos, un bug en producción es caro.

**Sin CI/CD ni environment separation visible:**
- No hay `.env.production` vs `.env.development`
- `SUPABASE_URL` hardcodeado
- Sin GitHub Actions o similar
- Deploy manual = riesgo de subir código con bugs

---

## 4. Funcionalidad — qué funciona bien y qué no

### 4.1 Funcionalidad excelente

1. **Análisis armónico y rítmico real** con Essentia — no es "IA hace magia", es MIR con librerías serias
2. **Sistema de auth robusto** con recovery, RLS, RPC seguros
3. **Biblioteca de licks categorizada** por estilo — nicho jazz + latin bien cubierto
4. **YouTube integration** con phrases (basado en `pianostudy-youtube-phrases_*` en localStorage)
5. **Progress tracking** con sesiones de práctica
6. **Storage de grabaciones** vía Supabase
7. **Q&A con Gemini** sobre el análisis (feature no trivial, bien implementado)
8. **Mobile-first UX** con timer flotante y adaptación responsive

### 4.2 Funcionalidad regular / con problemas

1. **Fallback silencioso** cuando falla Gemini (`getFallbackAnalysis`) — puede confundir al usuario ("¿está la IA funcionando o no?")
2. **`console.log`** de respuestas Gemini completas en producción — leak informacional y spam en consola
3. **Sin manejo visible de errores de red** en llamadas LLM — usuario puede quedar viendo spinner infinito
4. **No hay indicador visible** de que la API key está o no configurada para el usuario final
5. **Sin retry en llamadas LLM** — si falla una request, se pierde el análisis

### 4.3 Features únicos que son ventaja competitiva

Comparado con competidores:
- La mayoría de apps de estudio musical NO usan Essentia (usan pitch detection casera)
- La mayoría NO tienen basic-pitch integrado
- La mayoría NO tienen prompts especializados en jazz afrocubano
- La mayoría NO cubren jazz colombiano
- La mayoría de apps de análisis de audio NO ofrecen Q&A con LLM

**PianoStudy tiene combinación única que no está en el mercado.**

---

## 5. Backup y disaster recovery

Esta es un área crítica que hoy está sin cubrir sistemáticamente. Detallo qué existe, qué falta, y qué hay que hacer.

### 5.1 Qué se tiene que backupear

Cuatro categorías de datos:

**A. Código fuente**
- Todo el proyecto (HTML, JS, CSS, edge functions, SQL)
- Historial de git

**B. Base de datos Supabase**
- Tablas: `licks`, `recordings`, `custom_artists`, `user_profiles`, `practice_sessions`
- RLS policies y RPC functions
- Users en `auth.users`

**C. Storage bucket "recordings"**
- Archivos de audio subidos por usuarios (WAV, MP3, WebM)
- Puede llegar a ser el dataset MÁS PESADO del proyecto

**D. Configuración y secrets**
- Variables de entorno de Supabase Edge Functions
- Configuración de proyecto Supabase
- Domain, DNS, SSL certs (si aplica)

### 5.2 Estado actual — qué existe hoy

**A. Código:**
- ✅ Git local
- ✅ Repositorio GitHub `sdionisio4T/pianostudy` (visible en git log con PRs)
- ⚠️ Sin verificación de si el remote está actualizado
- ⚠️ Sin backup offsite adicional

**B. Base de datos:**
- ⚠️ Supabase tier gratis incluye backups diarios pero solo 7 días de retención
- ⚠️ Supabase tier Pro ($25/mes) incluye backups de 14 días + point-in-time recovery
- ❌ NO hay backup manual configurado a otra ubicación

**C. Storage:**
- ❌ NO hay backup del bucket `recordings`
- Si se corrompe o se borra, se pierden todas las grabaciones de usuarios
- Este es el punto MÁS VULNERABLE hoy

**D. Configuración:**
- ❌ NO hay documentación de qué env vars deben existir
- ❌ NO hay export de RLS policies como archivo separado
- El SQL del README es la única "documentación como código"

### 5.3 Plan de backup recomendado

**Nivel 1 — Mínimo para dormir tranquilo (2-4h de setup)**

1. **Git remote verificado:**
   - Verificar que `git push` esté al día
   - Configurar branch protection en main
   - Habilitar GitHub Actions gratis: workflow que hace `git status` y avisa si hay divergencia

2. **Backup semanal de la DB a un ZIP local:**
   ```bash
   # Cron semanal (Windows Task Scheduler o similar)
   npx supabase db dump --db-url "postgresql://..." > backup_$(date +%Y-%m-%d).sql
   ```
   Guardar los últimos 4 backups. Costo: ~1MB/semana inicialmente.

3. **Backup mensual del bucket recordings:**
   ```bash
   # Script Python o Deno que baja todos los objetos
   # usando supabase-py o REST API
   ```
   Guardar en disco externo o cloud storage barato (Backblaze B2 ~$5/mes por TB).

**Nivel 2 — Producción real con usuarios pagos (agregado al nivel 1)**

1. **Upgrade a Supabase Pro** ($25/mes) — obtiene:
   - Point-in-time recovery (hasta 14 días atrás, granularidad de segundos)
   - 100 GB de DB, 200 GB de bandwidth
   - Backup diario retenido 14 días
   - Support directo

2. **Backup automático diario del bucket a Backblaze B2 o Cloudflare R2:**
   - Setup con `rclone` corriendo en cron
   - Costo: $0.005/GB/mes (Backblaze) o $0.015 (R2)
   - Un usuario típico: ~50MB/mes de grabaciones = $0.02 por año

3. **Export de RLS policies y RPC como archivos versionados en git:**
   - `supabase/migrations/*.sql` con estructura estándar
   - Cambios se hacen editando estos archivos, no directo en Supabase
   - Rollback confiable si algo se rompe

4. **Runbook de disaster recovery:**
   - Documento paso a paso: "cómo restaurar todo si Supabase pierde datos"
   - Testear una vez al año (crear proyecto Supabase de prueba y restaurar)

**Nivel 3 — Multi-región / cero downtime (solo si tenés muchos usuarios)**

1. Read replica en otra región
2. CDN para assets estáticos
3. Failover automático

**Este nivel NO aplica hasta tener 500+ usuarios pagos.**

### 5.4 Backup de código adicional recomendado

Además de GitHub:

- **Backup local automático** con Git bundle:
  ```bash
  git bundle create ~/backups/pianostudy_$(date +%Y-%m-%d).bundle --all
  ```
- **Mirror en GitLab o Gitea** (gratis, 5 minutos de setup) — protege contra pérdida de cuenta GitHub

### 5.5 Data export para usuarios (GDPR / buena práctica)

**Feature pendiente:** que un usuario pueda descargar todos sus datos con un click.

- Endpoint que devuelve ZIP con: licks, recordings, sessions, favorites
- Requerido por GDPR en Europa
- Buena práctica global — construye confianza

Estimación: 4-6h de implementación.

### 5.6 Data deletion (right to be forgotten)

Cuando un usuario borra su cuenta:
- ✅ Supabase Auth borra el user (RLS cascade)
- ⚠️ Verificar que los archivos en Storage también se borran (no lo hace automáticamente por default)

Setup: trigger de DB que borra objetos de storage al borrar el user_profile.

---

## 6. Plan de integración de NeuralJam Mirror como premium

### 6.1 Por qué la idea es sólida

1. **Encaje de audiencia:** los usuarios de PianoStudy YA son pianistas jazz/latin — 100% overlap con NeuralJam Mirror
2. **Infraestructura ya existente:** auth, DB, storage, LLM proxies, análisis audio — todo listo
3. **Diferenciador único:** ningún competidor tiene "app de estudio jazz + instrumento generativo integrado"
4. **Modelo de negocio limpio:**
   - **Free:** PianoStudy completo (grabación, licks, análisis, artistas, Q&A limitado)
   - **Premium:** + NeuralJam Mirror + análisis avanzados + más sesiones + prioridad LLM

### 6.2 Ventaja no obvia: basic-pitch ya está cargado

En `index.html:30`:
```html
<script defer src="https://unpkg.com/@spotify/basic-pitch/dist/basic-pitch.js"></script>
```

**basic-pitch de Spotify convierte audio → MIDI directamente en el navegador.** Es el estado del arte gratuito. Esto significa:

- NeuralJam Mirror puede recibir INPUT de audio (micrófono) sin necesidad de MIDI keyboard
- Se puede capturar la performance del usuario mientras usa el analyzer normal
- El motor ESPEJO puede procesar el MIDI generado por basic-pitch
- El playback puede ser via Web Audio API con WebAudioFont o Tone.js + SoundFont

**Es una ventaja técnica que ya estás pagando (carga la librería) pero no aprovechás al máximo aún.**

### 6.3 Arquitectura de la integración

```
PianoStudy (existente)
├── Auth (Supabase Auth) ← YA EXISTE
├── DB con user_profiles.plan (free|premium) ← AGREGAR COLUMNA
├── Storage recordings ← YA EXISTE
├── LLM proxies ← YA EXISTEN (una vez arreglada seguridad)
│   ├── anthropic-proxy
│   └── gemini-proxy
├── AudioAnalyzer.js ← YA EXISTE (Essentia + basic-pitch)
├── AIAnalysisEngine.js ← YA EXISTE
│
└── NUEVO: NeuralJam Mirror
    ├── mirror-engine.js (5+ transformaciones deterministas)
    ├── chord-detector.js (agrupamiento de notas <50ms)
    ├── mirror-ui.js (nueva vista integrada)
    ├── mirror-director.js (usa anthropic-proxy)
    └── mirror-feedback.js (usa AIAnalysisEngine)
```

### 6.4 Estimación de esfuerzo revisada

**Componentes que NO hay que construir (ya existen):**
- Auth
- Storage
- LLM proxies
- Audio recording infrastructure
- basic-pitch integration
- Design system
- User management

**Componentes que sí hay que construir:**

| Componente | Horas |
|---|---|
| `mirror-engine.js` (5 transformaciones + chooser) | 4-6h |
| `chord-detector.js` (agrupar notas <50ms) | 2-3h |
| Integración con basic-pitch para audio input | 2-3h |
| Playback via WebAudioFont | 3-4h |
| Nueva vista UI integrada al look de PianoStudy | 4-6h |
| Director LLM (reutiliza anthropic-proxy) | 2-3h |
| Feedback post-sesión (reutiliza patrón AIAnalysisEngine) | 2-3h |
| Gate de premium (chequear user.plan) | 1-2h |
| Testing en vivo | 3-5h |

**Total: 23-35h** para NeuralJam Mirror completamente integrado como sección premium.

### 6.5 Requisitos previos (obligatorios antes de arrancar Mirror)

**Fase 0 — Seguridad debe estar cerrada:**
1. API keys en secrets, fuera del cliente
2. Rate limiting en proxies
3. Auth check en proxies
4. Auditoría de innerHTML

**Sin la Fase 0, meter premium es imposible porque:**
- Un usuario premium copia la key → premium para siempre gratis
- No podés cobrar por algo cuyo core es accesible

---

## 7. Roadmap consolidado por fases

Orden estricto. No saltar fases.

### FASE 0 — Seguridad (5-10h) 🔴 URGENTE

Bloquea todo lo demás.

- [ ] **0.1** Mover `GEMINI_API_KEY` y `ANTHROPIC_API_KEY` a Supabase Secrets (Deno.env) — **pendiente, lo hace el usuario en el dashboard, bloquea 0.2-0.5**
- [x] **0.2** Refactor de `anthropic-proxy/index.ts` — leer key de env, no del request (código listo 2026-08-09, con TODO — no funciona hasta que se resuelva 0.1)
- [x] **0.3** Refactor de `gemini-proxy/index.ts` — leer key de env, no del request (código listo 2026-08-09, con TODO — no funciona hasta que se resuelva 0.1)
- [x] **0.4** Refactor de `AIAnalysisEngine.js` — no pasar apiKey, llamar al proxy con auth JWT (2026-08-09)
- [x] **0.5** Verificar JWT del usuario en los proxies (`req.headers.get('authorization')`) (2026-08-09)
- [x] **0.6** Borrar `localStorage.getItem('pianostudy-ai-api-key')` de `app.js` (2026-08-09)
- [x] **0.7** Agregar rate limiting básico en los proxies (10 req/min por user_id) (2026-08-09)
- [x] **0.8** Cambiar SHA-256 de recovery por PBKDF2 con 100k iteraciones (2026-08-09 — rompe hashes viejos, ver `RESUMEN_SESION_REMOTA_2026-08-09.md`)
- [x] **0.9** Auditar `.innerHTML` en `app.js` — verificar que todo pase por `escapeHtml` (2026-08-09 — auditado, ya estaba bien saneado, sin cambios de código)
- [ ] **0.10** Verificar / cambiar política de bucket `recordings` a signed URLs — pendiente, decisión de producto
- [x] **0.11** Sacar `console.log` de respuestas LLM en producción (2026-08-09)

### FASE 1 — Backup y disaster recovery (4-6h)

Se puede hacer en paralelo a Fase 0.

- [ ] **1.1** Verificar `git push` al día y branch protection en main — pendiente, requiere acceso a GitHub del usuario
- [x] **1.2** Setup mirror gratis en GitLab o Gitea (2026-08-09 — script `scripts/git/mirror_to_gitlab.sh` listo, falta que el usuario cree el repo en GitLab y lo corra)
- [x] **1.3** Script de backup semanal de DB Supabase (Windows Task Scheduler) (2026-08-09 — `scripts/backup/backup_db_weekly.ps1` + instrucciones en `scripts/backup/README.md`, sin probar contra Supabase real)
- [ ] **1.4** Setup Backblaze B2 o Cloudflare R2 para storage backup — pendiente
- [x] **1.5** Script de backup mensual del bucket `recordings` (2026-08-09 — `scripts/backup/backup_storage_monthly.ps1`, sin probar contra Supabase real)
- [x] **1.6** Exportar RLS policies y RPC como `supabase/migrations/*.sql` (2026-08-09 — ver `supabase/migrations/README.md`, tabla `favorite_songs` inferida y pendiente de verificar)
- [x] **1.7** Escribir `RUNBOOK_DISASTER_RECOVERY.md` (2026-08-09)
- [ ] **1.8** Decidir si upgrade a Supabase Pro ($25/mes) para PITR

### FASE 2 — Arquitectura sostenible (10-20h opcional pero recomendado)

Se puede posponer si urge premium, pero se recomienda antes.

- [x] **2.1** Setup Vite como bundler (2026-08-09 — `vite.config.js`, `package.json`; build y preview verificados en browser real)
- [x] **2.2** Split `app.js` en 5 módulos por dominio (2026-08-09 — `assets/js/app/app-{state,ui,controllers,audio-flow,init}.js`, patrón mixin sobre el prototype; verificado byte-a-byte contra el original y probado en browser real; original movido a `_pendiente_revision/app.js`)
- [x] **2.3** Environment variables separadas dev/prod (2026-08-09 — `.env.development`/`.env.production`, `supabase-client.js` usa `import.meta.env.VITE_*`; dev y prod apuntan hoy al mismo proyecto Supabase, no hay uno separado)
- [ ] **2.4** Bundle local de essentia.js + basic-pitch (fallback CDN) — pendiente, no estaba en el alcance aprobado para esta sesión
- [x] **2.5** Setup básico de tests (Vitest, ~5 tests core) (2026-08-09 — 13 tests en `tests/`: sanitizers, rate limiter extraído, PBKDF2)
- [x] **2.6** GitHub Actions básico (build + test on PR) (2026-08-09 — `.github/workflows/ci.yml`, valida pero no despliega)
- [x] **2.7** Documentar `RUNBOOK_DEPLOY.md` (2026-08-09)

### FASE 3 — Sistema de pagos + premium gate (8-12h)

Requiere Fase 0 y Fase 1 cerradas.

- [ ] **3.1** Setup Stripe (test mode primero)
- [ ] **3.2** Nueva columna `plan` en `user_profiles` (default: 'free')
- [ ] **3.3** Nueva columna `paid_until` en `user_profiles`
- [ ] **3.4** Webhook Stripe → actualiza `user_profiles.plan` y `paid_until`
- [ ] **3.5** Wrapper en anthropic/gemini proxies que chequee plan si el endpoint es premium
- [ ] **3.6** UI de upgrade / paywall
- [ ] **3.7** UI de "Mi cuenta" con estado del plan
- [ ] **3.8** Terms of Service + Privacy Policy publicadas (Stripe lo requiere)
- [ ] **3.9** Testing end-to-end con Stripe test cards
- [ ] **3.10** Migrar a Stripe live cuando todo funcione

### FASE 4 — NeuralJam Mirror como módulo premium (23-35h)

Fase estrella. Requiere las 3 anteriores.

- [ ] **4.1** Escribir `mirror-engine.js` con las 5 transformaciones core (canon, invert, augment, diminish, harmonize)
- [ ] **4.2** Escribir `chord-detector.js` con ventana de 50ms
- [ ] **4.3** Integrar basic-pitch para audio → MIDI en vivo
- [ ] **4.4** Playback con WebAudioFont (piano jazz + rhodes)
- [ ] **4.5** Nueva vista UI con selector de instrumento
- [ ] **4.6** Toggle de modos (canon / mirror inteligente / dirigido por director)
- [ ] **4.7** Director LLM usando anthropic-proxy
- [ ] **4.8** Feedback post-sesión con curación de licks
- [ ] **4.9** Auto-guardar licks curados a la biblioteca de PianoStudy
- [ ] **4.10** Gate de premium
- [ ] **4.11** Analytics de uso (qué transformaciones se usan más)
- [ ] **4.12** Testing con usuarios reales

### FASE 5 — Extensiones ambiciosas (opcional, largo plazo)

- Retrograde + Retrograde-inversion (Tier A del roadmap de NeuralJam)
- Sequence, fragmentation (Tier A)
- Voice leading en harmonize (Tier B — Tymoczko)
- Multi-voice output (Tier B)
- RICH chain de Frans Absil (Tier C)
- Steve Reich phasing (Tier C)

---

## 8. Checklist de acciones concretas

### Para hacer YA esta semana

- [ ] Leer este documento entero
- [ ] Decidir orden de prioridades — Fase 0 primero es no-negociable
- [ ] Verificar que el `git push` esté al día
- [ ] Verificar cuánto se está gastando actualmente en Anthropic/Gemini (auditoría de uso)
- [ ] Verificar cuántos usuarios activos tiene PianoStudy hoy

### Antes de sumar cualquier feature nuevo

- [ ] Cerrar Fase 0 completa (seguridad)
- [ ] Cerrar Fase 1 mínima (backup semanal manual al menos)

### Antes de cobrar por premium

- [ ] Fase 0 cerrada
- [ ] Fase 1 completa (Nivel 2)
- [ ] Terms of Service publicadas
- [ ] Privacy Policy publicada
- [ ] Data export para usuarios funcionando
- [ ] Data deletion respeta storage

### Antes de escalar a 100+ usuarios

- [ ] Upgrade a Supabase Pro
- [ ] Rate limiting bien testeado
- [ ] Runbook de DR probado (restaurar en Supabase de prueba)
- [ ] Alertas de uso anormal (billing alerts en Anthropic/Google)

---

## 9. Modo remoto — trabajo autónomo desde el celular

### 9.1 Cómo se activa

Cuando digas **"estoy remoto"**, **"modo remoto"**, o **"desde el celular"**, Claude entra en modo autónomo:

- Trabaja sobre la rama actual, sin crear ramas nuevas ni cambiar de rama.
- No hace preguntas de decisiones tácticas (nombres, orden interno, estilos). Toma la decisión razonable y sigue.
- SÍ pregunta y espera respuesta ante: acciones irreversibles, decisiones de producto, cambios que afecten a usuarios en producción.
- **NO hace commits, ni push, ni merges.** El usuario hace todo el trabajo con git cuando vuelve.
- Los cambios quedan como archivos modificados en el working tree, listos para que el usuario revise el diff completo con `git status` / `git diff` al volver.

### 9.2 Qué SÍ puede hacer sin vos

**Fase 0 — código (todo lo que no toca Supabase):**
- Refactor de `anthropic-proxy` y `gemini-proxy` para leer keys de `Deno.env`.
- Refactor de `AIAnalysisEngine.js` para llamar al proxy con JWT.
- Borrar `localStorage.getItem('pianostudy-ai-api-key')` y su UI.
- Auditar `.innerHTML` en `app.js` y envolver con `escapeHtml`.
- Sacar `console.log` de respuestas LLM.
- Cambiar SHA-256 → PBKDF2 en `AuthManager.js`.
- Rate limiting básico en los proxies (in-memory).

**Fase 1 — backup e infra:**
- Exportar RLS policies y RPC del README a `supabase/migrations/*.sql`.
- Escribir `RUNBOOK_DISASTER_RECOVERY.md`.
- Escribir scripts de backup semanal (DB) y mensual (bucket).
- Script de git bundle local + instrucciones para mirror en GitLab/Gitea.

**Fase 2 — arquitectura:**
- Setup de Vite con la config correcta.
- Split de `app.js` en 5-6 módulos por dominio.
- Bundle local de essentia.js y basic-pitch como fallback CDN.

**Docs y limpieza:**
- Actualizar README con cambios de arquitectura.
- Marcar checkboxes del roadmap conforme avanzan.

### 9.3 Qué te va a esperar cuando vuelvas

- Setear secrets en Supabase Dashboard (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) — 5 min.
- Deploy de edge functions refactorizadas (`supabase functions deploy`) — 1 comando.
- Decidir política del bucket `recordings` (¿público a propósito o no?).
- Probar la app en vivo (Claude no puede ejecutar el frontend con Supabase real).
- Aprobar `git push` y merge a `main`.
- Todo lo de Fase 3 (Stripe) y Fase 4 (Mirror) que requiere decisiones de producto.

### 9.4 Cómo te enterás de lo que hizo

Al final de cada sesión remota, Claude deja:

- Todos los cambios sin commitear en el working tree — vos revisás con `git status` y `git diff`.
- Un `RESUMEN_SESION_REMOTA_YYYY-MM-DD.md` en la raíz que lista:
  - Qué archivos tocó y por qué.
  - Qué queda pendiente de tu lado.
  - Qué decisiones tuvo que tomar y por qué.
  - Qué se decidió NO tocar y la razón.
  - Orden sugerido para agrupar los cambios en commits cuando vos lo hagas.

### 9.5 Reglas duras que Claude respeta en modo remoto

- ❌ **NO hace commits.** Ni `git add`, ni `git commit`, ni `git push`, ni merges. Todo git lo hace el usuario al volver.
- ❌ NO cambia de rama ni crea ramas nuevas.
- ❌ NO borra archivos que no creó él mismo en la sesión (mueve a `_pendiente_revision/` en su lugar).
- ❌ NO modifica configuración de Supabase, DNS, Stripe, ni ningún servicio externo.
- ❌ NO usa `--force`, `--no-verify`, ni `reset --hard`.
- ✅ SÍ agrupa los cambios por bloque lógico y lo documenta en el resumen, para que después vos hagas los commits ordenados.
- ✅ SÍ para y espera si aparece un caso que requiere criterio del producto.

### 9.6 Cómo pausás o cambiás el rumbo

- **"pausá"** o **"vuelvo"** → Claude termina el bloque en curso y espera. No hace nada de git.
- **"cambiá a X"** → deja lo actual como está en el working tree y pasa al nuevo objetivo.
- **"descartá lo último"** → Claude te muestra los archivos afectados para que vos decidas si revertir con `git checkout --` o mantener.

---

## 10. Referencias externas

### Seguridad

- [Supabase Edge Functions Secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase RLS best practices](https://supabase.com/docs/guides/auth/row-level-security)
- [OWASP Top 10 2021](https://owasp.org/www-project-top-ten/)
- [PBKDF2 con crypto.subtle](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits)

### Backup

- [Supabase backups](https://supabase.com/docs/guides/platform/backups)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- [Cloudflare R2 pricing](https://www.cloudflare.com/products/r2/)
- [rclone documentation](https://rclone.org/docs/)

### Stripe y pagos

- [Stripe Docs](https://stripe.com/docs)
- [Stripe + Supabase integration](https://supabase.com/docs/guides/functions/examples/stripe-webhooks)

### Audio processing (ya en uso)

- [Essentia.js](https://mtg.github.io/essentia.js/)
- [Spotify basic-pitch](https://basicpitch.spotify.com/)
- [Tone.js](https://tonejs.github.io/)
- [WebAudioFont](https://github.com/surikov/webaudiofont)

### NeuralJam context

- `C:\AI-Duet-Local\ROADMAP.md` — ver ítem 13 (mejoras al ESPEJO) e ítem 14 (deploy web)
- `C:\AI-Duet-Local\investigacion_2026-08-08.md` — investigación consolidada del 2026-08-08

---

## Metadata del documento

- **Fecha:** 2026-08-08
- **Estado:** diagnóstico completo, plan estructurado, sin ejecutar
- **Cambios de código realizados:** ninguno
- **Archivos leídos para el diagnóstico:**
  - `README.md` (367 líneas)
  - `index.html` (754 líneas — parcial)
  - `supabase/functions/anthropic-proxy/index.ts` (72 líneas)
  - `supabase/functions/gemini-proxy/index.ts` (88 líneas)
  - `assets/js/modules/supabase-client.js` (7 líneas)
  - `assets/js/modules/AuthManager.js` (100+ líneas leídas)
  - `assets/js/modules/AIAnalysisEngine.js` (100+ líneas leídas)
  - `assets/js/modules/AudioAnalyzer.js` (50 líneas leídas)
  - `assets/js/utils/sanitizers.js` (60 líneas)
  - `app.js` (buscado con grep, no leído completo por tamaño)

Este documento se actualiza cuando se completan fases del roadmap. Marcar los checkboxes con `[x]` al terminar cada acción.
