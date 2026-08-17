# PianoStudy — Banco de Términos Musicales v1.1

> **Versión revisada:** agosto de 2026.
> Este banco fue revisado con fuentes de teoría y pedagogía de jazz, Music Theory Online,
> Berklee, Columbia University Jazz Glossary y fuentes institucionales sobre músicas
> colombianas. Las fuentes se usan para afinar definiciones; las reglas de inferencia
> son específicas de PianoStudy.

> **Nota de arquitectura:** este documento es la fuente de verdad legible. La
> representación estructurada que consume el código vive en `musicalTerms.js`,
> derivada de este documento. Si actualizás uno, sincronizá el otro.

Banco de conocimiento musical para el sistema de feedback de PianoStudy.
Este documento NO es un prompt. Define terminología, significado y condiciones
de uso para que la IA utilice lenguaje musical correcto sin inventar conceptos.

---

## Reglas generales

- Un término no debe aparecer solo porque esté disponible en el banco.
- `observable`: puede apoyarse directamente en señales relativamente fiables.
- `interpretative`: requiere una interpretación musical prudente.
- `advanced`: requiere evidencia musical específica.
- Nunca asumir que la nota más aguda es la melodía.
- Nunca asumir que la nota más grave es el bajo.
- Duración de nota detectada ≠ articulación intencional.
- Muchas notas ≠ mala interpretación.
- Tempo rápido ≠ tempo incorrecto.
- Una tonalidad estimada ≠ armonía confirmada.
- Los términos de estilo requieren contexto y evidencia.
- Es preferible omitir un término avanzado antes que utilizarlo sin respaldo.

---

## A. Tiempo y ritmo

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| tempo | Tempo | observable | Velocidad general de la interpretación, normalmente expresada en BPM. | Tempo detectado con fiabilidad. |
| pulso | Pulso | observable | Organización de los tiempos regulares que sostiene la interpretación. | Estabilidad temporal. |
| estabilidad_del_pulso | Estabilidad del pulso | observable | Grado en que el pulso se mantiene consistente durante la toma. | Análisis temporal. |
| subdivision | Subdivisión | interpretative | División interna del pulso en unidades menores. | Patrón rítmico suficientemente claro. |
| ritmo | Ritmo | interpretative | Organización temporal de duraciones, ataques, silencios y acentos. | Eventos temporales. |
| densidad_ritmica | Densidad rítmica | observable | Concentración de eventos musicales dentro de un intervalo temporal. | Densidad de eventos. |
| silencio | Silencio | observable | Ausencia de eventos durante un intervalo. | Segmentos sin eventos. |
| sincopa | Síncopa | advanced | Desplazamiento o énfasis de un ataque respecto de posiciones métricamente fuertes. | Patrón rítmico claro. |
| contratiempo | Contratiempo | advanced | Ataque situado en una parte débil del pulso o entre pulsos fuertes. | Patrón temporal claro. |
| anticipacion | Anticipación | advanced | Entrada de una nota o acorde antes del punto métrico esperado. | Relación temporal con estructura musical. |
| desplazamiento_ritmico | Desplazamiento rítmico | advanced | Reubicación de un motivo o figura respecto de su posición métrica original. | Patrón repetitivo identificable. |
| acento | Acento | interpretative | Énfasis perceptible sobre un evento respecto de otros. | Dinámica + posición temporal. |
| swing | Swing | advanced | Tratamiento característico de la subdivisión asociado al lenguaje jazzístico. | Escucha y/o contexto estilístico. |
| straight_eighths | Corcheas rectas | interpretative | Subdivisión regular de corcheas sin tratamiento de swing. | Patrón temporal/auditivo. |

---

