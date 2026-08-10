# Términos de Servicio de PianoStudy

**Última actualización:** [FECHA DE PUBLICACIÓN]

> ⚠️ **Borrador de trabajo, no publicado todavía.** Este documento fue redactado como punto de partida y contiene placeholders entre corchetes (`[ASÍ]`) que hay que completar antes de publicarlo — nombre legal del titular, email de contacto, jurisdicción, dirección si corresponde. Se recomienda que lo revise un abogado antes de ponerlo en producción, en particular por el tratamiento de datos de menores, el consentimiento para entrenamiento de modelos de IA y los requisitos de Stripe una vez que se active el cobro. Ver `RESUMEN_SESION_REMOTA_2026-08-09.md` para el detalle de qué falta.

---

## 1. Qué es PianoStudy

PianoStudy es una aplicación web para pianistas que permite:

- Grabar sesiones de práctica y analizarlas (tempo, tonalidad, dinámica) usando bibliotecas de análisis musical (MIR).
- Guardar y organizar una biblioteca personal de "licks" (frases musicales) por estilo.
- Recibir retroalimentación generada por inteligencia artificial sobre tus grabaciones y hacer preguntas sobre tu interpretación.
- Descubrir artistas recomendados por estilo musical y guardar canciones/piezas favoritas.
- Practicar con fragmentos de video de YouTube.
- Llevar un registro de tu progreso y tiempo de práctica.

Hoy PianoStudy **es gratuito**. Si en el futuro se ofrecen planes pagos, la sección 8 de este documento (hoy comentada, ver más abajo) va a detallar cómo funcionan.

Al crear una cuenta o usar PianoStudy aceptás estos Términos de Servicio. Si no estás de acuerdo, no uses el servicio.

## 2. Quién puede usar PianoStudy

- Necesitás al menos [13/16/18 — DEFINIR EDAD MÍNIMA] años para crear una cuenta propia.
- Si sos menor de esa edad, podés usar PianoStudy solo con la supervisión y el consentimiento de un padre, madre o tutor, que será quien acepte estos Términos en tu nombre.
- Sos responsable de que la información que nos das al registrarte (nombre, usuario, email) sea correcta.

## 3. Tu cuenta

- Sos responsable de mantener la confidencialidad de tu contraseña y de todo lo que ocurra en tu cuenta.
- Si sospechás que alguien más accedió a tu cuenta, avisanos a [EMAIL DE CONTACTO] lo antes posible.
- Podés eliminar tu cuenta cuando quieras escribiéndonos a [EMAIL DE CONTACTO] (ver también la Política de Privacidad, sección de tus derechos sobre tus datos).

## 4. Uso aceptable

Al usar PianoStudy te comprometés a:

- No subir grabaciones, nombres de licks, descripciones ni ningún otro contenido que sea ilegal, difame a terceros, infrinja derechos de autor ajenos, o contenga malware.
- No intentar acceder a cuentas de otros usuarios ni a partes del sistema que no te correspondan.
- No usar bots, scraping automatizado ni ingeniería inversa para extraer datos o abusar de los límites de uso de las funciones de IA.
- No usar el servicio para entrenar, alimentar o mejorar productos de terceros sin nuestra autorización.

Podemos suspender o cerrar cuentas que incumplan esto, avisando por email salvo que la situación requiera actuar antes (por ejemplo, un intento activo de vulnerar la seguridad del sistema).

## 5. Tu contenido

Las grabaciones de audio, licks, notas, nombres de piezas favoritas y demás contenido que subís siguen siendo tuyos. Nos das una licencia limitada, no exclusiva, para almacenar, procesar y mostrarte ese contenido dentro de la aplicación — es decir, el permiso técnico necesario para que PianoStudy funcione (guardar tu grabación, transcribirla, analizarla, mostrártela en tu biblioteca). No usamos tu contenido para publicidad ni lo vendemos a terceros.

Sos responsable de tener los derechos necesarios sobre lo que subís (por ejemplo, si grabás una versión de una canción de otro autor para practicar, eso es tuyo para uso personal de práctica, no te da licencia para redistribuirla).

## 6. Uso de tus datos musicales para mejorar los modelos de IA

Esta sección aplica a las frases MIDI, grabaciones de audio, transcripciones y las interacciones que tenés con las funciones de inteligencia artificial de PianoStudy (incluyendo, cuando esté disponible, la sección NeuralJam).

**Por defecto, tus datos musicales se usan únicamente para darte el servicio** — analizarlos, transcribirlos, guardarlos en tu biblioteca y mostrarte resultados. No se usan para entrenar ni mejorar ningún modelo de inteligencia artificial a menos que vos lo permitas explícitamente.

Si más adelante querés ayudarnos a mejorar el motor de IA (por ejemplo, el modelo que genera variaciones musicales en NeuralJam), te vamos a pedir un **consentimiento aparte y específico** para eso — no alcanza con haber aceptado estos Términos de Servicio en general. Ese consentimiento:

