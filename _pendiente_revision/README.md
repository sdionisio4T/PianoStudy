# _pendiente_revision/

Carpeta para archivos que quedaron reemplazados durante la sesión remota del
2026-08-09, movidos acá en vez de borrados (regla del modo remoto: no se
borra nada que no se haya creado en la misma sesión).

## `app.js` (original, monolítico, 4655 líneas)

Reemplazado por el split de la Fase 2 (tarea 2.2) en `assets/js/app/`:
`app-state.js`, `app-ui.js`, `app-controllers.js`, `app-audio-flow.js`,
`app-init.js`. `index.html` ya apunta al nuevo entry point
(`assets/js/app/app-init.js`), no a este archivo.

El split se verificó de dos formas:
1. Un script de verificación reconstruyó el contenido de los 171 métodos en
   su orden original a partir de los 5 archivos nuevos y lo comparó
   byte-a-byte (ignorando líneas en blanco) contra este archivo original —
   coincide exactamente, no se perdió ni duplicó código.
2. `npm run build` (Vite) compila el grafo de módulos completo sin errores
   de imports/referencias.

**Qué falta antes de poder borrar este archivo con confianza total:** probar
la app en un browser real contra el proyecto Supabase real (login, grabar,
guardar licks, etc.) — la sesión remota pudo verificar carga de página y
ausencia de errores de consola con un server estático local, pero no pudo
ejercitar los flujos que requieren sesión autenticada real. Ver
`RESUMEN_SESION_REMOTA_2026-08-09.md` para el detalle completo.

Una vez que confirmes que la app dividida funciona igual que antes, podés
borrar esta carpeta entera.
