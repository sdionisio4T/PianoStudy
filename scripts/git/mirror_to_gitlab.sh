#!/usr/bin/env bash
# Mirror del repositorio a GitLab (o Gitea) — protege contra pérdida de la
# cuenta/repo de GitHub. Pensado para correr manualmente con Git Bash en
# Windows (o cualquier bash), NUNCA de forma automática sin que lo revises,
# porque hace `git push` a un remote externo.
#
# Uso (primera vez, crea el remote):
#   ./scripts/git/mirror_to_gitlab.sh https://gitlab.com/tu-usuario/tu-repo.git
#
# Uso (siguientes veces, ya con el remote configurado):
#   ./scripts/git/mirror_to_gitlab.sh
#
# Requisitos:
#   - Un repo vacío ya creado en GitLab (o Gitea) de antemano — este script
#     no lo crea, solo pushea a uno existente.
#   - Credenciales configuradas para ese remote (SSH key agregada a GitLab,
#     o un Personal Access Token si usás HTTPS). Git te va a pedir
#     autenticación la primera vez si no está seteada.

set -euo pipefail

REMOTE_NAME="gitlab-mirror"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if ! git remote | grep -qx "$REMOTE_NAME"; then
    if [ "${1:-}" = "" ]; then
        echo "El remote '$REMOTE_NAME' no existe todavía."
        echo "Corré este script pasando la URL del repo de GitLab la primera vez:"
        echo "  ./scripts/git/mirror_to_gitlab.sh https://gitlab.com/tu-usuario/tu-repo.git"
        exit 1
    fi
    echo "Agregando remote '$REMOTE_NAME' -> $1"
    git remote add "$REMOTE_NAME" "$1"
else
    echo "Remote '$REMOTE_NAME' ya configurado: $(git remote get-url "$REMOTE_NAME")"
fi

# Nota deliberada: NO usamos `git push --mirror`. Ese flag borra en el
# destino cualquier rama/tag/ref que no exista localmente — es destructivo
# si el remote de GitLab llegó a tener algo propio (aunque sea por error).
# `--all` + `--tags` es un mirror "aditivo": sincroniza lo que tenés acá sin
# arriesgarse a borrar algo del otro lado sin que lo notes.
echo "Pusheando todas las ramas locales a '$REMOTE_NAME'..."
git push "$REMOTE_NAME" --all

echo "Pusheando tags a '$REMOTE_NAME'..."
git push "$REMOTE_NAME" --tags

echo "Mirror a GitLab actualizado correctamente."
