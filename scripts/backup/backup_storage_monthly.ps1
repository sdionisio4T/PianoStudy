<#
.SYNOPSIS
    Backup mensual del bucket "recordings" de Supabase Storage, vía REST API.

.DESCRIPTION
    Recorre recursivamente todo el bucket (list API), descarga cada archivo
    (download API) y lo guarda localmente bajo backups/storage/<fecha>/,
    preservando la misma estructura de carpetas que tiene en Supabase
    (ej: "<user_id>/171234.webm", "licks/<user_id>/<lick_id>.wav").

    Puede ser el dataset más pesado del proyecto (grabaciones de usuarios) —
    correrlo en una conexión con buen ancho de banda y espacio en disco.

.NOTES
    Requiere la variable de entorno SUPABASE_SERVICE_ROLE_KEY (Project Settings
    → API → service_role key). Se usa la service_role y NO la anon key porque:
      - Bypassa cualquier RLS/policy de storage.objects, así que el backup no
        depende de que la policy de lectura pública siga existiendo (ver
        DIAGNOSTICO_Y_PLAN.md 2.4 — esa policy puede cambiar a futuro).
      - La service_role key tiene privilegios totales: NUNCA debe usarse en el
        cliente ni commitearse. Solo vive en esta variable de entorno local.

    Setear la variable una sola vez (terminal de administrador):
        [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY", "TU_SERVICE_ROLE_KEY", "User")
        [Environment]::SetEnvironmentVariable("SUPABASE_URL", "https://mtejpgwjdhzuqrqfdlud.supabase.co", "User")

    Abrí una terminal nueva después de setearlas.
#>

$ErrorActionPreference = 'Stop'

$BUCKET = 'recordings'
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dateStr = Get-Date -Format 'yyyy-MM'
$destDir = Join-Path $rootDir "backups\storage\$dateStr"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

$logFile = Join-Path $rootDir 'backups\storage\backup_storage.log'
function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Output $line
    Add-Content -Path $logFile -Value $line
}

Write-Log "=== Iniciando backup mensual de storage ($BUCKET) → $destDir ==="

if (-not $env:SUPABASE_SERVICE_ROLE_KEY) {
    Write-Log "ERROR: falta SUPABASE_SERVICE_ROLE_KEY. Ver cabecera del script."
    exit 1
}
if (-not $env:SUPABASE_URL) {
    Write-Log "ERROR: falta SUPABASE_URL. Ver cabecera del script."
    exit 1
}

$headers = @{
    'apikey'        = $env:SUPABASE_SERVICE_ROLE_KEY
    'Authorization' = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
    'Content-Type'  = 'application/json'
}

function Get-ObjectsRecursive {
    param([string]$Prefix = '')

    $files = @()
    $offset = 0
    $limit = 100

    while ($true) {
        $listUrl = "$($env:SUPABASE_URL)/storage/v1/object/list/$BUCKET"
        $body = @{
            prefix = $Prefix
            limit  = $limit
            offset = $offset
            sortBy = @{ column = 'name'; order = 'asc' }
        } | ConvertTo-Json -Compress

        $page = Invoke-RestMethod -Method Post -Uri $listUrl -Headers $headers -Body $body

        foreach ($item in $page) {
            $fullPath = if ($Prefix) { "$Prefix/$($item.name)" } else { $item.name }
            # En la API de Storage, las "carpetas" vienen sin id/metadata; los
            # archivos reales sí tienen metadata (tamaño, mimetype, etc).
            if ($null -eq $item.id -and $null -eq $item.metadata) {
                $files += Get-ObjectsRecursive -Prefix $fullPath
            } else {
                $files += $fullPath
            }
        }

        if ($page.Count -lt $limit) { break }
        $offset += $limit
    }

    return $files
}

Write-Log "Listando objetos..."
try {
    $allFiles = Get-ObjectsRecursive -Prefix ''
} catch {
    Write-Log "ERROR listando objetos: $($_.Exception.Message)"
    exit 1
}
Write-Log "Encontrados $($allFiles.Count) archivos."

$okCount = 0
$failCount = 0

foreach ($path in $allFiles) {
    $localPath = Join-Path $destDir ($path -replace '/', '\')
    $localDir = Split-Path $localPath -Parent
    New-Item -ItemType Directory -Force -Path $localDir | Out-Null

    $downloadUrl = "$($env:SUPABASE_URL)/storage/v1/object/$BUCKET/$path"
    try {
        Invoke-WebRequest -Method Get -Uri $downloadUrl -Headers $headers -OutFile $localPath | Out-Null
        $okCount++
    } catch {
        Write-Log "ERROR descargando '$path': $($_.Exception.Message)"
        $failCount++
    }
}

Write-Log "=== Backup mensual de storage completado: $okCount OK, $failCount fallidos ==="
if ($failCount -gt 0) { exit 1 }
exit 0
