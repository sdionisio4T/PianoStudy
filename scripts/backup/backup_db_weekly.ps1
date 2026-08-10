<#
.SYNOPSIS
    Backup semanal de la base de datos Supabase de PianoStudy vía `supabase db dump`.

.DESCRIPTION
    Vuelca el schema + datos a un archivo .sql con fecha, y rota backups viejos
    (conserva los últimos 4 = ~1 mes de historial semanal).
    Pensado para correr sin supervisión desde Windows Task Scheduler.

.NOTES
    Requiere:
      - Node.js/npx instalado (usa `npx supabase`, no hace falta instalar el CLI global).
      - La variable de entorno SUPABASE_DB_URL con el connection string de Postgres
        (Project Settings → Database → Connection string → "URI", con la contraseña
        incluida). NUNCA hardcodear esa URL acá ni commitearla — contiene credenciales.

    Cómo setear la variable de forma persistente en Windows (una sola vez, en una
    terminal de administrador):
        [Environment]::SetEnvironmentVariable("SUPABASE_DB_URL", "postgresql://postgres:TU_PASSWORD@db.XXXX.supabase.co:5432/postgres", "User")

    Después de setearla, abrí una terminal nueva para que la tome.
#>

$ErrorActionPreference = 'Stop'

$backupDir = Join-Path $PSScriptRoot '..\..\backups\db' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $backupDir) {
    $backupDir = New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot '..\..\backups\db')
}
$backupDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\backups\db')).Path

$logFile = Join-Path $backupDir 'backup_db.log'
function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Output $line
    Add-Content -Path $logFile -Value $line
}

Write-Log "=== Iniciando backup semanal de DB ==="

if (-not $env:SUPABASE_DB_URL) {
    Write-Log "ERROR: falta la variable de entorno SUPABASE_DB_URL. Ver cabecera del script para setearla."
    exit 1
}

$dateStr = Get-Date -Format 'yyyy-MM-dd'
$outFile = Join-Path $backupDir "backup_$dateStr.sql"

try {
    Write-Log "Ejecutando: npx supabase db dump --db-url <oculto> -f $outFile"
    npx supabase db dump --db-url $env:SUPABASE_DB_URL -f $outFile
    if ($LASTEXITCODE -ne 0) {
        throw "supabase db dump devolvió código $LASTEXITCODE"
    }
    if (-not (Test-Path $outFile) -or (Get-Item $outFile).Length -eq 0) {
        throw "El archivo de salida no existe o está vacío: $outFile"
    }
    Write-Log "Backup OK: $outFile ($((Get-Item $outFile).Length) bytes)"
} catch {
    Write-Log "ERROR durante el dump: $($_.Exception.Message)"
    Write-Log "Si el comando cambió de sintaxis entre versiones del CLI, correr 'npx supabase db dump --help' para verificar los flags actuales."
    exit 1
}

# Rotación: conservar solo los últimos 4 backups (~1 mes si corre semanal)
$allBackups = Get-ChildItem -Path $backupDir -Filter 'backup_*.sql' | Sort-Object LastWriteTime -Descending
if ($allBackups.Count -gt 4) {
    $toDelete = $allBackups | Select-Object -Skip 4
    foreach ($f in $toDelete) {
        Write-Log "Rotando: eliminando backup viejo $($f.Name)"
        Remove-Item $f.FullName -Force
    }
}

Write-Log "=== Backup semanal de DB completado ==="
exit 0
