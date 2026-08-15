# Plan de seguridad de PianoStudy

> **Estado:** propuesto, sin implementar todavía.
> **Fecha:** 2026-08-11.
> **Alcance:** frontend, Supabase Auth/DB/Storage y Edge Functions. No sustituye una auditoría externa ni confirma la configuración actualmente desplegada en Supabase.

## Objetivo

Antes de abrir el registro a más usuarios, habilitar pagos o almacenar una cantidad relevante de grabaciones, asegurar que cada usuario solo pueda acceder a sus propios datos, que las grabaciones se eliminen realmente cuando corresponda y que los endpoints de IA no puedan usarse para extraer datos o generar costes sin control.

## Diagnóstico resumido

La base es buena: las claves de IA viven en Edge Functions, estas validan el JWT, hay RLS documentado, la recuperación de contraseña usa enlaces por email y existe una primera capa de rate limiting.

Hay cuatro riesgos que bloquean considerar la app lista para producción pública:

1. El bucket `recordings` tiene lectura pública y permite a cualquier usuario autenticado subir a cualquier ruta.
2. El RPC `get_email_by_username` es ejecutable por `anon` y revela el email asociado a un username.
3. El rate limit de IA vive en memoria, no se comparte entre instancias y acepta modelo/prompt sin límites estrictos.
4. Las migraciones son una reconstrucción documental; no se ha comprobado que reflejen exactamente el proyecto Supabase real.

## Fase S0 — Bloqueadores de privacidad (antes de crecer)

### S0.1 — Hacer privadas las grabaciones

- Cambiar el bucket `recordings` a privado.
- Guardar siempre los archivos bajo una ruta controlada: `<auth.uid()>/<recording-id>/<filename>`.
- Reemplazar URLs públicas por URLs firmadas de duración corta para reproducción y descarga.
- Sustituir la policy actual de insert por una que compruebe que la primera carpeta de `storage.objects.name` coincide con `auth.uid()`.
- Añadir policies explícitas de `select`, `update` y `delete` con la misma condición de propiedad.
- Revisar cada llamada de upload/playback en `SupabaseDataManager.js` para adoptar la nueva ruta y las URLs firmadas.

**Verificación:** con Usuario A y Usuario B, intentar leer, subir, actualizar y borrar un objeto de la carpeta del otro. Las cuatro operaciones deben fallar. Una URL firmada propia debe reproducir el audio y expirar al vencer.

### S0.2 — Borrado de cuenta que también borre Storage

- Definir la política definitiva de retención: mantener 30 días tras la solicitud o purgar de inmediato.
- Implementar el job/cron de purga ya documentado para cuentas vencidas.
- Antes de borrar el usuario de Auth, listar y borrar todos los objetos de `recordings/<user-id>/` usando una Edge Function con service role.
- Guardar un log operativo mínimo de la purga: user ID, fecha, objetos eliminados y resultado; sin almacenar audio ni credenciales.
- Probar cancelación de borrado dentro de los 30 días y purga completa tras el vencimiento.

**Verificación:** crear una cuenta de prueba con varias grabaciones, programar su borrado y ejecutar la purga en un entorno de prueba. Confirmar que no quedan filas, objetos ni URLs firmadas utilizables.

### S0.3 — Eliminar la exposición pública username → email

- Retirar el uso cliente del RPC `get_email_by_username` y revocar `execute` para `anon` y `authenticated` cuando ya no se use.
- Opción recomendada: autenticación y recuperación exclusivamente por email. El username sigue siendo un nombre público de perfil, no una credencial.
- Mostrar respuestas neutras en login y recuperación: no indicar si un email o username existe.
- Si más adelante es imprescindible iniciar sesión por username, diseñar un flujo server-side que nunca devuelva el email al navegador y someterlo a revisión específica.

**Verificación:** desde una sesión anónima, intentar invocar el RPC y comprobar que falla. Probar recuperación con emails/usuarios existentes e inexistentes: la respuesta visible debe ser indistinguible.

## Fase S1 — Endurecimiento de IA y autenticación

### S1.1 — Límites robustos para Edge Functions de IA

- Definir una lista interna de modelos permitidos; ignorar cualquier `model` enviado por el cliente o validarlo contra esa lista.
- Limitar tamaño de `prompt` y `systemPrompt`, número de mensajes y parámetros de generación (por ejemplo, `max_tokens`).
- Establecer límites por usuario y por IP: minuto, día y cuota mensual según plan.
- Reemplazar el contador en memoria por un mecanismo compartido y atómico (Postgres/RPC, Redis/Upstash u otro servicio administrado).
- Añadir alertas de consumo y un interruptor operativo para deshabilitar temporalmente los endpoints de IA.
- No devolver al cliente detalles internos de proveedores, configuración o excepciones.

