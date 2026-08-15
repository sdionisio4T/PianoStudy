# Rediseño de la sección "Progreso"

> **Estado:** aprobado, sin implementar todavía. Documento vivo — actualizar al ejecutar.
> **Fecha:** 2026-08-11.

## Contexto

Hoy Progreso muestra: 4 métricas (tiempo de estudio, licks, grabaciones, racha), un grid de **solo 4 medallas × 3 niveles** (`practicante`, `coleccionista`, `grabador`, `racha`), un chart 30 días dibujado a mano en canvas 2D, y una frase motivacional. La infra existe (`ProgressTracker.js`, `renderProgressSection` en `app-controllers.js:1534-1575`, animación `.badge-glow`, toast `.badge-toast`, `practice_sessions` en Supabase, cronómetro live), pero se siente pobre porque:

- El catálogo de medallas está saturado (con 50 licks + 30 días de racha ya tenés todo el nivel oro), no hay hacia dónde progresar.
- Falta cualquier concepto de nivel/XP global — el usuario no siente crecimiento continuo.
- El chart canvas es plano y no invita a interactuar.
- No hay objetivos semanales/quests, no hay comparación con vos mismo del mes pasado, no hay hitos celebrados.
- Muchas señales de actividad ya guardadas en DB no se usan (duración grabada, diversidad de estilos, antigüedad, cantidad de análisis IA).

Objetivo: rediseñar Progreso a algo llamativo e interactivo, con muchas más medallas, sistema XP/nivel global, calendar heatmap, gráficos ricos con Chart.js (paleta del proyecto, sin blancos), y notificaciones celebratorias diferenciadas.

## Estructura visual nueva

Nueve bloques verticales dentro de `#progress`, en este orden:

### 1. Hero card — Nivel y XP

Tarjeta grande con:
- Avatar del usuario (mismo color que header) + nombre público.
- **Nivel actual** (número gigante, ej. "Nivel 12") con etiqueta ("Aprendiz", "Estudioso", "Virtuoso", "Maestro" — 5 rangos por bandas de nivel).
- **Barra de XP grande** con el % al próximo nivel, animada al ganar XP.
- Frase motivacional a la derecha (reusar `getMotivationalPhrase`, ampliar el catálogo a 12 frases variables por racha + hora del día).

### 2. Anillos del día (Apple-Watch style)

Tres anillos concéntricos SVG:
- **Verde**: minutos practicados hoy vs meta diaria (ej. 30 min).
- **Azul**: sesiones grabadas hoy (meta: 1).
- **Naranja**: licks tocados/estudiados hoy (meta: 3).

Se rellenan animados al abrir la sección. Al completar los 3, animación de "día completo".

### 3. Objetivo semanal (quest)

Un card interactivo con la meta actual de la semana (editable):
- Meta por defecto: **150 min a la semana**.
- Botón de lápiz para cambiarla (30/60/90/150/300/custom).
- Barra de progreso semanal + días restantes.
- Al completarla, celebración y suma XP bonus.

### 4. Métricas resumidas (4 cards existentes pero rediseñadas)

Mantener el grid actual (`.progress-metrics` L4064) pero:
- Reemplazar emojis por íconos SVG coherentes.
- Agregar micro-sparkline debajo de cada valor (últimos 7 días) — Chart.js mini-charts.
- Hover → salta al detalle.

### 5. Calendar heatmap (año completo)

Grilla tipo GitHub: 52 semanas × 7 días. Cada celda un cuadrito coloreado según minutos practicados ese día (5 niveles de intensidad, del `--bg-tertiary` al `--accent-green`). Interactivo:
- Hover → tooltip con "3 de agosto: 45 min".
- Click en celda → filtra el chart y el listado de sesiones a ese día.
- Toggle "3 meses / 6 meses / año" arriba.

### 6. Gráfico principal — actividad últimos 30 días