## B. Dinámica, articulación y expresión

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| dinamica | Dinámica | observable | Variación de intensidad sonora a lo largo de la interpretación. | Variación dinámica fiable. |
| contraste_dinamico | Contraste dinámico | observable | Diferencia perceptible entre niveles de intensidad. | Variación dinámica. |
| dinamica_plana | Dinámica poco variada | observable | Poca diferenciación de intensidad entre eventos o frases. | Variación baja + contexto. |
| fraseo | Fraseo | interpretative | Forma en que el intérprete organiza, dirige y articula una idea musical. | Datos + escucha idealmente. |
| articulacion | Articulación | advanced | Forma en que se conectan o separan las notas. | Evidencia auditiva. |
| ataque | Ataque | interpretative | Características del inicio de una nota. | Observación auditiva. |
| registro | Registro | observable | Zona grave, media o aguda en la que se desarrolla la música. | Notas detectadas. |
| rango | Rango | observable | Extensión entre la nota más grave y la más aguda detectadas. | Transcripción fiable. |
| densidad_textural | Densidad textural | interpretative | Cantidad de información musical simultánea o muy próxima. | Eventos/notas. |
| continuidad | Continuidad | interpretative | Grado en que una frase o idea se mantiene sin interrupciones excesivas. | Eventos + silencios. |
| respiracion_musical | Respiración musical | interpretative | Espacios que separan y organizan ideas musicales. | Silencios + escucha. |
| cantabile | Cantabile | advanced | Tratamiento de una línea buscando cualidad vocal y dirección melódica. | Contexto + escucha. |
| rubato | Rubato | advanced | Flexibilidad expresiva del tiempo sin perder necesariamente la estructura del pulso. | Variación temporal + escucha. |
| pedal | Pedal | advanced | Uso del pedal para prolongar, conectar, colorear o modificar resonancia. | MIDI/pedal o escucha. |

---

## C. Melodía y construcción de frases

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| motivo | Motivo | advanced | Idea musical breve que puede repetirse o desarrollarse. | Patrón melódico/rítmico repetido. |
| frase | Frase | interpretative | Unidad musical con dirección y sensación de cierre. | Estructura temporal + escucha. |
| celula_melodica | Célula melódica | advanced | Fragmento pequeño que sirve como material de construcción. | Patrón reconocible. |
| repeticion_motiva | Repetición motívica | advanced | Reaparición reconocible de una idea musical. | Similitud entre fragmentos. |
| variacion_motiva | Variación motívica | advanced | Reaparición de un motivo con modificación rítmica, melódica o interválica. | Comparación entre fragmentos. |
| secuencia | Secuencia | advanced | Repetición de una idea a diferentes alturas. | Patrón transpuesto. |
| movimiento_conjunto | Movimiento conjunto | advanced | Desplazamiento principalmente por grados conjuntos. | Notas suficientemente fiables. |
| salto_intervalllico | Salto interválico | advanced | Movimiento entre notas separadas por un intervalo mayor que un grado conjunto. | Transcripción fiable. |
| intervalo | Intervalo | advanced | Distancia musical entre dos alturas. | Notas fiables. |
| nota_objetivo | Nota objetivo | advanced | Nota hacia la que se dirige una figura melódica o armónica. | Contexto armónico/melódico. |
| nota_de_paso | Nota de paso | advanced | Nota que conecta dos notas estructurales. | Contexto melódico. |
| nota_vecina | Nota vecina | advanced | Nota que se aleja de una nota estructural y regresa a ella. | Patrón melódico. |
| cromatismo | Cromatismo | advanced | Uso de movimientos o notas fuera de la escala diatónica inmediata. | Notas fiables + contexto. |
| aproximacion_cromatica | Aproximación cromática | advanced | Nota situada cromáticamente antes de una nota objetivo. | Patrón melódico + objetivo. |
| encierro | Encierro cromático | advanced | Aproximación a una nota objetivo desde arriba y abajo antes de resolver. | Patrón específico. |
| tension | Tensión | advanced | Sonoridad que genera expectativa de movimiento o resolución. | Contexto armónico/melódico. |
| resolucion | Resolución | advanced | Movimiento que lleva una tensión hacia una sonoridad más estable. | Relación musical clara. |
| contorno_melodico | Contorno melódico | interpretative | Forma general del movimiento ascendente, descendente o mixto de una línea. | Transcripción suficientemente fiable. |

---

