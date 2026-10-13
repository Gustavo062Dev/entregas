# Aplicativo Android

O projeto nativo em `android/` usa Capacitor 7 e abre diretamente a tela do entregador. O painel administrativo continua disponível no navegador. A navegação apresentada nesta primeira versão é uma demonstração dentro do aplicativo; integração com Alpha7, GPS contínuo e cálculo de rotas reais ficam para a etapa de integração.

## Gerar um APK de desenvolvimento

Requisitos: Node.js 22 ou superior, JDK 21 e Android SDK 35. No Linux, os scripts usam caches em `.local/`, que não são versionados.

```bash
npm ci
bash scripts/install-jdk21.sh # opcional se já tiver um JDK 21 completo
bash scripts/install-android-sdk.sh
bash scripts/build-android.sh
```

O instalador baixa Command-line Tools 19.0 do domínio oficial Google, verifica o SHA-1 publicado no [manifesto oficial do SDK](https://dl.google.com/android/repository/repository2-3.xml) e instala plataforma 35, Build Tools 35.0.0/34.0.0 e Platform Tools. A biblioteca Capacitor utiliza Build Tools 34 e o app utiliza 35. Aceita as licenças do SDK para compilar o projeto. Caso já tenha o SDK, configure `ANDROID_HOME` com seu caminho e execute apenas o script de build. O Gradle Wrapper verifica o SHA-256 da distribuição oficial 8.11.1. Downloads preservam a verificação TLS.

Resultado: `android/app/build/outputs/apk/debug/app-debug.apk`. O APK debug usa uma assinatura de desenvolvimento, adequada para teste em aparelhos; publicação na Play Store precisa de assinatura de release e configuração própria.

O instalador opcional de JDK baixa o Oracle JDK 21 oficial para Linux x64, verifica o SHA-256 publicado pela Oracle e o mantém em `.local/jdk21`. Consulte a [licença do Oracle JDK](https://www.oracle.com/java/technologies/javase/jdk-faqs.html) para seu tipo de uso. Também pode usar uma distribuição OpenJDK 21 instalada separadamente e configurar `JAVA_HOME`. O build usa o JDK local quando `JAVA_HOME` não estiver definido. Ter apenas o comando `java` (JRE) não basta: é necessário `javac`.

Quando usa o JDK local no Linux, o script reutiliza `/etc/ssl/certs/java/cacerts`, se disponível, preservando as autoridades de certificação do sistema. O diretório Java de usuário fica em `.local/java-user` e a chave de assinatura debug fica em `.local/android-user/debug.keystore`, sem alterar `HOME`.

Com um aparelho autorizado conectado por USB:

```bash
.local/android-sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

O app requer Android 6.0 (API 23) ou superior. Não exige credenciais de API para as telas demonstrativas. Os dados demonstrativos são armazenados localmente em cada instalação; o painel web e o APK não sincronizam dados entre aparelhos nesta etapa.

## Usar Android Studio

Instale SDK 35 e JDK 21 pelo Android Studio. Execute `npm ci`, `npm run android:sync` e `npm run android:open`. Selecione um aparelho ou emulador e use Run. Sempre execute `npm run android:sync` depois de alterar as telas para atualizar o bundle incluído no app.

## Repetir builds

O script recompila as telas e faz `cap sync android` antes do build nativo. `bash scripts/build-android.sh --skip-web` reaproveita um `dist/` já compilado, quando a compilação web tiver sido executada e validada separadamente. `ANDROID_HOME`, `ANDROID_USER_HOME` e `GRADLE_USER_HOME` podem apontar para instalações e caches existentes.

Em ambientes com um proxy HTTP configurado em `HTTPS_PROXY` (`http://host:porta`), os scripts encaminham host e porta para o Java e o SDK Manager, sem salvar configurações de rede no repositório. Proxies com autenticação ou transporte TLS próprio precisam ser configurados pelo mecanismo de autenticação Java do ambiente. A compilação inicial precisa alcançar `dl.google.com`, `services.gradle.org`, os destinos de download da distribuição Gradle e `repo.maven.apache.org`. A validação do build não substitui testes de uso em um aparelho Android real.