Reemplazar el canvas artesanal por **Chart.js**, cargado por CDN. Tipo línea suavizada:
- Colores del proyecto: línea `--accent-green`, área bajo la línea con gradiente verde translúcido, fondo transparente, textos en `--text-primary`/`--text-secondary`. **Nada de blanco puro; hereda del CSS.**
- Toggle "minutos" / "sesiones" arriba.
- Marcar en la línea los días donde ganaste medallas (dot dorado con tooltip).

### 7. Radar de estilos

Gráfico radar (Chart.js) con los estilos soportados: bebop, hard-bop, son-cubano, latin-jazz, bolero, jazz-colombiano, blues. Cada eje = minutos totales practicando ese estilo (datos: `licks.style` + estilo declarado en cada grabación si existe, o el `default_style` del perfil como fallback). Colores del proyecto — misma paleta verde/azul.

### 8. Grid de medallas — expandido y rediseñado

Del catálogo actual de 4 medallas a **20 categorías × 5 niveles** (bronce → plata → oro → **platino** → **diamante**). Las cards existentes se agrandan un poco, el sprite del ícono se vuelve más detallado, y cada card muestra en la esquina el nivel actual con el color de ese tier.

Catálogo propuesto (20 categorías):

| # | Categoría | Métrica | Umbrales B/P/O/Pt/D |
|---|-----------|---------|---------------------|
| 1 | Practicante 🎹 | Horas totales | 1/10/50/200/1000 |
| 2 | Coleccionista 🎵 | Licks guardados | 5/20/50/150/500 |
| 3 | Grabador 🎙️ | Grabaciones | 5/25/100/500/2000 |
| 4 | Racha 🔥 | Días seguidos | 3/7/30/100/365 |
| 5 | Analista 🧠 | Análisis IA hechos | 5/25/100/500/2000 |
| 6 | Curador ⭐ | Favoritos+artistas custom | 3/10/25/75/200 |
| 7 | Estudioso 📚 | Frases YouTube marcadas | 5/25/100/500/2000 |
| 8 | Duración grabada ⏳ | Minutos totales grabados | 10/60/300/1000/5000 |
| 9 | Antigüedad 📅 | Días desde registro | 7/30/180/365/1000 |
| 10 | Semana perfecta ✅ | Semanas con 7/7 días activos | 1/4/12/26/52 |
| 11 | Sesión maratón 🏃 | Minutos máx en una sesión | 30/60/120/240/480 |
| 12 | Madrugador 🌅 | Sesiones antes de 8am | 5/25/100/365/1000 |
| 13 | Nocturno 🌙 | Sesiones después de 10pm | 5/25/100/365/1000 |
| 14 | Políglota 🎨 | Estilos distintos practicados | 2/3/5/7/8 |
| 15 | Meta cumplida 🎯 | Semanas con objetivo alcanzado | 1/5/15/40/100 |
| 16 | Volver de la nada 💚 | Retomó después de ≥7 días sin práctica | 1/3/10/25/50 |
| 17 | Primeros pasos 👣 | Hitos "primera vez" completados | 3/6/9/12/todos |
| 18 | Coleccionista de son 🇨🇺 | Licks de son cubano | 3/10/25/50/100 |
| 19 | Coleccionista de bebop 🎷 | Licks de bebop | 3/10/25/50/100 |
| 20 | Coleccionista de jazz colombiano 🇨🇴 | Licks de jazz colombiano | 3/10/25/50/100 |

**Colores de tier** (agregar a `LEVEL_COLORS` en `ProgressTracker.js`):
- Bronce `#cd7f32`
- Plata `#C0C0C0`
- Oro `#FFD700`
- Platino `#e5e4e2` sobre fondo con gradiente azul-verde
- Diamante gradiente iridiscente animado (CSS `@keyframes` con hue-rotate)

### 9. Timeline de hitos

Lista compacta al final: las últimas 8-10 medallas subidas de nivel + fechas. Cada entrada con el ícono y "hace 3 días". Da sensación de recorrido.

## Sistema de XP y niveles

Cada acción suma XP (independiente del tiempo de práctica pero correlacionado):

