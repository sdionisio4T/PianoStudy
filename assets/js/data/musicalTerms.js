// PianoStudy — Banco de términos musicales (representación estructurada).
// Fuente de verdad legible: MUSICAL_TERMS.md (junto a este archivo).
// Si actualizás uno, sincronizá el otro.
//
// Propósito: darle al AIAnalysisEngine una lista compacta y auditable de
// vocabulario musical CORRECTO por sesión — no una biblioteca completa.
// La función clave es `getRelevantMusicalTerms(...)` que devuelve entre 4 y 10
// términos según reliability + estilo declarado + evidencia disponible.
// El cap final es adaptativo: 6 con evidencia mínima, 8 intermedia, 10 rica
// (rica = auditory + transcripción reliable + tonalidad high).
// Cap intencionalmente bajo: el prompt ya lleva reglas generales de uso
// (REGLA 12 en AIAnalysisEngine.js) y agregar 20 términos en cada llamada
// consumía ~1500 tokens sin evidencia adicional. Devolver menos y sólidos.
//
// El banco NO existe para que el modelo use más palabras. Existe para que use
// las palabras correctas cuando la evidencia las respalda.

// ─── Estructura de un término ────────────────────────────────────────────────
// {
//   id: 'tempo',                       // slug único
//   term: 'Tempo',                     // etiqueta al usuario/prompt
//   aliases: ['velocidad', 'BPM'],     // sinónimos para búsqueda
//   category: 'time',                  // agrupa (time/dynamics/melody/harmony/jazz/piano/afrocuban/bolero/colombian)
//   level: 'observable',               // observable | interpretative | advanced
//   definition: '...',                 // corto, para el prompt
//   evidenceRequired: '...',           // qué señal/dato del sistema respalda su uso
//   allowedWhen: [...],                // predicados textuales (leídos por humanos / logs)
//   forbiddenWhen: [...],              // condiciones que lo hacen inválido
//   pedagogicalUse: '...',             // cómo se debe usar en feedback (una línea)
//   styles: ['*'] | ['soncubano', ...],// estilos donde tiene sentido; '*' = cualquiera
//   relatedTerms: ['pulso']            // para el modelo cuando quiere alternativas
// }