## D. Armonía

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| tonalidad | Tonalidad | advanced | Organización de alturas alrededor de un centro tonal. | Tonalidad con alta fiabilidad. |
| centro_tonal | Centro tonal | interpretative | Altura o región que funciona como referencia tonal. | Análisis tonal suficiente. |
| acorde | Acorde | advanced | Conjunto de alturas que forman una estructura armónica simultánea. | Notas simultáneas fiables. |
| triada | Tríada | advanced | Acorde construido a partir de tres alturas estructurales. | Notas fiables. |
| septima | Acorde de séptima | advanced | Tríada más una séptima. | Notas fiables. |
| inversion | Inversión | advanced | Disposición de un acorde donde una nota distinta de la fundamental está en el bajo. | Bajo + estructura armónica. |
| voicing | Voicing | advanced | Disposición concreta de las notas de un acorde. | Varias notas simultáneas fiables. |
| posicion_cerrada | Posición cerrada | advanced | Disposición con voces relativamente próximas. | Notas simultáneas. |
| posicion_abierta | Posición abierta | advanced | Disposición con mayor separación entre voces. | Notas simultáneas. |
| conduccion_de_voces | Conducción de voces | advanced | Movimiento de las voces entre acordes. | Progresión armónica. |
| guide_tones | Guide tones | advanced | Tercera y séptima de los acordes de séptima, importantes para función y conducción. | Acordes identificados. |
| tension_armonica | Tensión armónica | advanced | Extensiones o alteraciones que aumentan el color/tensión del acorde. | Acorde identificado. |
| extension | Extensión | advanced | Notas como 9ª, 11ª o 13ª añadidas a la estructura básica. | Voicing fiable. |
| dominante | Dominante | advanced | Función asociada normalmente al V grado y su tendencia hacia la tónica. | Progresión identificada. |
| tonica | Tónica | advanced | Centro funcional principal de una tonalidad. | Tonalidad fiable. |
| ii_V_I | ii–V–I | advanced | Progresión funcional característica del lenguaje jazzístico. | Progresión armónica identificable. |
| sustitucion_tritono | Sustitución de tritono | advanced | Sustitución de un dominante por otro dominante situado a un tritono. | Progresión armónica fiable. |
| reharmonizacion | Reharmonización | advanced | Modificación de la armonía original conservando o reinterpretando su función. | Contexto armónico conocido. |
| pedal_armonico | Pedal armónico | advanced | Nota sostenida o repetida mientras cambia la armonía superior. | Nota/bajo repetido + armonía. |
| ostinato | Ostinato | advanced | Patrón musical repetido persistentemente. | Repetición clara. |

---

## E. Lenguaje de jazz

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| jazz_blues | Jazz blues | advanced | Tratamiento jazzístico de la forma y lenguaje del blues. | Estilo + estructura. |
| blues_scale | Escala blues | advanced | Escala característica del lenguaje blues. | Notas fiables. |
| blue_note | Blue note | advanced | Nota característica del lenguaje blues. | Notas + contexto. |
| bebop | Bebop | advanced | Lenguaje jazzístico con fuerte relación entre cromatismo, ritmo y armonía. | Estilo declarado + evidencia. |
| bebop_scale | Bebop scale | advanced | Escala con nota cromática de paso que facilita colocar tonos del acorde en tiempos fuertes. | Patrón escalar identificable. |
| hard_bop | Hard bop | advanced | Corriente que combina bebop con influencias de blues, gospel y otros elementos rítmicos. | Estilo declarado. |
| swing_feel | Swing feel | advanced | Tratamiento rítmico característico de la subdivisión jazzística. | Escucha. |
| comping | Comping | advanced | Acompañamiento rítmico-armónico que sostiene e interactúa con el solista. | Patrón armónico/rítmico. |
| walking_bass | Walking bass | advanced | Línea de bajo con movimiento continuo que articula armonía y pulso. | Bajo claramente identificado. |
| call_response | Call and response | advanced | Relación de pregunta-respuesta entre frases o capas. | Patrón de frases. |
| chord_tone | Nota del acorde | advanced | Nota perteneciente a la estructura del acorde. | Acorde identificado. |
| approach_note | Nota de aproximación | advanced | Nota utilizada para dirigirse a una nota objetivo. | Patrón melódico. |
| enclosure | Enclosure | advanced | Rodeo de una nota objetivo mediante notas superiores e inferiores. | Patrón melódico. |
| playing_the_changes | Playing the changes | advanced | Construcción melódica que sigue activamente la armonía. | Armonía + melodía. |
| tension_resolution | Tensión-resolución | advanced | Organización de tensión y relajación dentro de una línea o progresión. | Evidencia armónica/melódica. |

