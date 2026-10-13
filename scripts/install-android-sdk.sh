#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${JAVA_HOME:-}" && -x "$PROJECT_DIR/.local/jdk21/bin/javac" ]]; then
  export JAVA_HOME="$PROJECT_DIR/.local/jdk21"
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
if [[ "${JAVA_HOME:-}" == "$PROJECT_DIR/.local/jdk21" && -r /etc/ssl/certs/java/cacerts ]]; then
  export SDKMANAGER_OPTS="${SDKMANAGER_OPTS:-} -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$PROJECT_DIR/.local/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$PROJECT_DIR/.local/android-user}"
DOWNLOAD_DIR="$PROJECT_DIR/.local/android-downloads"
SDK_MANAGER="$ANDROID_HOME/cmdline-tools/19.0/bin/sdkmanager"

for dependency in java curl unzip python3 sha1sum; do
  command -v "$dependency" >/dev/null || { printf 'Instale %s antes de continuar.\n' "$dependency" >&2; exit 1; }
done
mkdir -p "$ANDROID_HOME/cmdline-tools" "$ANDROID_USER_HOME/cache" "$DOWNLOAD_DIR"

SDK_PROXY_ARGS=()
if [[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]]; then
  read -r ANDROID_PROXY_HOST ANDROID_PROXY_PORT < <(python3 - <<'PY'
import os
from urllib.parse import urlparse
proxy = urlparse(os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or '')
if proxy.username or proxy.password:
    raise SystemExit('Proxy autenticado: configure autenticação Java pelo mecanismo do seu ambiente.')
if proxy.scheme != 'http' or not proxy.hostname:
    raise SystemExit('SDK Manager requer um proxy HTTP em HTTPS_PROXY (http://host:porta).')
print(proxy.hostname, proxy.port or 80)
PY
  )
  SDK_PROXY_ARGS=(--proxy=http --proxy_host="$ANDROID_PROXY_HOST" --proxy_port="$ANDROID_PROXY_PORT")
fi

if [[ ! -x "$SDK_MANAGER" ]]; then
  [[ "$(uname -s)" == 'Linux' ]] || { printf 'Use Android Studio para instalar o SDK neste sistema.\n' >&2; exit 1; }
  [[ ! -e "$ANDROID_HOME/cmdline-tools/19.0" ]] || {
    printf 'cmdline-tools/19.0 já existe sem sdkmanager. Preserve ou remova a instalação incompleta antes de continuar.\n' >&2
    exit 1
  }
  # Command-line Tools 19.0, checksum publicado no repositório oficial Google.
  # A versão é fixada para evitar mudanças de CLI em instalações futuras.
  ARCHIVE="commandlinetools-linux-13114758_latest.zip"
  curl --fail --location --retry 2 --connect-timeout 20 --max-time 300 \
    "https://dl.google.com/android/repository/$ARCHIVE" -o "$DOWNLOAD_DIR/$ARCHIVE"
  printf '%s  %s\n' '5fdcc763663eefb86a5b8879697aa6088b041e70' "$DOWNLOAD_DIR/$ARCHIVE" | sha1sum --check
  STAGING_DIR="$(mktemp -d "$DOWNLOAD_DIR/unpack.XXXXXX")"
  unzip -q "$DOWNLOAD_DIR/$ARCHIVE" -d "$STAGING_DIR"
  mv "$STAGING_DIR/cmdline-tools" "$ANDROID_HOME/cmdline-tools/19.0"
  rmdir "$STAGING_DIR"
  rm -f "$DOWNLOAD_DIR/$ARCHIVE"
fi

# Mantém caches em .local; não redefine HOME nem altera o Java instalado.
# As licenças do SDK são aceitas para construir este projeto de desenvolvimento.
set +e
yes 2>/dev/null | "$SDK_MANAGER" --sdk_root="$ANDROID_HOME" "${SDK_PROXY_ARGS[@]}" --licenses > "$DOWNLOAD_DIR/licenses.log" 2>&1
LICENSE_STATUS=${PIPESTATUS[1]}
set -e
if [[ "$LICENSE_STATUS" -ne 0 ]]; then
  tail -n 20 "$DOWNLOAD_DIR/licenses.log" >&2
  exit "$LICENSE_STATUS"
fi
"$SDK_MANAGER" --sdk_root="$ANDROID_HOME" "${SDK_PROXY_ARGS[@]}" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'build-tools;34.0.0'
test -s "$ANDROID_HOME/platforms/android-35/android.jar"
test -x "$ANDROID_HOME/build-tools/35.0.0/aapt2"
printf 'Android SDK 35 pronto em %s\n' "$ANDROID_HOME"
