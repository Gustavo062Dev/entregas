#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JDK_DIR="$PROJECT_DIR/.local/jdk21"
DOWNLOAD_DIR="$PROJECT_DIR/.local/android-downloads"
[[ "$(uname -s)" == 'Linux' && "$(uname -m)" == 'x86_64' ]] || {
  printf 'Instale um JDK 21 compatível com seu sistema e configure JAVA_HOME.\n' >&2
  exit 1
}
if [[ -x "$JDK_DIR/bin/javac" ]]; then
  JDK_VERSION="$("$JDK_DIR/bin/javac" -version 2>&1)"
  [[ "$JDK_VERSION" == 'javac 21.'* ]] || { printf 'A instalação em %s não é JDK 21. Configure JAVA_HOME com um JDK 21.\n' "$JDK_DIR" >&2; exit 1; }
  printf '%s\n' "$JDK_VERSION"
  exit 0
fi
[[ ! -e "$JDK_DIR" ]] || { printf '%s já existe sem javac. Preserve ou remova a instalação incompleta antes de continuar.\n' "$JDK_DIR" >&2; exit 1; }
for dependency in curl tar sha256sum; do
  command -v "$dependency" >/dev/null || { printf 'Instale %s antes de continuar.\n' "$dependency" >&2; exit 1; }
done
mkdir -p "$DOWNLOAD_DIR"
JDK_URL='https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz'
curl --fail --location --retry 2 --connect-timeout 20 --max-time 60 "$JDK_URL.sha256" -o "$DOWNLOAD_DIR/jdk21.sha256"
JDK_CHECKSUM="$(tr -d '[:space:]' < "$DOWNLOAD_DIR/jdk21.sha256")"
[[ "$JDK_CHECKSUM" =~ ^[a-fA-F0-9]{64}$ ]] || { printf 'Checksum oficial do JDK inválido.\n' >&2; exit 1; }
curl --fail --location --retry 2 --connect-timeout 20 --max-time 300 "$JDK_URL" -o "$DOWNLOAD_DIR/jdk21.tar.gz"
printf '%s  %s\n' "$JDK_CHECKSUM" "$DOWNLOAD_DIR/jdk21.tar.gz" | sha256sum --check
STAGING_DIR="$(mktemp -d "$PROJECT_DIR/.local/jdk21.unpack.XXXXXX")"
tar -xzf "$DOWNLOAD_DIR/jdk21.tar.gz" -C "$STAGING_DIR" --strip-components=1
test -x "$STAGING_DIR/bin/javac"
mv "$STAGING_DIR" "$JDK_DIR"
rm -f "$DOWNLOAD_DIR/jdk21.tar.gz"
"$JDK_DIR/bin/javac" -version
printf 'JDK local pronto em %s\n' "$JDK_DIR"