---

## F. Piano jazz y acompañamiento

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| comping_pattern | Patrón de comping | advanced | Figura rítmico-armónica de acompañamiento. | Patrón armónico/rítmico. |
| shell_voicing | Shell voicing | advanced | Voicing reducido que enfatiza raíz y/o tercera y séptima. | Estructura armónica fiable. |
| drop_2 | Drop 2 | advanced | Disposición donde una voz se desplaza una octava. | Voicing identificable. |
| quartal_voicing | Voicing cuartal | advanced | Voicing construido principalmente mediante cuartas. | Intervalos + contexto armónico. |
| rootless_voicing | Rootless voicing | advanced | Voicing que omite la fundamental. | Estructura armónica + contexto. |
| guide_tone_line | Línea de guide tones | advanced | Línea construida a partir de terceras y séptimas que conecta acordes. | Progresión armónica. |
| stride | Stride | advanced | Acompañamiento con amplio desplazamiento entre bajo y acordes. | Patrón claro de mano izquierda. |

---

## G. Son cubano / música afrocubana / Latin Jazz

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| clave | Clave | advanced | Patrón rítmico de dos compases que organiza gran parte de la estructura afrocubana. | Patrón rítmico claro. |
| clave_2_3 | Clave 2–3 | advanced | Organización de la clave donde el lado de dos precede al de tres. | Patrón de clave identificado. |
| clave_3_2 | Clave 3–2 | advanced | Organización inversa de la clave. | Patrón de clave identificado. |
| tresillo | Tresillo | advanced | Célula rítmica de tres ataques dentro de una subdivisión binaria. | Patrón rítmico claro. |
| sincopa_afrocubana | Síncopa afrocubana | advanced | Organización de ataques/accentos característica de determinadas células afrocubanas. | Contexto + patrón. |
| montuno | Montuno | advanced | Patrón/sección repetitiva del lenguaje del son; en piano cumple función rítmico-armónica. | Patrón + contexto. |
| piano_tumbao | Tumbao de piano | advanced | Patrón rítmico-melódico repetitivo del piano en determinados géneros afrocubanos. | Patrón + estilo. |
| tumbao_bajo | Tumbao de bajo | advanced | Patrón rítmico característico del bajo. | Bajo identificado. |
| guajeo | Guajeo | advanced | Patrón repetitivo, frecuentemente sincopado, asociado históricamente al tres y posteriormente al piano. | Patrón + estilo. |
| cascara | Cáscara | advanced | Patrón percusivo utilizado como referencia rítmica. | Patrón auditivo. |
| campana | Campana | advanced | Patrón de campana/bell de la organización afrocubana. | Patrón percusivo. |
| interlocking | Interlocking | advanced | Encaje entre patrones rítmicos de diferentes capas. | Varias capas. |
| clave_alignment | Alineación con la clave | advanced | Relación de los ataques del patrón pianístico con la clave. | Clave + patrón. |
| clave_displacement | Desplazamiento respecto a la clave | advanced | Relación deliberadamente desplazada respecto a la clave. | Clave + patrón. |
| independencia_ritmica | Independencia rítmica | interpretative | Capacidad de mantener funciones rítmicas diferentes entre manos/capas. | Dos capas identificables. |

Regla:
NO tratar montuno, tumbao y guajeo como sinónimos.

---