| Acción | XP |
|--------|----|
| 1 minuto de práctica | 1 XP |
| Guardar un lick | 15 XP |
| Guardar una grabación | 20 XP |
| Análisis IA completado | 25 XP |
| Frase YouTube marcada | 5 XP |
| Favorito nuevo / artista custom | 10 XP |
| Meta semanal cumplida | 200 XP |
| Sube medalla (bronce/plata/oro/platino/diamante) | 50/100/200/400/800 XP |

Curva de niveles: `XP_para_nivel(n) = 100 * n * (n+1) / 2` (progresión triangular). Esto da:
- Nivel 1 → 100 XP
- Nivel 5 → 1500 XP
- Nivel 10 → 5500 XP
- Nivel 20 → 21000 XP

Rangos por bandas:
- **Novato** (niveles 1–4)
- **Aprendiz** (5–9)
- **Estudioso** (10–19)
- **Virtuoso** (20–34)
- **Maestro** (35+)

## Notificaciones diferenciadas por importancia

Reusar el sistema `Toast.js` (existente) y `ConsentManager` como referencia de modal. Dos tipos:

### Toast especial "medalla" (para hitos menores)

Nueva variante `toast.medalla(mensaje, tier)` en `Toast.js`:
- Ancho más grande (400px), fondo con gradiente sutil del color del tier.
- Ícono más grande a la izquierda (48px), efecto glow del tier.
- Auto-dismiss a 6500 ms (más lento que un toast normal).
- Se dispara para: subir de nivel bronce/plata/oro, meta diaria cumplida, primer paso individual.

### Modal celebración (para hitos mayores)

Modal centrado, backdrop oscuro con blur:
- Ícono gigante centrado, tier a full color, animación de entrada (scale + fade).
- Confeti CSS puro (12 divs rotando y cayendo con `@keyframes`, sin librería externa).
- Texto: "¡Nuevo nivel! Ahora sos <rango>" o "¡Medalla <categoría> <tier>!"
- Botón "¡Sigamos!" cierra.
- Sonido opcional (respetando `prefers-reduced-motion` y sin autoplay agresivo — usar `<audio>` solo si el usuario ya interactuó en la página).

Se dispara para: subir de nivel platino/diamante, subir de rango general (Novato→Aprendiz, etc), pasar meta semanal, ganar la medalla nº 10/20/50 en total.

## Cambios de datos y backend

### Migración nueva `0010_gamification.sql`

Dos tablas nuevas:

```sql
create table user_achievements (
  user_id uuid references auth.users(id) on delete cascade,
  badge_key text not null,         -- 'practicante', 'analista', etc
  level integer not null,          -- 1=bronce, 2=plata, ..., 5=diamante
  earned_at timestamptz default now(),
  primary key (user_id, badge_key, level)
);

create table user_weekly_goals (
  user_id uuid references auth.users(id) on delete cascade,
  week_start date not null,        -- lunes de la semana
  goal_minutes integer not null,
  completed_at timestamptz,
  primary key (user_id, week_start)
);
```

Plus columnas en `user_profiles`:

```sql
alter table user_profiles
  add column if not exists total_xp bigint not null default 0,
  add column if not exists daily_goal_minutes integer not null default 30;
```

Todas con RLS (`auth.uid() = user_id`).

### Cambios en `ProgressTracker.js`

- Expandir `BADGES` con las 20 categorías + 5 niveles.
- Agregar `LEVEL_COLORS` con platino y diamante.
- Nuevo `computeXP(actions)` que devuelve XP total en base a stats + medallas.
- Nuevo `xpForLevel(n)` y `levelFromXP(xp)`.
- Nuevo `evaluateAdvancedBadges(profile, stats, licks, recordings, sessions)` con evaluación de los nuevos criterios (sesión maratón, madrugador, políglota, etc). Necesita más datos que los que el módulo maneja hoy → aceptar parámetros o mover parte a un módulo nuevo `Achievements.js`.

### Módulo nuevo `Achievements.js`

