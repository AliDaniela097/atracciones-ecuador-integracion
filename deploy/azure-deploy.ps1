# Despliegue en Azure App Service (Linux, B1) de la tienda de Atracciones + sus 3 microservicios en UN solo contenedor.
# Uso (PowerShell, desde la carpeta Proyecto_Atracciones_Web):   .\deploy\azure-deploy.ps1 -App alisson-atracciones-api
# Requisitos: az login hecho con la suscripcion "Azure for Students", Node 22+, Python.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [string]$Location = 'northcentralus'
)
$ErrorActionPreference = 'Stop'
$rg = "rg-$App"
$plan = "plan-$App"
function Invoke-Az { & az.cmd @args; if ($LASTEXITCODE -ne 0) { throw "Fallo: az $($args -join ' ')" } }

Write-Host "`n[1/9] Suscripcion activa:" -ForegroundColor Cyan
Invoke-Az account show --query "{suscripcion:name, usuario:user.name}" -o table
Write-Host "Si NO dice Azure for Students, detente (Ctrl+C) y ejecuta: az account set --subscription <nombre>" -ForegroundColor Yellow

Write-Host "`n[2/9] Registrando el proveedor Microsoft.Web (puede tardar 1-2 minutos)..." -ForegroundColor Cyan
Invoke-Az provider register --namespace Microsoft.Web --wait

Write-Host "`n[3/9] Grupo de recursos $rg en $Location..." -ForegroundColor Cyan
$existe = (& az.cmd group exists --name $rg)
if ($existe -eq 'true') { Write-Host "El grupo $rg ya existe; se reutiliza." } else { Invoke-Az group create --name $rg --location $Location -o none }

Write-Host "`n[4/9] Plan de App Service Linux B1..." -ForegroundColor Cyan
$regiones = @($Location) + @('mexicocentral','francecentral','spaincentral','belgiumcentral','northcentralus' | Where-Object { $_ -ne $Location })
$creado = $false
$ErrorActionPreference = 'Continue'
foreach ($r in $regiones) {
  Write-Host "Probando B1 en $r ..."
  & az.cmd appservice plan create --name $plan --resource-group $rg --is-linux --sku B1 --location $r -o none 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $Location = $r; $creado = $true; Write-Host "OK: plan creado en $r" -ForegroundColor Green; break }
  Write-Host "  sin cuota o no disponible en $r" -ForegroundColor Yellow
}
$ErrorActionPreference = 'Stop'
if (-not $creado) { throw "Ninguna region permitida tiene cuota de B1. Hay que pedir cuota en el portal (Suscripciones > Uso y cuotas) o probar otro SKU." }

Write-Host "`n[5/9] Aplicacion web (Node 22)..." -ForegroundColor Cyan
$lista = @(& az.cmd webapp list-runtimes --os-type linux -o tsv 2>$null | Where-Object { $_ -match '^(?i)node' })
Write-Host ("Runtimes Node disponibles: " + ($lista -join ', '))
$runtime = ($lista | Where-Object { $_ -match '22' } | Select-Object -First 1)
if (-not $runtime) { $runtime = ($lista | Where-Object { $_ -match '24' } | Select-Object -First 1) }
if (-not $runtime) { $runtime = ($lista | Where-Object { $_ -match '20' } | Select-Object -First 1) }
if (-not $runtime) { throw "No encontre un runtime Node valido. Ejecuta: az webapp list-runtimes --os-type linux  y envia la salida." }
$runtime = (($runtime -split '\s+')[0]) -replace '\|', ':'
Write-Host "Runtime: $runtime"
Invoke-Az webapp create --name $App --resource-group $rg --plan $plan --runtime $runtime -o none

Write-Host "`n[6/9] Configuracion: HTTPS, TLS 1.2, Always On y comando de inicio..." -ForegroundColor Cyan
Invoke-Az webapp update --name $App --resource-group $rg --https-only true -o none
Invoke-Az webapp config set --name $App --resource-group $rg --always-on true --min-tls-version 1.2 --startup-file "node azure-start.mjs" -o none
try {
  '{"healthCheckPath":"/api/v3/atracciones/health"}' | Set-Content -Encoding ascii "$PSScriptRoot\health.json"
  Invoke-Az webapp config set --name $App --resource-group $rg --generic-configurations "@$PSScriptRoot\health.json" -o none
} catch { Write-Host "Aviso: no se pudo fijar el health check por CLI. Hazlo en el portal: App Service > Supervision > Comprobacion de estado > ruta /api/v3/atracciones/health" -ForegroundColor Yellow }

Write-Host "`n[7/9] Variables de entorno (se leen de tus .env; no se muestran)..." -ForegroundColor Cyan
node "$PSScriptRoot\make-settings.mjs" $App
if ($LASTEXITCODE -ne 0) { throw "No se pudo generar azure-settings.json" }
Invoke-Az webapp config appsettings set --name $App --resource-group $rg --settings "@$PSScriptRoot\azure-settings.json" -o none

Write-Host "`n[8/9] Empaquetando (compila, instala dependencias de produccion y crea el zip)..." -ForegroundColor Cyan
node "$PSScriptRoot\build-package.mjs"
if ($LASTEXITCODE -ne 0) { throw "Fallo el empaquetado" }

Write-Host "`n[9/9] Subiendo el zip a Azure..." -ForegroundColor Cyan
Invoke-Az webapp deploy --name $App --resource-group $rg --src-path "$PSScriptRoot\deploy.zip" --type zip --async true

Write-Host "`nListo. Azure tarda unos minutos en arrancar. Comprueba con:" -ForegroundColor Green
Write-Host "  curl https://$App.azurewebsites.net/api/v3/atracciones/health"
Write-Host "Ver el registro en vivo:  az webapp log tail --name $App --resource-group $rg"