## H. Bolero

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| bolero | Bolero | advanced | Género latino con fuerte énfasis melódico y expresivo. | Estilo declarado. |
| fraseo_bolero | Fraseo de bolero | advanced | Tratamiento expresivo y cantabile de la línea. | Escucha + contexto. |
| rubato_bolero | Rubato en bolero | advanced | Flexibilidad temporal utilizada expresivamente. | Variación temporal + escucha. |
| acompanamiento_bolero | Acompañamiento de bolero | advanced | Patrón armónico/rítmico característico. | Patrón claro. |
| arpegio_acompanamiento | Acompañamiento arpegiado | advanced | Acompañamiento que despliega sucesivamente las notas del acorde. | Patrón de notas. |
| movimiento_de_voces | Movimiento de voces | advanced | Desplazamiento de notas internas entre acordes. | Armonía fiable. |
| expresividad_melodica | Expresividad melódica | advanced | Uso de dinámica, tiempo y articulación para dirigir la melodía. | Escucha. |

---

## I. Jazz colombiano

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| bambuco | Bambuco | advanced | Género/aire tradicional colombiano con patrones característicos según variante. | Estilo + patrón. |
| bambuco_6_8 | Bambuco en 6/8 | advanced | Tratamiento del bambuco dentro de organización métrica de 6/8. | Métrica + patrón. |
| bambuco_3_4 | Bambuco en 3/4 | advanced | Variante/representación en compás ternario. | Métrica + patrón. |
| cumbia | Cumbia | advanced | Género colombiano con organización rítmica característica. | Estilo + patrón. |
| porro | Porro | advanced | Género de tradición musical colombiana. | Estilo + patrón. |
| currulao | Currulao | advanced | Género tradicional de la región Pacífica colombiana. | Estilo + patrón. |
| pasillo | Pasillo | advanced | Género/aire tradicional colombiano. | Estilo + patrón. |
| puya | Puya | advanced | Ritmo/género de tradición Caribe colombiana. | Estilo + patrón. |
| guabina | Guabina | advanced | Género/aire de tradición andina colombiana. | Estilo + patrón. |
| chande | Chandé | advanced | Ritmo/género de tradición Caribe colombiana. | Estilo + patrón. |
| celula_colombiana | Célula rítmica colombiana | advanced | Patrón rítmico reconocible asociado a un género colombiano concreto. | Patrón + referencia estilística. |
| fusion_jazz_colombiano | Fusión jazz colombiano | advanced | Integración de elementos de jazz con materiales colombianos. | Estilo declarado + evidencia. |

---

## J. Términos que requieren especial precaución

Nunca inferir automáticamente:

| Dato observado | NO concluir automáticamente |
|---|---|
| densidad alta | interpretación confusa |
| rango amplio | melodía amplia |
| nota más aguda | melodía |
| nota más grave | bajo |
| notas cortas | staccato |
| tempo rápido | tempo incorrecto |
| muchas notas | mala técnica |
| tonalidad estimada | armonía confirmada |
| estilo declarado | patrón estilístico confirmado |
| pocas notas | voicing/rootless voicing |
| repetición de notas | ostinato |
| notas cromáticas | bebop |
| síncopas | son cubano |
| 6/8 | bambuco |
| 3/4 | bambuco |
| patrón repetitivo | montuno |
| patrón de bajo | tumbao |
| pocas notas simultáneas | shell voicing |

---

## K. Terminología adicional

### K.1 Fundamentos métricos

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| pulso_metrico | Pulso métrico | observable | Referencia regular que organiza la percepción temporal de la música. | Análisis temporal fiable. |
| metrica | Métrica | interpretative | Organización de los pulsos en patrones de acentos regulares (2/4, 3/4, 4/4, 6/8). | Estructura temporal suficientemente clara. |
| compas | Compás | interpretative | Unidad métrica que agrupa pulsos según una organización determinada. | Métrica/estructura clara. |
| tiempo_fuerte | Tiempo fuerte | interpretative | Pulso o posición métrica que recibe mayor jerarquía dentro de un patrón. | Métrica + patrón de acentos. |
| tiempo_debil | Tiempo débil | interpretative | Posición métrica con menor jerarquía relativa. | Métrica + patrón de acentos. |
| polirritmia | Polirritmia | advanced | Superposición de patrones rítmicos diferentes con relaciones temporales simultáneas. | Varias capas rítmicas identificables. |
| polimetria | Polimetría | advanced | Coexistencia de organizaciones métricas diferentes entre capas o secciones. | Evidencia estructural clara. |
| hemiola | Hemiola | advanced | Reorganización perceptual de agrupaciones binarias/ternarias dentro de un mismo flujo temporal. | Patrón rítmico claro + contexto. |
| cinquillo | Cinquillo | advanced | Célula sincopada de cinco ataques característica de varios contextos afrocaribeños. | Patrón específico + contexto estilístico. |
| cross_rhythm | Polirritmo/cruce rítmico | advanced | Relación entre patrones que producen diferentes agrupaciones o acentos simultáneos. | Varias capas o patrón inequívoco. |

