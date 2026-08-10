# Política de Privacidad de PianoStudy

**Última actualización:** [FECHA DE PUBLICACIÓN]

> ⚠️ **Borrador de trabajo, no publicado todavía.** Igual que los Términos de Servicio, este documento tiene placeholders entre corchetes por completar y conviene que lo revise un abogado antes de publicarlo — especialmente las secciones de datos de menores, consentimiento para IA, y las obligaciones que aplican si tenés usuarios en la Unión Europea (GDPR) o California (CCPA), que este borrador no cubre en detalle. Ver `RESUMEN_SESION_REMOTA_2026-08-09.md` para el resto de las salvedades.

---

## 1. Quiénes somos

PianoStudy es una aplicación de estudio para pianistas operada por [NOMBRE LEGAL DEL TITULAR]. Esta política explica qué datos recopilamos, para qué los usamos, con quién los compartimos y qué derechos tenés sobre ellos.

## 2. Qué datos recopilamos

**Datos de tu cuenta:**
- Nombre completo, nombre de usuario, email.
- Contraseña (no la vemos ni la guardamos en texto plano — la maneja el sistema de autenticación con hash seguro).
- Pregunta y respuesta de seguridad para recuperar tu cuenta (la respuesta se guarda con un hash reforzado, no en texto plano).

**Tu contenido musical:**
- Grabaciones de audio de tus sesiones de práctica.
- Licks (frases musicales) que guardás: nombre, estilo, notas, y el audio si lo subís.
- Frases de video de YouTube que marcás para practicar.
- Artistas y canciones que agregás como favoritos.
- Resultados de los análisis de IA sobre tus grabaciones y las preguntas que le hacés al asistente.

**Datos técnicos:**
- Metadatos de uso necesarios para el funcionamiento del servicio (por ejemplo, cuándo hiciste una solicitud a las funciones de IA, para aplicar límites de uso razonables y evitar abuso).
- Preferencias guardadas localmente en tu navegador (por ejemplo, configuración del metrónomo) — esto no sale de tu dispositivo.

No recopilamos datos de pago hoy porque PianoStudy es gratuito. Ver la sección 9 (comentada) para cuando eso cambie.

## 3. Para qué usamos tus datos

- Darte el servicio: guardar tu biblioteca, reproducir tus grabaciones, mostrarte tu progreso.
- Generar el análisis de IA sobre tus grabaciones y responder tus preguntas dentro de la app.
- Verificar tu identidad al iniciar sesión y al recuperar tu contraseña.
- Prevenir abuso (por ejemplo, límites de uso en las funciones de IA para que un solo usuario no agote la capacidad disponible para todos).
- Mejorar modelos de inteligencia artificial — **solo si diste tu consentimiento explícito para eso**, ver sección 4.

No usamos tus datos para publicidad ni los vendemos a terceros.

## 4. Uso de tus datos musicales para mejorar los modelos de IA

Esto aplica a tus frases MIDI, grabaciones de audio, transcripciones automáticas y las interacciones que tenés con las funciones de inteligencia artificial de PianoStudy, incluyendo la sección NeuralJam cuando esté disponible.

**Por defecto, esos datos se usan únicamente para operar el servicio** — analizarlos, transcribirlos y mostrarte los resultados a vos. No entrenamos ni mejoramos ningún modelo de IA con tus datos musicales a menos que lo permitas de forma activa y explícita.

Si elegís dar tu consentimiento para que usemos tus sesiones musicales en la mejora de nuestros modelos (por ejemplo, el motor que genera variaciones en NeuralJam):

- Te lo vamos a pedir con una acción separada y clara (por ejemplo, un interruptor en Ajustes que decís vos cuándo activar) — no viene activado por defecto y no se activa solo por usar la app o aceptar los Términos de Servicio en general.
- Vamos a explicarte en ese momento, en lenguaje simple, qué implica concretamente (qué datos se usan, con qué frecuencia, si se anonimizan).
- Podés retirar el consentimiento cuando quieras, desde la misma opción o escribiéndonos a [EMAIL DE CONTACTO]. A partir de ahí, dejamos de usar tus datos nuevos para entrenamiento.
- Si tus datos ya se usaron en el entrenamiento de una versión anterior del modelo antes de que retires el consentimiento, es posible que no podamos eliminar técnicamente esa influencia específica de ese modelo ya entrenado — pero no se van a seguir usando tus datos de ahí en adelante, y podés pedirnos que eliminemos las copias que tengamos guardadas fuera del modelo.
- Antes de usar un dato musical para entrenamiento, intentamos disociarlo de tu identidad en la medida en que sea técnicamente posible (por ejemplo, sin tu nombre de usuario ni otros identificadores directos).

## 5. Con quién compartimos tus datos

No vendemos tus datos. Los compartimos únicamente con los proveedores que necesitamos para operar PianoStudy:

- **Supabase** — aloja nuestra base de datos, autenticación y el almacenamiento de tus grabaciones de audio.
- **Google (Gemini)** y **Anthropic (Claude)** — procesan tus grabaciones y preguntas cuando usás las funciones de análisis de IA y de preguntas y respuestas. Les enviamos lo necesario para generar la respuesta (métricas de tu grabación, tu pregunta); no reciben tu contraseña ni tu email.
- **YouTube** — si mirás un video embebido dentro de PianoStudy, Google recibe los datos técnicos habituales de reproducción de video según su propia política de privacidad.

<!-- PENDIENTE: activar cuando se configure Stripe.
- **Stripe** — si te suscribís a un plan de pago, Stripe procesa el pago y recibe los datos necesarios para eso (nombre, datos de la tarjeta, email de facturación). Nosotros no almacenamos el número completo de tu tarjeta — solo un identificador que nos da Stripe para gestionar tu suscripción. Ver la política de privacidad de Stripe: https://stripe.com/privacy.
-->

Podemos compartir datos si la ley nos obliga (por ejemplo, una orden judicial), o si es necesario para proteger la seguridad de la plataforma o de otros usuarios.

## 6. Dónde y cómo se guardan tus datos

- Tus datos se almacenan en la infraestructura de Supabase, con reglas de acceso a nivel de base de datos (Row Level Security) que hacen que, por diseño, cada usuario solo pueda leer y modificar su propia información.
- Las conexiones entre tu navegador y nuestros servidores viajan cifradas (HTTPS).
- Tus grabaciones de audio se guardan en un almacenamiento pensado para ser privado, pero **hoy son técnicamente accesibles por cualquiera que consiga la URL directa del archivo** (por ejemplo, si vos mismo la compartís, o si se filtra de alguna forma) — no están indexadas ni son fáciles de adivinar, pero no dependas de esa URL como si fuera información secreta. Estamos evaluando pasar a enlaces con vencimiento automático para reforzar esto.
- Las respuestas a tu pregunta de seguridad se guardan con un algoritmo de hash reforzado (PBKDF2), no en texto plano.

## 7. Cuánto tiempo guardamos tus datos

Guardamos tus datos mientras tu cuenta esté activa. Si eliminás tu cuenta, borramos tu perfil y tu contenido asociado (grabaciones, licks, historial), salvo lo que estemos obligados a conservar por ley o lo que quede en copias de seguridad hasta que estas roten de forma natural (nuestras copias de la base de datos y del almacenamiento se retienen por un período limitado antes de reemplazarse por backups más nuevos).

## 8. Tus derechos sobre tus datos

Podés:

- Pedirnos una copia de los datos que tenemos sobre vos.
- Pedirnos que corrijamos datos incorrectos de tu perfil.
- Pedirnos que eliminemos tu cuenta y tu contenido.
- Retirar el consentimiento para uso de tus datos en entrenamiento de IA (sección 4) sin afectar el resto del servicio.

**Cómo ejercerlos hoy:** escribinos a [EMAIL DE CONTACTO]. Todavía no tenemos un botón de autoservicio dentro de la app para exportar o borrar tus datos automáticamente — mientras tanto, lo procesamos manualmente al recibir tu pedido, en un plazo razonable (buscamos no superar [30 días]).

## 9. Menores de edad

PianoStudy no está dirigido a niños que usen la plataforma sin supervisión de un adulto. Si sos padre, madre o tutor y creés que un menor a tu cargo nos dio datos personales sin tu consentimiento, escribinos a [EMAIL DE CONTACTO] y lo vamos a resolver.

## 10. Cookies y almacenamiento local

PianoStudy usa `localStorage` de tu navegador (no cookies de rastreo de terceros) para guardar preferencias como la configuración del metrónomo, tu historial de análisis y tus artistas favoritos. Esta información vive en tu propio navegador, no la recibimos en nuestros servidores salvo lo que ya se sincroniza con tu cuenta (licks, grabaciones, etc.).

<!-- PENDIENTE: activar cuando se configure Stripe.

## 11. Datos de pago

Cuando actives un plan pago, vas a ingresar tus datos de tarjeta directamente en el formulario seguro de Stripe, no en un formulario de PianoStudy. Nosotros no almacenamos el número completo de tu tarjeta ni el código de seguridad. Guardamos únicamente: qué plan tenés, el estado de tu suscripción, y un identificador de cliente de Stripe para poder gestionar cobros y cancelaciones. Ver la política de privacidad de Stripe para el detalle de cómo procesan tus datos de pago: https://stripe.com/privacy.

-->

## 12. Cambios en esta política

Si hacemos cambios importantes a esta política, te vamos a avisar por email o con un aviso dentro de la app antes de que entren en vigencia.

## 13. Contacto

Para cualquier consulta sobre esta Política de Privacidad o para ejercer tus derechos sobre tus datos, escribinos a [EMAIL DE CONTACTO].

## 14. Ley aplicable

Esta política se rige por las leyes de [PAÍS / PROVINCIA — DEFINIR JURISDICCIÓN], en línea con lo establecido en los Términos de Servicio.
