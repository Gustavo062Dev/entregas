#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
if [[ -z "${JAVA_HOME:-}" && -x "$PROJECT_DIR/.local/jdk21/bin/javac" ]]; then
  export JAVA_HOME="$PROJECT_DIR/.local/jdk21"
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$PROJECT_DIR/.local/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$PROJECT_DIR/.local/android-user}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$PROJECT_DIR/.local/gradle}"
mkdir -p "$ANDROID_USER_HOME" "$GRADLE_USER_HOME" "$PROJECT_DIR/.local/java-user/.android"
export GRADLE_OPTS="${GRADLE_OPTS:-} -Duser.home=$PROJECT_DIR/.local/java-user"
ANDROID_BUILD_JVM_ARGS="-Xmx1536m -Duser.home=$PROJECT_DIR/.local/java-user"
if [[ "${JAVA_HOME:-}" == "$PROJECT_DIR/.local/jdk21" && -r /etc/ssl/certs/java/cacerts ]]; then
  # O JDK local reutiliza as autoridades de certificação do sistema gerenciado,
  # incluindo o certificado do proxy quando este estiver provisionado pelo host.
  export GRADLE_OPTS="$GRADLE_OPTS -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"
  ANDROID_BUILD_JVM_ARGS="$ANDROID_BUILD_JVM_ARGS -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"
fi

if [[ "${1:-}" != '' && "${1:-}" != '--skip-web' ]]; then
  printf 'Uso: %s [--skip-web]\n' "$0" >&2
  exit 1
fi
test -d node_modules || { printf 'Execute npm ci antes de compilar.\n' >&2; exit 1; }
test -s "$ANDROID_HOME/platforms/android-35/android.jar" || {
  printf 'SDK 35 ausente. Execute bash scripts/install-android-sdk.sh ou configure ANDROID_HOME.\n' >&2
  exit 1
}
command -v java >/dev/null || { printf 'Instale JDK 21 antes de compilar.\n' >&2; exit 1; }
command -v javac >/dev/null || {
  printf 'O compilador javac está ausente. Instale JDK 21 completo; um JRE não é suficiente. No Linux x64 use bash scripts/install-jdk21.sh.\n' >&2
  exit 1
}
[[ "$(javac -version 2>&1)" == 'javac 21.'* ]] || { printf 'A compilação requer JDK 21; configure JAVA_HOME.\n' >&2; exit 1; }

if [[ "${1:-}" != '--skip-web' ]]; then
  npm run build
fi
test -s dist/index.html || { printf 'O bundle dist está ausente. Execute npm run build.\n' >&2; exit 1; }
./node_modules/.bin/cap sync android

# Java/Gradle não usam HTTPS_PROXY automaticamente. Encaminha apenas host/porta;
# não grava dados da rede em arquivos nem altera verificação TLS.
if [[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]]; then
  command -v python3 >/dev/null || { printf 'Python 3 necessário para configurar o proxy do Java.\n' >&2; exit 1; }
  read -r ANDROID_PROXY_HOST ANDROID_PROXY_PORT < <(python3 - <<'PY'
import os
from urllib.parse import urlparse
proxy = urlparse(os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or '')
if proxy.username or proxy.password:
    raise SystemExit('Proxy autenticado: configure autenticação Java pelo mecanismo do seu ambiente.')
if proxy.scheme != 'http' or not proxy.hostname:
    raise SystemExit('Gradle requer um proxy HTTP em HTTPS_PROXY (http://host:porta).')
print(proxy.hostname, proxy.port or 80)
PY
  )
  export GRADLE_OPTS="${GRADLE_OPTS:-} -Dhttps.proxyHost=$ANDROID_PROXY_HOST -Dhttps.proxyPort=$ANDROID_PROXY_PORT -Dhttp.proxyHost=$ANDROID_PROXY_HOST -Dhttp.proxyPort=$ANDROID_PROXY_PORT"
  ANDROID_BUILD_JVM_ARGS="$ANDROID_BUILD_JVM_ARGS -Dhttps.proxyHost=$ANDROID_PROXY_HOST -Dhttps.proxyPort=$ANDROID_PROXY_PORT -Dhttp.proxyHost=$ANDROID_PROXY_HOST -Dhttp.proxyPort=$ANDROID_PROXY_PORT"
fi

(cd android && ./gradlew "-Dorg.gradle.jvmargs=$ANDROID_BUILD_JVM_ARGS" --no-daemon --max-workers=2 assembleDebug)
APK="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
test -s "$APK"
printf 'APK de desenvolvimento: %s\n' "$APK"