Separar el catálogo, las evaluaciones específicas y la persistencia contra `user_achievements`:
- `catalog` — objeto con las 20 medallas y sus umbrales.
- `async evaluateAll(userData)` — corre todas las evaluaciones sobre un snapshot completo del usuario.
- `async persistEarnedLevels(userId, unlocks)` — upsert en `user_achievements`.
- `async loadTimeline(userId, limit=10)` — lee las últimas N medallas ganadas.

## Archivos que cambian

- **`index.html`** — reemplazar bloque `#progress` (líneas 637-688) con las 9 secciones nuevas. Sumar `<script>` CDN de Chart.js (`https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js`).
- **`assets/js/modules/ProgressTracker.js`** — expandir catálogo, sumar XP/niveles/rangos.
- **`assets/js/modules/Achievements.js`** (nuevo) — evaluación y persistencia.
- **`assets/js/modules/Toast.js`** — agregar variante `medalla(mensaje, tier)`.
- **`assets/js/app/app-progress.js`** (nuevo mixin, mismo patrón que `app-settings.js`) — todos los renderers nuevos: `renderHero`, `renderRingStats`, `renderWeeklyGoal`, `renderHeatmap`, `renderMainChart`, `renderStyleRadar`, `renderBadgesGrid`, `renderTimeline`, `showAchievementCelebration`.
- **`assets/js/app/app-init.js`** — sumar `progressMixin` al `Object.assign`.
- **`assets/js/app/app-ui.js`** — en `showSection('progress')`, delegar en `renderProgressSection()` (que ahora invoca los 9 sub-renderers).
- **`assets/js/app/app-controllers.js`** — mover o adelgazar `renderProgressSection` (L1534) para que delegue al nuevo mixin. Mantener el cronómetro donde está.
- **`assets/js/modules/SupabaseDataManager.js`** — nuevos `getWeeklyGoal(weekStart)`, `setWeeklyGoal(week, minutes)`, `saveAchievement(badgeKey, level)`, `loadAchievements()`, `addXP(delta)`.
- **`styles.css`** — grande bloque nuevo: hero card, rings SVG, weekly goal, heatmap, chart container con paleta correcta, radar container, badge grid mejorado (5 tiers), timeline. Reutilizar `.badge-glow`, `.progress-metrics`, `.dashboard-card` como base.
- **`supabase/migrations/0010_gamification.sql`** — nueva migración.
- **`docs/PLAN_PROGRESO.md`** — este mismo documento, versionado en el repo.

## Verificación

1. `npm run dev` → registrarse con cuenta nueva. Ir a Progreso: debería ver nivel 1, XP 0, todos los anillos vacíos, cero medallas.
2. Practicar 30 minutos con el cronómetro → gana medalla "Practicante bronce" (toast especial dorado + XP), anillo verde se llena.
3. Guardar 5 licks → "Coleccionista bronce", XP sube, nivel puede subir.
4. Setear meta semanal a 60 min y cumplirla → modal celebración + confeti.
5. Ver heatmap: los días con práctica aparecen coloreados.
6. Ver radar de estilos: solo el estilo que practicaste tiene relleno.
7. Correr `npm test` — nada rompe (los tests actuales no tocan Progreso, pero suma un test para `xpForLevel` y `levelFromXP`).
8. Aplicar migración: `0010_gamification.sql`.

## Fuera de alcance (para PR siguiente)

- **Ranking global** — descartado por decisión del usuario (progreso privado).
- **Streak freezes** tipo Duolingo (te salvo tu racha 1× por mes). Fase 2.
- **Sonido de celebración** — dejar preparado el hook, pero cargar el archivo `.mp3` puede quedar para PR siguiente.
- **Modo comparación** (mes actual vs mes pasado) — feature útil pero no crítico.
- **Achievements sociales** (compartir medalla) — descartado por decisión.
- **Retroactivo**: cuando un usuario existente entre por primera vez con este código, corre `evaluateAll` una sola vez para poblarle las medallas que ya se ganó. Se hace inline en `checkPendingDeletion`-style, sin migración de datos separada.
