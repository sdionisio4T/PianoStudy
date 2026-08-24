-- Agrega columna `format` a la tabla `recordings`.
--
-- Contexto: desde que se sumó grabación por MIDI (MidiRecorder.js),
-- SupabaseDataManager.uploadRecording envía `format: 'midi' | 'audio'` en el
-- insert. Como la columna no existía, Postgres devolvía 42703 y todas las
-- grabaciones MIDI fallaban en el upload (quedaban solo en memoria local).
--
-- Default 'audio' para que las filas históricas conserven el comportamiento
-- previo. NOT NULL es seguro porque el default cubre inserts que no manden el
-- campo, y el client siempre lo manda.

alter table recordings
    add column if not exists format text not null default 'audio';