**Nota:** no confundir `métrica`, `compás`, `pulso` y `subdivisión`. Son conceptos relacionados, pero no equivalentes.

### K.2 Melodía y ornamentación

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| escala | Escala | advanced | Sucesión organizada de alturas que sirve como marco melódico o armónico. | Patrón de alturas + contexto. |
| arpegio | Arpegio | advanced | Despliegue sucesivo de las notas de un acorde. | Patrón interválico + contexto armónico. |
| apoyatura | Apoyatura | advanced | Nota de adorno que genera tensión sobre una nota estructural y normalmente resuelve por movimiento conjunto. | Patrón melódico + escucha/contexto. |
| escapada | Nota escapada | advanced | Nota de adorno que se aproxima por paso y sale mediante salto (o viceversa). | Patrón melódico claro. |
| bordadura | Bordadura | advanced | Nota auxiliar que se separa de una nota principal y regresa a ella. | Patrón melódico. |
| retardo | Retardo | advanced | Nota que se mantiene desde una sonoridad anterior y resuelve después dentro de una nueva armonía. | Armonía + duración/voz identificable. |
| frase_antecedente | Frase antecedente | advanced | Frase que genera sensación de pregunta o apertura y suele relacionarse con otra frase. | Estructura musical clara. |
| frase_consecuente | Frase consecuente | advanced | Frase que responde o completa una frase antecedente. | Estructura musical clara. |

**Precaución:** `arpegio` no debe inferirse únicamente porque las notas se muevan por saltos. Debe existir un patrón compatible con una estructura de acorde.

### K.3 Armonía funcional y jazz

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| funcion_tonal | Función tonal | advanced | Papel armónico de una sonoridad dentro de una tonalidad (tónica, predominante, dominante). | Progresión armónica fiable. |
| predominante | Predominante | advanced | Función que prepara o conduce hacia la dominante. | Progresión fiable. |
| acorde_dominante | Acorde dominante | advanced | Sonoridad con función dominante, típicamente un acorde de séptima dominante. | Estructura + función identificables. |
| tritono | Tritono | advanced | Intervalo de tres tonos enteros, equivalente a cuarta aumentada o quinta disminuida. | Dos alturas fiables. |
| acorde_de_paso | Acorde de paso | advanced | Acorde utilizado para conectar dos estructuras armónicas principales. | Progresión suficientemente clara. |
| acorde_sustituto | Acorde sustituto | advanced | Acorde que reemplaza a otro dentro de una función o contexto armónico determinado. | Función armónica identificada. |
| acorde_sus | Acorde suspendido | advanced | Sonoridad en la que la tercera se sustituye/acompaña por una cuarta u otra estructura suspendida. | Notas simultáneas fiables. |
| alteracion | Alteración | advanced | Modificación cromática de una tensión o grado estructural, especialmente en dominantes. | Armonía identificada. |
| tension_disponible | Tensión disponible | advanced | Tensión que puede integrarse en una sonoridad de acuerdo con su contexto armónico. | Acorde + contexto estilístico. |
| bajo_armonico | Bajo armónico | advanced | Línea o función grave que articula el movimiento armónico. | Registro grave + contexto armónico (no asumir por registro únicamente). |

**Corrección conceptual importante:** en PianoStudy, `guide_tones` se reservará principalmente para acordes de séptima y progresiones de jazz. No etiquetar automáticamente cualquier tercera o quinta de una tríada como "guide tone".