export const MUSICAL_TERMS = {
    // ─── A. Tiempo y ritmo ──────────────────────────────────────────────
    tempo: {
        id: 'tempo', term: 'Tempo', aliases: ['velocidad', 'BPM'],
        category: 'time', level: 'observable',
        definition: 'Velocidad general de la interpretación, normalmente en BPM.',
        evidenceRequired: 'tempo.bpm > 0 y tempo.confidence >= 0.5',
        allowedWhen: ['tempo detectado'],
        forbiddenWhen: [],
        pedagogicalUse: 'Usar BPM concreto SOLO si sirve para practicar (ej. metrónomo objetivo).',
        styles: ['*'],
        relatedTerms: ['pulso', 'estabilidad_del_pulso'],
    },
    pulso: {
        id: 'pulso', term: 'Pulso', aliases: [],
        category: 'time', level: 'observable',
        definition: 'Referencia regular que organiza los tiempos.',
        evidenceRequired: 'beat.stability disponible',
        allowedWhen: ['beat detectado'],
        forbiddenWhen: [],
        pedagogicalUse: 'Hablar de estabilidad si los datos la respaldan; no inventar sensación de pulso.',
        styles: ['*'],
        relatedTerms: ['tempo', 'estabilidad_del_pulso'],
    },
    estabilidad_del_pulso: {
        id: 'estabilidad_del_pulso', term: 'Estabilidad del pulso', aliases: [],
        category: 'time', level: 'observable',
        definition: 'Grado en que el pulso se mantiene consistente durante la toma.',
        evidenceRequired: 'rushDrag / beat.stability',
        allowedWhen: ['rushDrag calculable'],
        forbiddenWhen: [],
        pedagogicalUse: 'Reportá dirección concreta (rushing/dragging/estable) con timestamps si aplica.',
        styles: ['*'],
        relatedTerms: ['pulso', 'tempo'],
    },
    subdivision: {
        id: 'subdivision', term: 'Subdivisión', aliases: [],
        category: 'time', level: 'interpretative',
        definition: 'División interna del pulso en unidades menores.',
        evidenceRequired: 'Patrón rítmico suficientemente claro o observación auditiva.',
        allowedWhen: ['auditoryObservations con evidencia rítmica'],
        forbiddenWhen: ['transcription.level unreliable sin escucha'],
        pedagogicalUse: 'Solo si hay evidencia auditiva o patrón inequívoco.',
        styles: ['*'],
        relatedTerms: ['ritmo', 'pulso'],
    },
    densidad_ritmica: {
        id: 'densidad_ritmica', term: 'Densidad rítmica', aliases: ['densidad'],
        category: 'time', level: 'observable',
        definition: 'Concentración de eventos musicales por unidad de tiempo.',
        evidenceRequired: 'notes.notesPerSecond',
        allowedWhen: ['densidad muy baja o baja (reportable en piano)', 'densidad alta corroborada por otra señal reliable'],
        forbiddenWhen: ['densidad alta sola en piano (es la norma)'],
        pedagogicalUse: 'En piano solo, alta/muy alta = normal. Reportar solo si baja o si otra señal reliable la corrobora como problema.',
        styles: ['*'],
        relatedTerms: ['densidad_textural', 'silencio'],
    },
    silencio: {
        id: 'silencio', term: 'Silencio', aliases: ['espacio', 'reposo'],
        category: 'time', level: 'observable',
        definition: 'Ausencia de eventos durante un intervalo.',
        evidenceRequired: 'silence.silenceRatio',
        allowedWhen: ['silence disponible'],
        forbiddenWhen: [],
        pedagogicalUse: 'Silencios frecuentes ≠ problema — puede ser respiración musical deliberada.',
        styles: ['*'],
        relatedTerms: ['respiracion_musical', 'continuidad'],
    },
    sincopa: {
        id: 'sincopa', term: 'Síncopa', aliases: [],
        category: 'time', level: 'advanced',
        definition: 'Desplazamiento o énfasis de un ataque respecto de posiciones métricamente fuertes.',
        evidenceRequired: 'Patrón rítmico claro (transcripción reliable) o escucha.',
        allowedWhen: ['transcription reliable + patrón identificable'],
        forbiddenWhen: ['transcription unreliable sin escucha'],
        pedagogicalUse: 'No usar solo porque hay síncopas → no implica son cubano automáticamente.',
        styles: ['*'],
        relatedTerms: ['contratiempo', 'anticipacion'],
    },
    contratiempo: {
        id: 'contratiempo', term: 'Contratiempo', aliases: [],
        category: 'time', level: 'advanced',
        definition: 'Ataque en parte débil del pulso o entre pulsos fuertes.',
        evidenceRequired: 'Patrón temporal claro.',
        allowedWhen: ['transcription reliable o escucha'],
        forbiddenWhen: [],
        pedagogicalUse: 'Reportar con timestamp cuando sea posible.',
        styles: ['*'],
        relatedTerms: ['sincopa'],
    },
    anticipacion: {
        id: 'anticipacion', term: 'Anticipación', aliases: [],
        category: 'time', level: 'advanced',
        definition: 'Entrada de una nota o acorde antes del punto métrico esperado.',
        evidenceRequired: 'Relación temporal con estructura métrica.',
        allowedWhen: ['transcription + estructura métrica identificable'],
        forbiddenWhen: [],
        pedagogicalUse: 'Requiere estructura métrica clara.',
        styles: ['*'],
        relatedTerms: ['sincopa'],
    },
    acento: {
        id: 'acento', term: 'Acento', aliases: [],
        category: 'time', level: 'interpretative',
        definition: 'Énfasis perceptible sobre un evento respecto de otros.',
        evidenceRequired: 'Dinámica + posición temporal, o escucha.',
        allowedWhen: ['dynSpread reliable o auditoryObservations'],
        forbiddenWhen: [],
        pedagogicalUse: 'Ubicalo temporalmente (segundo o compás).',
        styles: ['*'],
        relatedTerms: ['contraste_dinamico'],
    },
    swing: {
        id: 'swing', term: 'Swing', aliases: ['swing feel', 'shuffle'],
        category: 'time', level: 'advanced',
        definition: 'Tratamiento característico de la subdivisión asociado al lenguaje jazzístico.',
        evidenceRequired: 'Escucha (auditoryObservations) o contexto estilístico declarado.',
        allowedWhen: ['auditoryObservations disponibles', 'estilo jazz declarado'],
        forbiddenWhen: [],
        pedagogicalUse: 'Sin escucha, hablar tentativamente ("podría tratarse como swing según el estilo").',
        styles: ['bebop', 'hardbop', 'blues', 'latinjazz'],
        relatedTerms: ['swing_feel', 'straight_eighths'],
    },
    straight_eighths: {
        id: 'straight_eighths', term: 'Corcheas rectas', aliases: [],
        category: 'time', level: 'interpretative',
        definition: 'Subdivisión regular de corcheas sin tratamiento de swing.',
        evidenceRequired: 'Patrón temporal/auditivo.',
        allowedWhen: ['transcription reliable o auditoryObservations'],
        forbiddenWhen: [],
        pedagogicalUse: 'Útil como contraste con swing.',
        styles: ['latinjazz', 'soncubano', 'jazzcolombiano'],
        relatedTerms: ['swing'],
    },
    tresillo: {
        id: 'tresillo', term: 'Tresillo', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Célula rítmica de tres ataques dentro de subdivisión binaria.',
        evidenceRequired: 'Patrón rítmico claro (transcripción o escucha).',
        allowedWhen: ['transcription reliable', 'auditoryObservations'],
        forbiddenWhen: [],
        pedagogicalUse: 'Base rítmica; útil para hablar de organización afrocubana.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['clave', 'cinquillo'],
    },
    cinquillo: {
        id: 'cinquillo', term: 'Cinquillo', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Célula sincopada de cinco ataques característica de contextos afrocaribeños.',
        evidenceRequired: 'Patrón específico + contexto estilístico.',
        allowedWhen: ['patrón identificable + estilo afrocubano'],
        forbiddenWhen: [],
        pedagogicalUse: 'Solo si el patrón es reconocible; no confundir con tresillo.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['tresillo', 'clave'],
    },

    // ─── B. Dinámica y expresión ─────────────────────────────────────────
    dinamica: {
        id: 'dinamica', term: 'Dinámica', aliases: ['volumen', 'intensidad'],
        category: 'dynamics', level: 'observable',
        definition: 'Variación de intensidad sonora a lo largo de la interpretación.',
        evidenceRequired: 'loudness.dynamicComplexity',
        allowedWhen: ['loudness disponible'],
        forbiddenWhen: [],
        pedagogicalUse: 'Reportar variación relativa; no dar dB al usuario.',
        styles: ['*'],
        relatedTerms: ['contraste_dinamico', 'dinamica_plana'],
    },
    contraste_dinamico: {
        id: 'contraste_dinamico', term: 'Contraste dinámico', aliases: [],
        category: 'dynamics', level: 'observable',
        definition: 'Diferencia perceptible entre niveles de intensidad.',
        evidenceRequired: 'notes.dynamicVariationCV o loudness variabilidad',
        allowedWhen: ['dynSpread reliable'],
        forbiddenWhen: [],
        pedagogicalUse: 'Anclar temporalmente si hay tramos con perfiles distintos.',
        styles: ['*'],
        relatedTerms: ['dinamica'],
    },
    dinamica_plana: {
        id: 'dinamica_plana', term: 'Dinámica poco variada', aliases: [],
        category: 'dynamics', level: 'observable',
        definition: 'Poca diferenciación de intensidad entre eventos o frases.',
        evidenceRequired: 'dynamicVariationCV bajo Y contexto (evitar diagnosticar plano = malo).',
        allowedWhen: ['CV < 0.15 y no es rubato deliberado'],
        forbiddenWhen: ['pieza tipo bolero rubato'],
        pedagogicalUse: 'Nunca "tocás sin expresión" — decir "dinámica global poco variada".',
        styles: ['*'],
        relatedTerms: ['dinamica'],
    },
    fraseo: {
        id: 'fraseo', term: 'Fraseo', aliases: [],
        category: 'expression', level: 'interpretative',
        definition: 'Forma en que el intérprete organiza y dirige una idea musical.',
        evidenceRequired: 'Datos + idealmente escucha.',
        allowedWhen: ['auditoryObservations o estructura clara'],
        forbiddenWhen: [],
        pedagogicalUse: 'Preferí "dirección de la frase" a diagnósticos totalizadores.',
        styles: ['*'],
        relatedTerms: ['frase', 'articulacion'],
    },
    articulacion: {
        id: 'articulacion', term: 'Articulación', aliases: [],
        category: 'expression', level: 'advanced',
        definition: 'Forma en que se conectan o separan las notas (legato / staccato / etc.).',
        evidenceRequired: 'Evidencia AUDITIVA (Gemini). Duraciones MIDI no bastan.',
        allowedWhen: ['auditoryObservations con evidencia de ataque/separación'],
        forbiddenWhen: ['solo duraciones estimadas por basic-pitch'],
        pedagogicalUse: 'Duraciones cortas ≠ staccato. Decir "notas breves detectadas" salvo escucha.',
        styles: ['*'],
        relatedTerms: ['ataque'],
    },
    ataque: {
        id: 'ataque', term: 'Ataque', aliases: [],
        category: 'expression', level: 'interpretative',
        definition: 'Características del inicio de una nota.',
        evidenceRequired: 'Observación auditiva.',
        allowedWhen: ['auditoryObservations'],
        forbiddenWhen: [],
        pedagogicalUse: 'Necesita escucha; no inferir de MIDI.',
        styles: ['*'],
        relatedTerms: ['articulacion'],
    },
    registro: {
        id: 'registro', term: 'Registro', aliases: ['zona'],
        category: 'expression', level: 'observable',
        definition: 'Zona grave, media o aguda en la que se desarrolla la música.',
        evidenceRequired: 'notes con lowestName/highestName.',
        allowedWhen: ['transcription reliable'],
        forbiddenWhen: [],
        pedagogicalUse: 'Reportar con nombre de nota (ej. G1–G5).',
        styles: ['*'],
        relatedTerms: ['rango'],
    },
    rango: {
        id: 'rango', term: 'Rango', aliases: [],
        category: 'expression', level: 'observable',
        definition: 'Extensión entre nota más grave y más aguda.',
        evidenceRequired: 'Transcripción reliable.',
        allowedWhen: ['transcription reliable'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Piano tiene 88 teclas — rango amplio es normal. Solo destacar si <2 octavas o relevante al estilo.',
        styles: ['*'],
        relatedTerms: ['registro'],
    },
    densidad_textural: {
        id: 'densidad_textural', term: 'Densidad textural', aliases: [],
        category: 'expression', level: 'interpretative',
        definition: 'Cantidad de información musical simultánea o muy próxima.',
        evidenceRequired: 'Eventos/notas + juicio.',
        allowedWhen: ['notes disponibles'],
        forbiddenWhen: [],
        pedagogicalUse: 'Distinto de densidad rítmica pura; enfatiza capas.',
        styles: ['*'],
        relatedTerms: ['densidad_ritmica', 'textura'],
    },
    respiracion_musical: {
        id: 'respiracion_musical', term: 'Respiración musical', aliases: [],
        category: 'expression', level: 'interpretative',
        definition: 'Espacios que separan y organizan ideas musicales.',
        evidenceRequired: 'Silencios + escucha.',
        allowedWhen: ['silence disponible'],
        forbiddenWhen: [],
        pedagogicalUse: 'Marco pedagógico para hablar de silencios entre frases.',
        styles: ['*'],
        relatedTerms: ['silencio', 'frase'],
    },
    rubato: {
        id: 'rubato', term: 'Rubato', aliases: [],
        category: 'expression', level: 'advanced',
        definition: 'Flexibilidad expresiva del tiempo sin necesariamente perder la estructura del pulso.',
        evidenceRequired: 'Variación temporal + escucha, y estilo compatible.',
        allowedWhen: ['bolero declarado', 'auditoryObservations con evidencia'],
        forbiddenWhen: ['bebop / son cubano groove constante'],
        pedagogicalUse: 'Si el pulso es inestable en un estilo groove-based, NO es rubato — es inestabilidad.',
        styles: ['bolero', 'blues'],
        relatedTerms: ['rubato_bolero'],
    },

    // ─── C. Melodía y frases ────────────────────────────────────────────
    motivo: {
        id: 'motivo', term: 'Motivo', aliases: [],
        category: 'melody', level: 'advanced',
        definition: 'Idea musical breve que puede repetirse o desarrollarse.',
        evidenceRequired: 'Patrón melódico/rítmico repetido reconocible.',
        allowedWhen: ['transcription reliable + patrón repetido'],
        forbiddenWhen: ['transcription unreliable', 'melody.status unknown'],
        pedagogicalUse: 'Nunca inferir motivo de una única aparición.',
        styles: ['*'],
        relatedTerms: ['frase', 'celula_melodica'],
    },
    frase: {
        id: 'frase', term: 'Frase', aliases: [],
        category: 'melody', level: 'interpretative',
        definition: 'Unidad musical con dirección y sensación de cierre.',
        evidenceRequired: 'Estructura temporal + idealmente escucha.',
        allowedWhen: ['auditoryObservations o silencios estructurales'],
        forbiddenWhen: [],
        pedagogicalUse: 'Preferí "idea musical" cuando no hay estructura clara.',
        styles: ['*'],
        relatedTerms: ['motivo', 'fraseo', 'respiracion_musical'],
    },
    contorno_melodico: {
        id: 'contorno_melodico', term: 'Contorno melódico', aliases: [],
        category: 'melody', level: 'interpretative',
        definition: 'Trayectoria general ascendente, descendente o mixta de una línea.',
        evidenceRequired: 'Transcripción suficientemente fiable Y evidencia de línea melódica.',
        allowedWhen: ['transcription reliable + melody detectable'],
        forbiddenWhen: ['melody.status unknown'],
        pedagogicalUse: 'No inferir "melodía" solo por nota más aguda.',
        styles: ['*'],
        relatedTerms: ['fraseo', 'movimiento_conjunto'],
    },
    cromatismo: {
        id: 'cromatismo', term: 'Cromatismo', aliases: [],
        category: 'melody', level: 'advanced',
        definition: 'Uso de alturas cromáticas dentro de un contexto tonal.',
        evidenceRequired: 'Notas fiables + contexto tonal.',
        allowedWhen: ['transcription reliable + key reliability >= medium'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Cromatismo aislado ≠ bebop.',
        styles: ['bebop', 'hardbop', 'blues'],
        relatedTerms: ['aproximacion_cromatica', 'encierro'],
    },
    aproximacion_cromatica: {
        id: 'aproximacion_cromatica', term: 'Aproximación cromática', aliases: ['approach note cromática'],
        category: 'melody', level: 'advanced',
        definition: 'Nota situada cromáticamente antes de una nota objetivo.',
        evidenceRequired: 'Patrón melódico identificable + nota objetivo.',
        allowedWhen: ['transcription reliable + estilo bebop/hardbop declarado'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Requiere identificar la nota objetivo.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['approach_note', 'encierro'],
    },
    encierro: {
        id: 'encierro', term: 'Encierro cromático', aliases: ['enclosure'],
        category: 'melody', level: 'advanced',
        definition: 'Aproximación a una nota objetivo desde arriba y abajo antes de resolver.',
        evidenceRequired: 'Patrón melódico específico.',
        allowedWhen: ['transcription reliable + patrón identificable'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Muy específico — no usar sin patrón inequívoco.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['enclosure', 'aproximacion_cromatica'],
    },
    tension: {
        id: 'tension', term: 'Tensión', aliases: [],
        category: 'melody', level: 'advanced',
        definition: 'Sonoridad que genera expectativa de movimiento o resolución.',
        evidenceRequired: 'Contexto armónico/melódico.',
        allowedWhen: ['key reliability >= medium', 'auditoryObservations'],
        forbiddenWhen: [],
        pedagogicalUse: 'Concepto pedagógico; pareado con resolución.',
        styles: ['*'],
        relatedTerms: ['resolucion', 'tension_resolution'],
    },
    resolucion: {
        id: 'resolucion', term: 'Resolución', aliases: [],
        category: 'melody', level: 'advanced',
        definition: 'Movimiento que lleva una tensión hacia una sonoridad más estable.',
        evidenceRequired: 'Relación musical clara.',
        allowedWhen: ['key reliability >= medium'],
        forbiddenWhen: [],
        pedagogicalUse: 'Pareado con tensión.',
        styles: ['*'],
        relatedTerms: ['tension'],
    },
    nota_de_paso: {
        id: 'nota_de_paso', term: 'Nota de paso', aliases: [],
        category: 'melody', level: 'advanced',
        definition: 'Nota no estructural que conecta dos estructurales por movimiento conjunto.',
        evidenceRequired: 'Contexto melódico + estructura tonal.',
        allowedWhen: ['transcription reliable + key reliability >= medium'],
        forbiddenWhen: [],
        pedagogicalUse: 'Útil para hablar de jerarquía dentro de la frase.',
        styles: ['*'],
        relatedTerms: ['nota_objetivo', 'movimiento_conjunto'],
    },

    // ─── D. Armonía ─────────────────────────────────────────────────────
    tonalidad: {
        id: 'tonalidad', term: 'Tonalidad', aliases: ['centro tonal'],
        category: 'harmony', level: 'advanced',
        definition: 'Organización de alturas alrededor de un centro tonal.',
        evidenceRequired: 'key.reliability = high.',
        allowedWhen: ['key.reliability high'],
        forbiddenWhen: ['key.reliability low o unreliable'],
        pedagogicalUse: 'Solo si key.reliability es high. Si es medium, decir "el análisis sugiere un centro".',
        styles: ['*'],
        relatedTerms: ['centro_tonal', 'tonica'],
    },
    centro_tonal: {
        id: 'centro_tonal', term: 'Centro tonal', aliases: [],
        category: 'harmony', level: 'interpretative',
        definition: 'Altura o región que funciona como referencia tonal.',
        evidenceRequired: 'Análisis tonal suficiente.',
        allowedWhen: ['key.reliability >= medium'],
        forbiddenWhen: ['key.reliability unreliable'],
        pedagogicalUse: 'Alternativa suave a "tonalidad" cuando la certeza no es alta.',
        styles: ['*'],
        relatedTerms: ['tonalidad'],
    },
    acorde: {
        id: 'acorde', term: 'Acorde', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Conjunto de alturas simultáneas que forman una estructura armónica.',
        evidenceRequired: 'Notas simultáneas fiables.',
        allowedWhen: ['transcription reliable + notas simultáneas'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'No cifrar un acorde sin evidencia MIDI de notas simultáneas.',
        styles: ['*'],
        relatedTerms: ['triada', 'voicing'],
    },
    voicing: {
        id: 'voicing', term: 'Voicing', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Disposición concreta de las notas de un acorde.',
        evidenceRequired: 'Varias notas simultáneas fiables.',
        allowedWhen: ['transcription reliable + acordes visibles'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Nunca "usaste rootless voicing" solo por "pocas notas".',
        styles: ['*'],
        relatedTerms: ['shell_voicing', 'rootless_voicing', 'drop_2'],
    },
    guide_tones: {
        id: 'guide_tones', term: 'Guide tones', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Tercera y séptima de acordes de séptima; importantes para función y conducción.',
        evidenceRequired: 'Acordes identificados (progresión de jazz).',
        allowedWhen: ['transcription reliable + acordes de séptima identificables + estilo jazz'],
        forbiddenWhen: ['transcription unreliable', 'sin contexto jazz'],
        pedagogicalUse: 'Reservado para jazz con acordes de 7ma. No etiquetar cualquier 3ra/5ta.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['ii_V_I', 'conduccion_de_voces'],
    },
    ii_V_I: {
        id: 'ii_V_I', term: 'ii–V–I', aliases: ['dos cinco uno'],
        category: 'harmony', level: 'advanced',
        definition: 'Progresión característica del lenguaje jazzístico.',
        evidenceRequired: 'Progresión armónica identificable.',
        allowedWhen: ['transcription reliable + key reliability high + estilo jazz'],
        forbiddenWhen: ['transcription unreliable', 'key.reliability low'],
        pedagogicalUse: 'NO afirmar por estilo declarado; requiere evidencia armónica.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['guide_tones', 'sustitucion_tritono'],
    },
    sustitucion_tritono: {
        id: 'sustitucion_tritono', term: 'Sustitución de tritono', aliases: ['tritone sub'],
        category: 'harmony', level: 'advanced',
        definition: 'Sustitución de un dominante por otro dominante a tritono de distancia.',
        evidenceRequired: 'Progresión armónica fiable con dominantes claros.',
        allowedWhen: ['transcription reliable + progresión de jazz identificable'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Muy específico. No mencionar sin evidencia armónica clara.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['ii_V_I', 'dominante'],
    },
    dominante: {
        id: 'dominante', term: 'Dominante', aliases: ['V7'],
        category: 'harmony', level: 'advanced',
        definition: 'Función con fuerte tendencia hacia la tónica (V7 en armonía tonal).',
        evidenceRequired: 'Progresión identificada.',
        allowedWhen: ['key.reliability high + transcription reliable'],
        forbiddenWhen: ['key.reliability low'],
        pedagogicalUse: 'Función, no solo acorde.',
        styles: ['*'],
        relatedTerms: ['tonica', 'ii_V_I'],
    },
    tonica: {
        id: 'tonica', term: 'Tónica', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Centro funcional principal de una tonalidad.',
        evidenceRequired: 'Tonalidad fiable.',
        allowedWhen: ['key.reliability high'],
        forbiddenWhen: ['key.reliability low'],
        pedagogicalUse: 'Usar con nombre de nota si se afirma.',
        styles: ['*'],
        relatedTerms: ['tonalidad', 'dominante'],
    },
    reharmonizacion: {
        id: 'reharmonizacion', term: 'Reharmonización', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Modificación de la armonía original conservando o reinterpretando su función.',
        evidenceRequired: 'Contexto armónico original conocido.',
        allowedWhen: ['tune conocido + transcription reliable'],
        forbiddenWhen: ['sin referencia armónica original'],
        pedagogicalUse: 'Poco frecuente que la app pueda usarlo con seguridad.',
        styles: ['bebop', 'hardbop', 'latinjazz', 'bolero'],
        relatedTerms: ['acorde_sustituto'],
    },
    conduccion_de_voces: {
        id: 'conduccion_de_voces', term: 'Conducción de voces', aliases: ['voice leading'],
        category: 'harmony', level: 'advanced',
        definition: 'Movimiento de las voces individuales entre acordes.',
        evidenceRequired: 'Progresión armónica identificada.',
        allowedWhen: ['transcription reliable + acordes sucesivos identificables'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Concepto clásico y jazzístico.',
        styles: ['*'],
        relatedTerms: ['guide_tones', 'voicing'],
    },
    pedal_armonico: {
        id: 'pedal_armonico', term: 'Pedal armónico', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Nota sostenida o repetida mientras cambia la armonía superior.',
        evidenceRequired: 'Nota persistente + armonía cambiante.',
        allowedWhen: ['transcription reliable con evidencia de nota persistente'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Distinto de "pedal" (uso del pedal físico).',
        styles: ['*'],
        relatedTerms: ['ostinato'],
    },
    ostinato: {
        id: 'ostinato', term: 'Ostinato', aliases: [],
        category: 'harmony', level: 'advanced',
        definition: 'Patrón melódico, rítmico o armónico repetido persistentemente.',
        evidenceRequired: 'Repetición identificable.',
        allowedWhen: ['transcription reliable + patrón claramente repetido'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'No confundir con simple repetición de notas.',
        styles: ['*'],
        relatedTerms: ['pedal_armonico', 'guajeo'],
    },

    // ─── E. Lenguaje jazz ────────────────────────────────────────────────
    bebop_scale: {
        id: 'bebop_scale', term: 'Bebop scale', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Escala con nota cromática de paso para colocar tonos del acorde en tiempos fuertes.',
        evidenceRequired: 'Patrón escalar identificable + estilo bebop.',
        allowedWhen: ['transcription reliable + estilo bebop/hardbop + patrón visible'],
        forbiddenWhen: ['transcription unreliable', 'sin estilo bebop declarado'],
        pedagogicalUse: 'Estilo declarado NO basta — necesita patrón visible.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['approach_note', 'chord_tone'],
    },
    swing_feel: {
        id: 'swing_feel', term: 'Swing feel', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Tratamiento de la subdivisión y del fraseo asociado al swing.',
        evidenceRequired: 'Escucha.',
        allowedWhen: ['auditoryObservations reliable'],
        forbiddenWhen: ['sin escucha'],
        pedagogicalUse: 'Sin escucha directa, hablar tentativamente por contexto.',
        styles: ['bebop', 'hardbop', 'blues'],
        relatedTerms: ['swing', 'time_feel'],
    },
    approach_note: {
        id: 'approach_note', term: 'Nota de aproximación', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Nota utilizada para aproximarse a un tono objetivo.',
        evidenceRequired: 'Patrón melódico + tono objetivo identificable.',
        allowedWhen: ['transcription reliable + patrón melódico'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Se usa junto con chord tones y enclosures.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['enclosure', 'chord_tone'],
    },
    enclosure: {
        id: 'enclosure', term: 'Enclosure', aliases: ['encierro'],
        category: 'jazz', level: 'advanced',
        definition: 'Rodeo de una nota objetivo mediante notas superiores e inferiores.',
        evidenceRequired: 'Patrón melódico específico identificable.',
        allowedWhen: ['transcription reliable + patrón inequívoco'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Muy específico — evitar salvo evidencia clara.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['approach_note', 'encierro'],
    },
    chord_tone: {
        id: 'chord_tone', term: 'Nota del acorde', aliases: ['chord tone'],
        category: 'jazz', level: 'advanced',
        definition: 'Nota que pertenece a la estructura del acorde subyacente.',
        evidenceRequired: 'Acorde identificado.',
        allowedWhen: ['transcription reliable + acordes identificables'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Concepto fundamental del vocabulario jazzístico.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['guide_tones', 'approach_note'],
    },
    playing_the_changes: {
        id: 'playing_the_changes', term: 'Playing the changes', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Construcción melódica que sigue activamente la progresión armónica.',
        evidenceRequired: 'Melodía + armonía identificables.',
        allowedWhen: ['melody.status !== unknown + key.reliability high'],
        forbiddenWhen: ['melody.status unknown', 'key.reliability low'],
        pedagogicalUse: 'Objetivo pedagógico del lenguaje bebop.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['ii_V_I', 'chord_tone'],
    },
    tension_resolution: {
        id: 'tension_resolution', term: 'Tensión-resolución', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Organización de tensión y relajación dentro de una línea o progresión.',
        evidenceRequired: 'Evidencia armónica/melódica.',
        allowedWhen: ['key.reliability >= medium'],
        forbiddenWhen: [],
        pedagogicalUse: 'Concepto guía; útil pedagógicamente incluso sin cifrado exacto.',
        styles: ['*'],
        relatedTerms: ['tension', 'resolucion'],
    },
    call_response: {
        id: 'call_response', term: 'Call and response', aliases: ['pregunta-respuesta'],
        category: 'jazz', level: 'advanced',
        definition: 'Relación de pregunta-respuesta entre frases o capas.',
        evidenceRequired: 'Patrón de frases identificable.',
        allowedWhen: ['auditoryObservations o estructura clara'],
        forbiddenWhen: [],
        pedagogicalUse: 'Común en blues y jazz.',
        styles: ['blues', 'bebop', 'hardbop'],
        relatedTerms: ['frase_antecedente', 'frase_consecuente'],
    },

    // ─── F. Piano jazz ────────────────────────────────────────────────────
    shell_voicing: {
        id: 'shell_voicing', term: 'Shell voicing', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Voicing reducido que enfatiza raíz y/o tercera y séptima.',
        evidenceRequired: 'Estructura armónica fiable.',
        allowedWhen: ['transcription reliable + acordes visibles con guide tones'],
        forbiddenWhen: ['transcription unreliable', 'solo por "pocas notas"'],
        pedagogicalUse: 'Pocas notas ≠ shell voicing automático.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['voicing', 'rootless_voicing'],
    },
    rootless_voicing: {
        id: 'rootless_voicing', term: 'Rootless voicing', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Voicing que omite la fundamental (habitual cuando otro elemento la cumple).',
        evidenceRequired: 'Estructura armónica + contexto instrumental.',
        allowedWhen: ['transcription reliable + evidencia de omisión de fundamental + contexto conjunto'],
        forbiddenWhen: ['transcription unreliable', 'solo por omisión aislada'],
        pedagogicalUse: 'Muy específico — no confundir con "no vi la raíz".',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['voicing', 'shell_voicing'],
    },
    drop_2: {
        id: 'drop_2', term: 'Drop 2', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Disposición donde una voz se desplaza una octava.',
        evidenceRequired: 'Voicing identificable con estructura clara.',
        allowedWhen: ['transcription reliable + estructura de voicing evidente'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Concepto técnico específico.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['voicing'],
    },
    quartal_voicing: {
        id: 'quartal_voicing', term: 'Voicing cuartal', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Voicing construido principalmente mediante cuartas.',
        evidenceRequired: 'Intervalos identificables + contexto armónico.',
        allowedWhen: ['transcription reliable + intervalos claros'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Común en modal jazz.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['voicing', 'modal'],
    },
    comping: {
        id: 'comping', term: 'Comping', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Acompañamiento rítmico-armónico que sostiene e interactúa con la línea principal.',
        evidenceRequired: 'Patrón armónico/rítmico + contexto de acompañamiento.',
        allowedWhen: ['auditoryObservations o patrón identificable en MI'],
        forbiddenWhen: ['sin evidencia de separación de roles'],
        pedagogicalUse: 'Requiere reconocer el rol de acompañamiento.',
        styles: ['bebop', 'hardbop', 'latinjazz'],
        relatedTerms: ['comping_rhythm', 'walking_bass'],
    },
    walking_bass: {
        id: 'walking_bass', term: 'Walking bass', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Línea de bajo continua que articula pulso y armonía.',
        evidenceRequired: 'Bajo claramente separado + patrón identificable.',
        allowedWhen: ['transcription reliable + melody.status !== unknown', 'auditoryObservations'],
        forbiddenWhen: ['melody.status unknown'],
        pedagogicalUse: 'No inferir bajo por "nota más grave" únicamente.',
        styles: ['bebop', 'hardbop'],
        relatedTerms: ['comping', 'bajo_armonico'],
    },
    stride: {
        id: 'stride', term: 'Stride', aliases: [],
        category: 'piano', level: 'advanced',
        definition: 'Acompañamiento con amplio desplazamiento entre bajo y acordes en la mano izquierda.',
        evidenceRequired: 'Patrón claro de mano izquierda.',
        allowedWhen: ['auditoryObservations o transcription reliable con separación de manos'],
        forbiddenWhen: ['sin evidencia de separación de manos'],
        pedagogicalUse: 'Específico de contextos históricos (jazz de piano solo).',
        styles: ['blues', 'bebop'],
        relatedTerms: ['comping'],
    },

    // ─── G. Son cubano / afrocubano / Latin Jazz ─────────────────────────
    clave: {
        id: 'clave', term: 'Clave', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Patrón rítmico de dos compases que organiza gran parte de la estructura afrocubana.',
        evidenceRequired: 'Patrón rítmico claro (auditivo o transcripción).',
        allowedWhen: ['auditoryObservations', 'estilo afrocubano + patrón identificable'],
        forbiddenWhen: ['solo por síncopas'],
        pedagogicalUse: 'No decir "está en clave" solo porque hay síncopas.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['clave_2_3', 'clave_3_2', 'son_clave'],
    },
    clave_2_3: {
        id: 'clave_2_3', term: 'Clave 2-3', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Orientación en la que el lado de dos golpes precede al de tres.',
        evidenceRequired: 'Patrón de clave identificado + métrica.',
        allowedWhen: ['clave identificada + orientación clara'],
        forbiddenWhen: [],
        pedagogicalUse: 'Orientación específica; no confundir con clave_3_2.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['clave', 'clave_3_2'],
    },
    clave_3_2: {
        id: 'clave_3_2', term: 'Clave 3-2', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Orientación en la que el lado de tres precede al de dos.',
        evidenceRequired: 'Patrón de clave identificado + métrica.',
        allowedWhen: ['clave identificada + orientación clara'],
        forbiddenWhen: [],
        pedagogicalUse: 'Orientación específica; no confundir con clave_2_3.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['clave', 'clave_2_3'],
    },
    montuno: {
        id: 'montuno', term: 'Montuno', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Sección repetitiva del son (o patrón pianístico asociado a esa sección).',
        evidenceRequired: 'Contexto formal/estilístico + patrón repetido.',
        allowedWhen: ['estilo soncubano + patrón claro'],
        forbiddenWhen: ['solo por "patrón repetitivo"'],
        pedagogicalUse: 'Polisémico — aclarar si es la sección o el patrón pianístico.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['guajeo', 'piano_tumbao', 'son_montuno'],
    },
    piano_tumbao: {
        id: 'piano_tumbao', term: 'Tumbao de piano', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Patrón rítmico-melódico repetitivo del piano en géneros afrocubanos.',
        evidenceRequired: 'Patrón pianístico + contexto estilístico.',
        allowedWhen: ['estilo afrocubano + patrón pianístico identificable'],
        forbiddenWhen: ['solo por patrón repetitivo aislado'],
        pedagogicalUse: 'Distinto de tumbao_bajo. NO sinónimo de montuno.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['tumbao_bajo', 'montuno', 'guajeo'],
    },
    tumbao_bajo: {
        id: 'tumbao_bajo', term: 'Tumbao de bajo', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Patrón rítmico característico del bajo en géneros afrocubanos.',
        evidenceRequired: 'Bajo identificado + patrón.',
        allowedWhen: ['bajo separable + patrón claro'],
        forbiddenWhen: ['melody.status unknown', 'sin evidencia de rol de bajo'],
        pedagogicalUse: 'NO inferir bajo por "nota más grave".',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['piano_tumbao', 'walking_bass'],
    },
    guajeo: {
        id: 'guajeo', term: 'Guajeo', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Patrón ostinato sincopado asociado al tres y al piano en música afrocubana.',
        evidenceRequired: 'Patrón repetitivo + contexto estilístico.',
        allowedWhen: ['estilo afrocubano + patrón identificable'],
        forbiddenWhen: ['solo por patrón repetitivo'],
        pedagogicalUse: 'Relacionado con montuno y tumbao pero NO sinónimo.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['montuno', 'piano_tumbao', 'ostinato'],
    },
    independencia_ritmica: {
        id: 'independencia_ritmica', term: 'Independencia rítmica', aliases: ['independencia de manos'],
        category: 'afrocuban', level: 'interpretative',
        definition: 'Capacidad de mantener funciones rítmicas diferentes entre manos/capas.',
        evidenceRequired: 'Dos capas rítmicas identificables.',
        allowedWhen: ['auditoryObservations con evidencia de dos capas', 'transcription reliable con separación de manos'],
        forbiddenWhen: [],
        pedagogicalUse: 'Fundamental en soncubano/latinjazz.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['interlocking'],
    },
    interlocking: {
        id: 'interlocking', term: 'Interlocking', aliases: [],
        category: 'afrocuban', level: 'advanced',
        definition: 'Encaje complementario de patrones entre diferentes capas.',
        evidenceRequired: 'Varias capas rítmicas identificables.',
        allowedWhen: ['auditoryObservations con múltiples capas'],
        forbiddenWhen: [],
        pedagogicalUse: 'Requiere evidencia de más de una capa.',
        styles: ['soncubano', 'latinjazz'],
        relatedTerms: ['independencia_ritmica'],
    },

    // ─── H. Bolero ────────────────────────────────────────────────────────
    fraseo_bolero: {
        id: 'fraseo_bolero', term: 'Fraseo de bolero', aliases: [],
        category: 'bolero', level: 'advanced',
        definition: 'Tratamiento expresivo y cantabile de la línea propia del bolero.',
        evidenceRequired: 'Escucha + contexto de estilo declarado.',
        allowedWhen: ['bolero declarado + auditoryObservations'],
        forbiddenWhen: ['sin estilo declarado'],
        pedagogicalUse: 'Requiere estilo bolero declarado.',
        styles: ['bolero'],
        relatedTerms: ['expresividad_melodica', 'cantabile'],
    },
    rubato_bolero: {
        id: 'rubato_bolero', term: 'Rubato en bolero', aliases: [],
        category: 'bolero', level: 'advanced',
        definition: 'Flexibilidad temporal utilizada expresivamente en el bolero.',
        evidenceRequired: 'Variación temporal + escucha en contexto bolero.',
        allowedWhen: ['bolero declarado + rushDrag con variación + auditoryObservations'],
        forbiddenWhen: ['sin estilo bolero'],
        pedagogicalUse: 'Distinto de inestabilidad de pulso.',
        styles: ['bolero'],
        relatedTerms: ['rubato'],
    },
    expresividad_melodica: {
        id: 'expresividad_melodica', term: 'Expresividad melódica', aliases: [],
        category: 'bolero', level: 'advanced',
        definition: 'Uso de dinámica, tiempo y articulación para dirigir la melodía.',
        evidenceRequired: 'Escucha o combinación de datos + estilo.',
        allowedWhen: ['auditoryObservations', 'bolero declarado + dinámica variada'],
        forbiddenWhen: [],
        pedagogicalUse: 'Común en bolero.',
        styles: ['bolero'],
        relatedTerms: ['cantabile', 'fraseo_bolero'],
    },
    arpegio_acompanamiento: {
        id: 'arpegio_acompanamiento', term: 'Acompañamiento arpegiado', aliases: [],
        category: 'bolero', level: 'advanced',
        definition: 'Acompañamiento que despliega sucesivamente las notas del acorde.',
        evidenceRequired: 'Patrón de notas identificable.',
        allowedWhen: ['transcription reliable + patrón arpegiado'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Común en bolero clásico.',
        styles: ['bolero'],
        relatedTerms: ['arpegio', 'acompanamiento'],
    },

    // ─── I. Jazz colombiano ───────────────────────────────────────────────
    bambuco: {
        id: 'bambuco', term: 'Bambuco', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Aire/género tradicional colombiano con variantes regionales.',
        evidenceRequired: 'Estilo declarado + patrón rítmico compatible.',
        allowedWhen: ['jazzcolombiano declarado + patrón bambuco'],
        forbiddenWhen: ['solo por 6/8 o 3/4'],
        pedagogicalUse: 'NO afirmar bambuco solo por métrica.',
        styles: ['jazzcolombiano'],
        relatedTerms: ['bambuco_6_8', 'bambuco_3_4'],
    },
    pasillo: {
        id: 'pasillo', term: 'Pasillo', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Género/aire tradicional colombiano con variantes regionales.',
        evidenceRequired: 'Estilo + patrón.',
        allowedWhen: ['jazzcolombiano declarado + patrón compatible'],
        forbiddenWhen: [],
        pedagogicalUse: 'Requiere patrón rítmico específico.',
        styles: ['jazzcolombiano'],
        relatedTerms: ['bambuco'],
    },
    currulao: {
        id: 'currulao', term: 'Currulao', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Género/aire de tradición Pacífica colombiana.',
        evidenceRequired: 'Patrón + contexto regional/estilístico.',
        allowedWhen: ['jazzcolombiano declarado + patrón identificable'],
        forbiddenWhen: [],
        pedagogicalUse: 'Regionalmente específico.',
        styles: ['jazzcolombiano'],
        relatedTerms: [],
    },
    cumbia: {
        id: 'cumbia', term: 'Cumbia', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Género colombiano con organización rítmica característica.',
        evidenceRequired: 'Estilo + patrón.',
        allowedWhen: ['jazzcolombiano declarado + patrón compatible'],
        forbiddenWhen: [],
        pedagogicalUse: 'Requiere patrón rítmico específico.',
        styles: ['jazzcolombiano'],
        relatedTerms: [],
    },
    porro: {
        id: 'porro', term: 'Porro', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Familia de géneros/aires tradicionales colombianos.',
        evidenceRequired: 'Estilo + patrón.',
        allowedWhen: ['jazzcolombiano declarado + patrón compatible'],
        forbiddenWhen: [],
        pedagogicalUse: 'Variantes regionales (porro chocoano, pelayera).',
        styles: ['jazzcolombiano'],
        relatedTerms: [],
    },
    fusion_jazz_colombiano: {
        id: 'fusion_jazz_colombiano', term: 'Fusión jazz colombiano', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Integración de recursos del jazz con materiales rítmicos/melódicos colombianos.',
        evidenceRequired: 'Estilo declarado + evidencia musical.',
        allowedWhen: ['jazzcolombiano declarado'],
        forbiddenWhen: [],
        pedagogicalUse: 'Marco amplio; requiere identificar género específico si aporta.',
        styles: ['jazzcolombiano'],
        relatedTerms: ['bambuco', 'cumbia', 'porro', 'currulao'],
    },
    celula_colombiana: {
        id: 'celula_colombiana', term: 'Célula rítmica colombiana', aliases: [],
        category: 'colombian', level: 'advanced',
        definition: 'Patrón rítmico reconocible asociado a un género colombiano concreto.',
        evidenceRequired: 'Patrón + referencia estilística.',
        allowedWhen: ['jazzcolombiano declarado + patrón identificado'],
        forbiddenWhen: [],
        pedagogicalUse: 'Nombrar el género específico cuando sea posible.',
        styles: ['jazzcolombiano'],
        relatedTerms: ['bambuco', 'cumbia'],
    },

    // ─── J. Blues ─────────────────────────────────────────────────────────
    blues_scale: {
        id: 'blues_scale', term: 'Escala blues', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Colección escalar característica del lenguaje blues.',
        evidenceRequired: 'Patrón de alturas + contexto blues.',
        allowedWhen: ['blues declarado + transcription reliable + patrón compatible'],
        forbiddenWhen: ['transcription unreliable'],
        pedagogicalUse: 'Requiere contexto blues declarado.',
        styles: ['blues'],
        relatedTerms: ['blue_note'],
    },
    blue_note: {
        id: 'blue_note', term: 'Blue note', aliases: [],
        category: 'jazz', level: 'advanced',
        definition: 'Altura característica del lenguaje blues.',
        evidenceRequired: 'Contexto blues + evidencia melódica.',
        allowedWhen: ['blues declarado + patrón melódico compatible'],
        forbiddenWhen: ['sin contexto blues'],
        pedagogicalUse: 'Solo dentro de contexto blues real.',
        styles: ['blues'],
        relatedTerms: ['blues_scale'],
    },
};

// ─── Selector: getRelevantMusicalTerms ───────────────────────────────────
// Devuelve entre 0 y 10 términos relevantes (cap adaptativo 6/8/10 por
// cantidad de capas fuertes de evidencia — ver comentario al final).
// Filtros aplicados:
//   1. Reliability: transcripción/melodía/tonalidad — excluye términos que
//      dependen de señales inconfiables.
//   2. Estilo declarado: prioriza vocabulario específico pero NO lo agrega
//      solo porque el estilo esté declarado — requiere evidencia adicional
//      (transcripción, escucha, tonalidad reliable). El estilo por sí solo
//      no habilita ii_V_I, guide_tones, bebop_scale, etc.
//   3. Datos disponibles: features derivadas (densidad, dinámica, silencio,
//      rushDrag, rango) habilitan términos observables.
//   4. Auditory observations: cuando Gemini escuchó, se habilitan advanced
//      basados en escucha (articulacion, swing_feel, comping, etc.) y se
//      confirman patrones estilísticos avanzados que requieren corroboración.
//   5. Cap final adaptativo (6/7/8) según cantidad de capas fuertes de
//      evidencia (auditory + transcripción reliable + tonalidad high);
//      ordenados observable > interpretative > advanced dentro de cada
//      prioridad.
//   6. NO rellena hasta el cap — si la evidencia solo sostiene 4 términos,
//      devuelve 4.
export function getRelevantMusicalTerms(audioAnalysis, metadata = {}, reliability = null, auditoryObservations = null) {
    const style = String(metadata?.style || '').toLowerCase().replace(/[\s_-]/g, '');
    const level = String(metadata?.level || '').toLowerCase();

    // Reliability shortcuts. Todos son opt-in (undefined = default abierto,
    // como en el resto del pipeline actual — no bloqueamos por ausencia).
    const transcriptionLevel = reliability?.transcription?.level || 'unknown';
    const transcriptionReliable = transcriptionLevel === 'high' || transcriptionLevel === 'medium';
    const melodyStatus = reliability?.melody?.status || 'unknown';
    const melodyOk = melodyStatus !== 'unknown';
    const keyReliability = reliability?.key?.reliability || 'unknown';
    const keyOk = keyReliability === 'high' || keyReliability === 'medium';
    const keyHigh = keyReliability === 'high';

    // Feature shortcuts.
    const notes = audioAnalysis?.midiNotes || audioAnalysis?.notes || [];
    const hasNotes = Array.isArray(notes) && notes.length > 0;
    const tempo = Number(audioAnalysis?.tempo?.bpm || 0);
    const tempoConfident = tempo > 0 && Number(audioAnalysis?.tempo?.confidence || 0) >= 0.5;
    const loudness = audioAnalysis?.loudness || {};
    const hasLoudness = Number(loudness.dynamicComplexity || 0) > 0 || Number(loudness.average || 0) !== 0;

    const auditoryList = Array.isArray(auditoryObservations?.auditory_observations)
        ? auditoryObservations.auditory_observations
        : (Array.isArray(auditoryObservations) ? auditoryObservations : []);
    const hasAuditory = auditoryList.length > 0;

    const selected = new Set();
    const add = (id) => { if (MUSICAL_TERMS[id]) selected.add(id); };

    // ─── 1. Base observable (siempre disponible si el dato existe) ─────
    if (tempoConfident) add('tempo');
    add('pulso');
    add('estabilidad_del_pulso');
    if (hasLoudness) { add('dinamica'); add('contraste_dinamico'); }
    if (hasNotes) { add('registro'); add('rango'); add('silencio'); }
    add('densidad_ritmica'); // el prompt maneja cómo tratarla según banda

    // ─── 2. Interpretative base ─────────────────────────────────────────
    add('fraseo');
    if (hasNotes) add('frase');
    add('respiracion_musical');
    if (hasAuditory) { add('acento'); add('ataque'); }

    // ─── 3. Advanced condicionados por reliability + evidencia ──────────
    if (hasAuditory) {
        add('articulacion');       // requiere escucha
        add('subdivision');
    }
    if (transcriptionReliable && hasNotes) {
        add('motivo');
        if (melodyOk) add('contorno_melodico');
        add('nota_de_paso');
        if (keyOk) { add('cromatismo'); add('tension'); add('resolucion'); add('tension_resolution'); }
    }
    // Armonía funcional: solo si tonalidad reliable + transcripción reliable.
    if (transcriptionReliable && keyHigh) {
        add('tonalidad');
        add('tonica');
        add('dominante');
        add('acorde');
        add('voicing');
        add('conduccion_de_voces');
    } else if (transcriptionReliable && keyOk) {
        add('centro_tonal');       // versión suave cuando no es high
    }

    // ─── 4. Estilo declarado ────────────────────────────────────────────
    // Filosofía: el estilo NO habilita advanced por sí solo. Habilita:
    //   (a) núcleo estilístico (concepto general del estilo, ej. clave, swing).
    //   (b) advanced ESPECÍFICOS solo cuando además hay evidencia extra
    //       (transcripción + escucha, o tonalidad reliable + escucha).
    // Sin esta doble exigencia el prompt se llenaba de vocabulario armónico
    // (ii_V_I, guide tones, enclosures, playing the changes) que el sistema
    // NO puede confirmar realmente — y el modelo terminaba tentado a usarlos
    // solo porque estaban en la lista.
    if (style === 'bebop' || style === 'hardbop') {
        add('swing');                                     // núcleo del estilo
        add('comping');                                   // núcleo del rol pianístico
        if (hasAuditory) add('swing_feel');               // requiere escucha
        // Vocabulario armónico/melódico bebop: SOLO con transcripción reliable
        // Y escucha (Gemini confirmó actividad melódica coherente). Sin esa
        // doble confirmación no afirmamos que haya bebop scale ni chord tones.
        if (transcriptionReliable && hasAuditory) {
            add('bebop_scale');
            add('chord_tone');
            // Aproximaciones/encierros son MUY específicos: además de doble
            // corroboración pedimos tonalidad reliable (para hablar de "nota
            // objetivo" hace falta saber cuál es la tónica funcional).
            if (keyHigh) {
                add('approach_note');
                add('aproximacion_cromatica');
                // Enclosure y encierro son casi sinónimos — mantenemos SOLO
                // uno para no gastar cupo en duplicados semánticos.
                add('enclosure');
            }
        }
        // Progresiones ii-V-I / guide tones: requieren tonalidad reliable +
        // transcripción reliable + escucha. Sin escucha no se puede confirmar
        // una progresión funcional real, solo la presencia de acordes sueltos.
        if (transcriptionReliable && keyHigh && hasAuditory) {
            add('ii_V_I');
            add('guide_tones');
        }
        // sustitucion_tritono y playing_the_changes salen del auto-add por
        // estilo — extremadamente específicos, solo entran si el objective o
        // notes los mencionan explícitamente (ver hint check abajo).
    }
    if (style === 'soncubano' || style === 'latinjazz') {
        add('clave');                                     // referencia estilística base
        add('independencia_ritmica');                     // fundamental en el estilo
        if (transcriptionReliable || hasAuditory) {
            add('tresillo');
        }
        // Patrones pianísticos específicos: requieren escucha o transcripción
        // reliable + patrón real. Antes se agregaban por el solo hecho de
        // declarar el estilo — genera falsa sensación de que el sistema
        // "detecta" clave/montuno cuando en realidad solo lo asume.
        if (hasAuditory) {
            add('montuno');
            add('piano_tumbao');
            add('interlocking');
            add('clave_2_3');
            add('clave_3_2');
        }
        if (hasAuditory && transcriptionReliable) {
            add('guajeo');                                // patrón repetitivo requiere ambas
        }
        if (melodyOk && hasAuditory) {
            add('tumbao_bajo');                           // bajo separable + escucha
        }
        if (transcriptionReliable) add('straight_eighths');
        // Latin jazz hereda armonía jazz SOLO con la triple corroboración:
        // transcription + key reliable + escucha.
        if (style === 'latinjazz' && transcriptionReliable && keyHigh && hasAuditory) {
            add('ii_V_I');
            add('chord_tone');
            add('guide_tones');
        }
    }
    if (style === 'bolero') {
        add('fraseo_bolero');
        add('expresividad_melodica');
        // Rubato: requiere evidencia de variación temporal REAL (rushDrag) o
        // escucha; sin eso "rubato en bolero" es una asunción del estilo.
        if (hasAuditory) {
            add('rubato');
            add('rubato_bolero');
        }
        if (transcriptionReliable) add('arpegio_acompanamiento');
    }
    if (style === 'jazzcolombiano') {
        add('fusion_jazz_colombiano');
        add('celula_colombiana');
        // Los géneros específicos solo si el pianista los declara en objective/notes;
        // por defecto no habilitamos bambuco/cumbia/porro/currulao/pasillo automáticamente.
        // Los agregamos como vocabulario disponible SI el objective/notes los menciona:
        const hint = `${metadata?.objective || ''} ${metadata?.notes || ''}`.toLowerCase();
        if (hint.includes('bambuco')) add('bambuco');
        if (hint.includes('pasillo')) add('pasillo');
        if (hint.includes('currulao')) add('currulao');
        if (hint.includes('cumbia')) add('cumbia');
        if (hint.includes('porro')) add('porro');
    }
    if (style === 'blues') {
        // Escala blues y blue note: requieren corroboración auditiva además
        // de transcripción — sin escucha, la presencia de una tercera menor
        // no confirma lenguaje blues.
        if (transcriptionReliable && hasAuditory) {
            add('blues_scale');
            add('blue_note');
        }
        add('call_response');
        if (hasAuditory) add('swing_feel');
    }

    // Hints por objective/notes: expanden vocabulario avanzado si el pianista
    // explícitamente menciona el concepto (mejor señal que el estilo declarado).
    const hintText = `${metadata?.objective || ''} ${metadata?.notes || ''}`.toLowerCase();
    if (hintText.includes('tritono') || hintText.includes('tritone')) add('sustitucion_tritono');
    if (hintText.includes('playing the changes') || hintText.includes('sobre cambios')) add('playing_the_changes');
    if (hintText.includes('walking bass')) add('walking_bass');
    if (hintText.includes('stride')) add('stride');
    if (hintText.includes('rootless')) add('rootless_voicing');
    if (hintText.includes('drop 2') || hintText.includes('drop2')) add('drop_2');
    if (hintText.includes('cuartal') || hintText.includes('quartal')) add('quartal_voicing');
    if (hintText.includes('shell voicing')) add('shell_voicing');

    // ─── 5. Filtros duros post-selección ────────────────────────────────
    // No importa qué estilo — si transcripción unreliable, sacamos armonía advanced.
    if (!transcriptionReliable) {
        for (const id of ['acorde', 'voicing', 'shell_voicing', 'rootless_voicing', 'drop_2',
                          'quartal_voicing', 'ii_V_I', 'guide_tones', 'sustitucion_tritono',
                          'bebop_scale', 'enclosure', 'encierro', 'approach_note', 'chord_tone',
                          'aproximacion_cromatica', 'ostinato', 'pedal_armonico',
                          'motivo', 'contorno_melodico', 'nota_de_paso']) {
            selected.delete(id);
        }
    }
    // Si melody.status es unknown, sacamos todo lo que asume línea melódica separada.
    if (!melodyOk) {
        for (const id of ['contorno_melodico', 'walking_bass', 'tumbao_bajo', 'playing_the_changes']) {
            selected.delete(id);
        }
    }
    // Sin escucha auditiva, sacamos advanced que dependen de ella.
    if (!hasAuditory) {
        for (const id of ['articulacion', 'ataque', 'swing_feel', 'interlocking']) {
            selected.delete(id);
        }
    }
    // Sin tonalidad reliable, ningún cifrado.
    if (!keyOk) {
        for (const id of ['tonalidad', 'tonica', 'dominante', 'ii_V_I', 'sustitucion_tritono',
                          'reharmonizacion', 'guide_tones', 'playing_the_changes']) {
            selected.delete(id);
        }
    }

    // ─── 6. Materializar + ordenar + cap 20 ─────────────────────────────
    // Prioridad: (1) términos del estilo declarado primero dentro de cada nivel
    // — si no lo hacemos, los observables genéricos ocupan todo el cap y los
    // advanced específicos del estilo (clave, ii_V_I, bebop_scale, etc.) se
    // pierden. (2) Luego por nivel. (3) Luego alfabético.
    const levelOrder = { observable: 0, interpretative: 1, advanced: 2 };
    const styleMatchesTerm = (t) => {
        if (!style) return false;
        if (!Array.isArray(t.styles)) return false;
        if (t.styles.includes('*')) return false;   // los universales van por nivel normal
        return t.styles.includes(style);
    };
    // Términos que dependen de escucha auditiva — cuando hasAuditory, la
    // evidencia es fuerte y merecen prioridad para no perderse en el cap.
    const AUDITORY_DEPENDENT = new Set(['articulacion', 'ataque', 'swing_feel', 'interlocking', 'subdivision']);
    const isAuditoryBoosted = (t) => hasAuditory && AUDITORY_DEPENDENT.has(t.id);
    // Fundamentals: términos base que casi siempre son útiles pedagógicamente
    // (referencia rítmica y armónica mínima). Reciben boost para no perderse
    // por ordenamiento alfabético cuando el cap se acerca.
    const FUNDAMENTALS = new Set(['tempo', 'pulso', 'estabilidad_del_pulso']);
    const isFundamental = (t) => FUNDAMENTALS.has(t.id);
    const terms = [...selected]
        .map(id => MUSICAL_TERMS[id])
        .filter(Boolean);
    terms.sort((a, b) => {
        // Prioridad 0: match de estilo declarado (advanced específico del estilo).
        // Prioridad 1: fundamentales pedagógicos base (tempo/pulso/estabilidad).
        // Prioridad 2: dependiente de escucha con auditory disponible.
        // Prioridad 3: todo lo demás por nivel.
        const pa = styleMatchesTerm(a) ? 0 : isFundamental(a) ? 1 : isAuditoryBoosted(a) ? 2 : 3;
        const pb = styleMatchesTerm(b) ? 0 : isFundamental(b) ? 1 : isAuditoryBoosted(b) ? 2 : 3;
        if (pa !== pb) return pa - pb;
        const dl = (levelOrder[a.level] ?? 3) - (levelOrder[b.level] ?? 3);
        if (dl !== 0) return dl;
        return a.term.localeCompare(b.term);
    });
    // Cap final adaptativo por cantidad de capas fuertes de evidencia
    // (auditory + transcripción reliable + tonalidad high):
    //   - 3 capas (evidencia rica): hasta 10 términos, con margen para
    //     vocabulario avanzado del estilo corroborado por escucha + armonía.
    //   - 1-2 capas (evidencia intermedia): hasta 8.
    //   - 0 capas (solo base observable): 6.
    // No rellena artificialmente: si la evidencia solo sostiene 4 términos
    // relevantes, devuelve 4. Objetivo: ahorrar tokens del cupo TPM sin
    // perder vocabulario cuando la evidencia realmente lo respalda.
    const evidenceStrength = (hasAuditory ? 1 : 0) + (transcriptionReliable ? 1 : 0) + (keyHigh ? 1 : 0);
    const cap = evidenceStrength >= 3 ? 10 : evidenceStrength >= 1 ? 8 : 6;
    return terms.slice(0, cap);
}

// Utilidad para tests / debug: agrupa por categoría.
export function groupTermsByCategory(terms) {
    const groups = {};
    for (const t of terms) {
        if (!groups[t.category]) groups[t.category] = [];
        groups[t.category].push(t.id);
    }
    return groups;
}