- Es una acción explícita tuya (por ejemplo, activar una opción en Ajustes), no algo marcado por defecto.
- Podés retirarlo en cualquier momento desde tu cuenta o escribiéndonos a [EMAIL DE CONTACTO].
- Aplica solo hacia adelante: si retirás el consentimiento, dejamos de usar tus datos nuevos para entrenamiento, pero si ya se usaron datos anteriores para entrenar una versión del modelo, es posible que técnicamente no podamos "desentrenar" esa versión específica — sí podemos garantizarte que no se van a seguir usando tus datos a partir de ese momento.
- Antes de usar cualquier dato musical para entrenamiento, buscamos disociarlo de tu identidad en la medida de lo técnicamente posible (por ejemplo, sin tu nombre de usuario ni metadatos que te identifiquen directamente).

Podés seguir usando todas las funciones normales de PianoStudy sin dar este consentimiento — no es un requisito para usar el servicio.

## 7. Propiedad intelectual de PianoStudy

El código, diseño, marca "PianoStudy" y los materiales propios de la aplicación (no el contenido que vos subís) son propiedad de [NOMBRE LEGAL DEL TITULAR]. No podés copiar, redistribuir ni crear trabajos derivados del producto sin autorización.

<!-- PENDIENTE: activar cuando se configure Stripe. Todo el contenido de esta sección ya está redactado; para publicarla alcanza con quitar estas marcas de comentario, no hace falta reescribir nada.

## 8. Planes y suscripciones

### 8.1 Planes disponibles

PianoStudy ofrece un plan gratuito y un plan Premium de pago. El plan Premium incluye [DETALLAR FEATURES PREMIUM — ej. NeuralJam Mirror, análisis avanzados, sesiones ilimitadas, prioridad en las respuestas de IA]. Los precios vigentes están siempre disponibles en [PÁGINA DE PRECIOS] antes de que confirmes una compra.

### 8.2 Cómo se cobra

Los pagos se procesan a través de Stripe, un proveedor de pagos externo. PianoStudy no almacena los números de tu tarjeta — eso lo maneja Stripe directamente, conforme a los estándares de seguridad de la industria (PCI DSS). Ver la Política de Privacidad para más detalle sobre qué datos comparte Stripe con nosotros.

### 8.3 Renovación automática

Las suscripciones al plan Premium se renuevan automáticamente al final de cada período (mensual o anual, según el plan que elijas) hasta que la canceles. Te vamos a avisar por email antes de cada renovación con al menos [X días] de anticipación si el monto cambia.

### 8.4 Cancelación

Podés cancelar tu suscripción en cualquier momento desde [Ajustes → Mi cuenta / Portal de facturación de Stripe]. La cancelación aplica al final del período ya pagado — seguís teniendo acceso Premium hasta esa fecha, sin cobros futuros.

### 8.5 Reembolsos

[DEFINIR POLÍTICA CONCRETA — opciones típicas: reembolso completo dentro de los primeros N días de la primera suscripción; sin reembolso por meses ya transcurridos en renovaciones; reembolso a criterio caso por caso ante errores de cobro]. Para solicitar un reembolso, escribinos a [EMAIL DE CONTACTO] indicando el motivo.

### 8.6 Cambios de precio

Si cambiamos el precio de un plan, te vamos a avisar con al menos [X días] de anticipación antes de que el nuevo precio te afecte a vos. Si no estás de acuerdo, podés cancelar antes de que se aplique.

-->

## 9. Cambios en estos Términos

Podemos actualizar estos Términos de vez en cuando. Si el cambio es significativo, te vamos a avisar por email o con un aviso dentro de la aplicación antes de que entre en vigencia. Seguir usando PianoStudy después de un cambio implica que lo aceptás.

## 10. Disponibilidad del servicio

Hacemos un esfuerzo razonable para mantener PianoStudy disponible, pero no garantizamos que esté libre de interrupciones o errores. Algunas funciones dependen de servicios de terceros (Supabase para la base de datos y almacenamiento, Google y Anthropic para las funciones de IA, YouTube para los videos) que están fuera de nuestro control — si alguno de ellos falla, es posible que la función correspondiente deje de funcionar temporalmente.

## 11. Límite de responsabilidad

PianoStudy se ofrece "tal cual". En la medida permitida por la ley, no somos responsables por daños indirectos derivados del uso del servicio (por ejemplo, pérdida de datos por una falla técnica que esté fuera de nuestro control razonable). Hacemos backups periódicos, pero te recomendamos no depender de PianoStudy como única copia de grabaciones que te importen mucho.

## 12. Contacto

Para preguntas sobre estos Términos, escribinos a [EMAIL DE CONTACTO].

## 13. Ley aplicable y jurisdicción

Estos Términos se rigen por las leyes de [PAÍS / PROVINCIA — DEFINIR JURISDICCIÓN]. Cualquier disputa que no se resuelva de forma directa entre las partes se someterá a los tribunales de [CIUDAD/JURISDICCIÓN COMPETENTE].