### K.4 Piano: textura, voicings y acompañamiento

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| textura | Textura | interpretative | Relación entre capas, voces y densidad de la superficie musical. | Varias capas o información suficiente. |
| homofonia | Homofonía | advanced | Textura donde una línea principal predomina sobre acompañamiento armónico. | Separación de roles + escucha. |
| polifonia | Polifonía | advanced | Interacción de varias líneas independientes. | Líneas diferenciables. |
| acompanamiento | Acompañamiento | interpretative | Material que sostiene o interactúa con una línea principal. | Roles musicales diferenciables. |
| comping_rhythm | Patrón rítmico de comping | advanced | Organización temporal de ataques de acompañamiento. | Patrón rítmico claro. |
| independencia_de_manos | Independencia de manos | interpretative | Capacidad de mantener funciones o patrones distintos entre las manos. | Capas diferenciables. |

### K.5 Jazz: lenguaje y vocabulario adicional

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| modal | Jazz modal | advanced | Enfoque donde una sonoridad o modo puede mantenerse como centro durante un periodo prolongado. | Armonía/estructura clara. |
| fraseo_jazz | Fraseo jazzístico | interpretative | Organización de tiempo, articulación, acentos y dirección característica del lenguaje jazzístico. | Escucha + contexto. |
| time_feel | Time feel | interpretative | Sensación global de colocación temporal, estabilidad y relación con el pulso. | Tempo + escucha. |
| behind_the_beat | Behind the beat | advanced | Colocación deliberadamente retrasada respecto del pulso percibido. | Escucha/beat tracking fiable. |
| ahead_of_the_beat | Ahead of the beat | advanced | Colocación deliberadamente adelantada respecto del pulso percibido. | Escucha/beat tracking fiable. |
| backbeat | Backbeat | advanced | Énfasis recurrente en determinados pulsos débiles (2 y 4 en contextos binarios). | Patrón rítmico + contexto. |

### K.6 Son cubano y Latin Jazz — adicional

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| son_clave | Clave de son | advanced | Familia de patrones de clave utilizada en el son y géneros derivados. | Patrón específico. |
| rumba_clave | Clave de rumba | advanced | Familia de patrones asociada a la rumba afrocubana; no confundir con clave de son. | Patrón específico + contexto. |
| son_montuno | Son montuno | advanced | Variante del son cubano asociada a una sección con coro-pregón y mayor actividad. | Contexto estilístico + estructura. |
| coro_pregon | Coro-pregón | advanced | Interacción de una voz que plantea una frase y un coro que responde con una frase repetitiva. | Capas vocales identificables. |
| montuno_pianistico | Montuno pianístico | advanced | Patrón de piano repetitivo y sincopado utilizado como acompañamiento en el contexto del montuno. | Patrón de piano + contexto. |
| clave_crossed | Clave cruzada | advanced | Situación en la que una frase o patrón parece entrar en conflicto con la orientación de clave. | Clave + patrón + escucha. |

**Precauciones específicas:**
- `montuno`, `guajeo` y `tumbao` están relacionados, pero no son sinónimos universales.
- `tumbao` debe acompañarse de su rol cuando sea posible: bajo, piano u otro instrumento.
- `montuno` puede referirse tanto a una sección como a un patrón pianístico; el modelo debe usar el contexto para decidir.
- `clave_2_3` y `clave_3_2` describen orientación del ciclo, no simplemente "dos compases con síncopas".
- No afirmar "está en clave" solo porque haya síncopas.

### K.7 Música colombiana — adicional

| ID | Término | Nivel | Definición | Evidencia requerida |
|---|---|---|---|---|
| torbellino | Torbellino | advanced | Aire/género tradicional de la región andina colombiana. | Estilo + patrón. |
| porro_chocoano | Porro chocoano | advanced | Variante asociada a tradiciones del Pacífico colombiano. | Patrón + contexto regional. |
| joropo | Joropo | advanced | Tradición musical compartida por regiones de Colombia y Venezuela, con variantes locales. | Contexto + patrón. |
| vallenato | Vallenato | advanced | Tradición/género de la región Caribe colombiana con distintas formas y patrones. | Contexto + patrón. |
| pelayera | Música pelayera | advanced | Tradición de bandas y repertorios de la región Caribe colombiana. | Contexto + patrón. |

