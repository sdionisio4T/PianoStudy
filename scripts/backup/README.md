# Scripts de backup — setup

Dos scripts PowerShell, pensados para correr sin supervisión desde Windows
Task Scheduler:

- `backup_db_weekly.ps1` — dump de la base de datos (semanal).
- `backup_storage_monthly.ps1` — descarga del bucket `recordings` (mensual).

Ambos escriben su log dentro de `backups/` y devuelven código de salida ≠ 0
si algo falló (Task Scheduler lo puede usar para marcar la tarea como fallida
y, si lo configurás, mandarte una notificación).

## 1. Variables de entorno necesarias (una sola vez)

Abrí PowerShell **como administrador** y corré:

```powershell
[Environment]::SetEnvironmentVariable("SUPABASE_DB_URL", "postgresql://postgres:TU_PASSWORD@db.XXXX.supabase.co:5432/postgres", "User")
[Environment]::SetEnvironmentVariable("SUPABASE_URL", "https://mtejpgwjdhzuqrqfdlud.supabase.co", "User")
[Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY", "TU_SERVICE_ROLE_KEY", "User")
```

Sacá esos valores de Supabase Dashboard → Project Settings → Database
(connection string) y → API (service_role key). **No los pegues en ningún
archivo del repo.**

Cerrá y volvé a abrir cualquier terminal (y reiniciá el Task Scheduler si ya
lo tenías abierto) para que tome las variables nuevas.

## 2. Probar los scripts a mano antes de programarlos

```powershell
powershell -File "scripts\backup\backup_db_weekly.ps1"
powershell -File "scripts\backup\backup_storage_monthly.ps1"
```

Revisá que se haya creado `backups/db/backup_<fecha>.sql` y
`backups/storage/<año-mes>/...` respectivamente, y que los `.log` no tengan
errores.

## 3. Programar en Windows Task Scheduler

### Backup semanal de DB

1. Abrí "Programador de tareas" (Task Scheduler).
2. `Crear tarea básica` → nombre: `PianoStudy - Backup DB semanal`.
3. Desencadenador: **Semanalmente**, elegí día/hora (ej. domingos 3am).
4. Acción: **Iniciar un programa**.
   - Programa/script: `powershell.exe`
   - Argumentos:
     ```
     -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ACER\CascadeProjects\windsurf-project-2\scripts\backup\backup_db_weekly.ps1"
     ```
5. En la pestaña "Condiciones", si la compu no siempre está prendida a esa
   hora, activá "Ejecutar tarea tan pronto como sea posible después de una
   inicio programado perdido".
6. En "Configuración", activá "Ejecutar la tarea lo antes posible si se
   pierde una ejecución programada" y considerá un límite de reintentos.
7. Guardar. Podés forzar una ejecución de prueba con botón derecho → Ejecutar.

### Backup mensual de storage

Mismos pasos, con:
- Nombre: `PianoStudy - Backup Storage mensual`.
- Desencadenador: **Mensualmente**, día 1 (o el que prefieras).
- Argumentos:
  ```
  -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ACER\CascadeProjects\windsurf-project-2\scripts\backup\backup_storage_monthly.ps1"
  ```

## 4. Mirror de código a GitLab

`scripts/git/mirror_to_gitlab.sh` **no está pensado para automatizar** —
hace `git push` a un remote externo y conviene correrlo a mano cuando
querés sincronizar (o como mucho, revisado en un cron manual, no en Task
Scheduler sin supervisión). Instrucciones de uso dentro del script.

## 5. `backups/` no debería ir a git

`backups/db/*.sql` y `backups/storage/**` pueden contener datos personales de
usuarios (grabaciones de audio, emails en el dump de DB). Antes de la primera
corrida, agregá esto a `.gitignore` si no está:

```
backups/
```