**Verificación:** pruebas automatizadas para payloads demasiado grandes, modelos no permitidos, usuario sin JWT y límite por ventana. Probar concurrencia con dos instancias/simulaciones y comprobar que la cuota no se duplica.

### S1.2 — Fortalecer Auth

- Elevar la contraseña mínima a 10–12 caracteres y comunicar requisitos claros en UI.
- Activar en Supabase confirmación de email, rate limits de Auth y CAPTCHA/Turnstile si hay registro público.
- Revisar la configuración de redirects de recuperación: solo dominios de producción y desarrollo autorizados, siempre HTTPS en producción.
- Mantener mensajes de error genéricos para no enumerar cuentas.
- Revisar sesiones activas y asegurar el cierre global al eliminar una cuenta.

**Verificación:** alta, login, recuperación y cambio de contraseña en producción y desarrollo. Confirmar que un redirect arbitrario es rechazado y que los intentos repetidos se limitan.

## Fase S2 — Fuente de verdad y controles de datos

### S2.1 — Reconciliar migraciones con Supabase real

- Ejecutar `supabase db pull` contra un entorno seguro y comparar el resultado con `supabase/migrations/`.
- Identificar tablas, funciones, triggers, grants y policies que existan solo en el dashboard.
- Corregir la historia de migraciones antes de añadir `0010_gamification.sql` o cambios de pagos.
- Actualizar `supabase/migrations/README.md`, que hoy documenta hasta `0005` aunque el repositorio incluye `0006`–`0009`.

**Verificación:** crear una base de datos de prueba desde migraciones y ejecutar pruebas funcionales de alta, lectura/escritura de datos, Storage, recuperación y borrado.

### S2.2 — Pruebas de autorización RLS

- Crear una suite de pruebas con dos usuarios de prueba y datos cruzados para `licks`, `recordings`, `custom_artists`, `favorite_songs`, `practice_sessions`, `user_profiles` y `user_achievements` cuando exista.
- Validar `select`, `insert`, `update` y `delete` por tabla, no solo lectura.
- Revisar que `user_id` use UUID de forma consistente en tablas nuevas y existentes cuando sea viable.
- Revisar funciones `security definer` y fijar `search_path` explícito en todas.

**Verificación:** CI debe rechazar una política que permita a Usuario A realizar cualquier operación sobre una fila de Usuario B.

### S2.3 — Datos de progreso y privacidad

- Antes de implementar gamificación, definir qué eventos se guardan (sesión, hora, estilo, análisis IA, objetivos) y por cuánto tiempo.
- Hacer que Supabase sea la fuente de verdad de XP y logros; evitar que valores de cliente puedan aumentar XP sin validación.
- Aplicar RLS a `user_achievements` y `user_weekly_goals` y usar operaciones idempotentes para no duplicar XP o premios.
- Actualizar política de privacidad y exportación de datos con las nuevas categorías de datos.

## Fase S3 — Operación continua

- Configurar backup de DB y Storage; realizar y documentar una restauración real en un proyecto de prueba.
- Habilitar alertas de Supabase, Stripe (cuando exista) y proveedores de IA para uso anómalo, errores y límites de gasto.
- Añadir cabeceras de seguridad y revisar CSP al incorporar nuevos CDNs como Chart.js.
- Establecer revisión de dependencias mensual y Dependabot/Renovate si se adopta.
- Hacer una revisión manual de XSS en todos los usos de `innerHTML`; contenido del usuario debe pasar por `escapeHtml` o construirse con `textContent`.
- Ejecutar una revisión de seguridad antes de Stripe y otra antes de abrir beta pública.

## Orden recomendado de ejecución

1. S2.1: reconciliar el esquema real, para no aplicar cambios sobre supuestos.
2. S0.1 y S0.2: privacidad y ciclo de vida de grabaciones.
3. S0.3: retirar la exposición de emails.
4. S1.1 y S1.2: abuso de IA y Auth.
5. S2.2: pruebas RLS automatizadas.
6. S2.3: gamificación segura sobre datos fiables.
7. S3: operación, backups y revisión continua.

## Criterio de salida para beta pública

- Storage privado con pruebas cruzadas entre dos usuarios.
- Borrado de cuenta probado, incluyendo grabaciones.
- Ningún RPC anónimo revela emails o existencia de cuentas.
- Límites de IA compartidos, medibles y con alertas de gasto.
- Esquema y policies de producción exportados y versionados.
- Suite automatizada de autorización y flujo crítico de Auth en CI.
- Restauración de backup practicada en un proyecto de prueba.