**Regla:** 6/8, 3/4, síncopa o una determinada densidad rítmica por sí solos NO permiten identificar bambuco, cumbia, porro o currulao.

---

## L. Términos que conviene diferenciar

### Pulso vs. tempo
- `tempo`: velocidad.
- `pulso`: referencia regular que organiza el tiempo.
- `estabilidad_del_pulso`: consistencia de esa referencia.

### Ritmo vs. métrica vs. subdivisión
- `ritmo`: organización de duraciones y ataques.
- `métrica`: organización jerárquica de pulsos.
- `subdivisión`: división interna del pulso.

### Densidad vs. textura
- `densidad`: cantidad/concentración de eventos.
- `textura`: relación entre capas y voces.

### Motivo vs. frase
- `motivo`: unidad breve que puede desarrollarse o repetirse.
- `frase`: unidad de mayor extensión con dirección y cierre.

### Arpegio vs. escala
- `arpegio`: despliegue de notas de un acorde.
- `escala`: sucesión organizada de alturas que funciona como marco melódico/armónico.

### Nota de paso vs. aproximación cromática
- `nota_de_paso`: conecta notas estructurales normalmente mediante movimiento conjunto.
- `aproximacion_cromatica`: se dirige cromáticamente a una nota objetivo.

### Montuno vs. guajeo vs. tumbao
- `montuno`: puede referirse a una sección formal y, por extensión, a un patrón pianístico asociado.
- `guajeo`: patrón ostinato característico de acompañamiento, históricamente asociado al tres y también al piano.
- `tumbao`: patrón repetitivo cuya función/rol depende del instrumento y contexto.

---

## M. Términos que NO deben utilizarse como diagnósticos automáticos

| Observación | No concluir automáticamente |
|---|---|
| densidad alta | "tocas confuso" |
| rango amplio | "la melodía es amplia" |
| nota más aguda | "esa es la melodía" |
| nota más grave | "ese es el bajo" |
| notas cortas | "staccato" |
| notas largas | "legato" |
| tempo rápido | "tempo incorrecto" |
| tempo lento | "tempo demasiado lento" |
| síncopas | "son cubano" |
| patrón repetitivo | "montuno" |
| patrón de piano repetitivo | "tumbao" sin contexto |
| 6/8 | "bambuco" |
| 3/4 | "bambuco" |
| cromatismo | "bebop" |
| pocas notas simultáneas | "shell voicing" |
| omisión de fundamental | "rootless voicing" |
| tercera y séptima detectadas | "guide tones" si no hay contexto de función |
| dinámica baja | "tocas sin expresión" |
| poca variación | "mala musicalidad" |
| score bajo | "eres peor pianista" |

---

## N. Prioridad de implementación v1

Aunque el banco completo contiene muchos términos, el sistema no debería enviar todos al modelo.

Priorizar inicialmente:

1. tempo
2. pulso
3. estabilidad_del_pulso
4. subdivision
5. densidad_ritmica
6. silencio
7. dinamica
8. contraste_dinamico
9. registro
10. rango
11. fraseo
12. articulacion
13. frase
14. motivo
15. cromatismo
16. tension
17. resolucion
18. swing
19. sincopa
20. anticipacion

Después incorporar progresivamente:

- ii–V–I
- guide tones
- conducción de voces
- voicings
- aproximaciones cromáticas
- encierros
- clave
- montuno
- tumbao
- guajeo
- vocabulario específico de jazz colombiano.

---

## Principio final

El banco no existe para que PianoStudy utilice más terminología.

Existe para que PianoStudy utilice **la terminología correcta cuando realmente corresponde**.

La prioridad es:

evidencia → interpretación musical → lenguaje adecuado → recomendación pedagógica.

No:

métrica → palabra técnica → diagnóstico.
