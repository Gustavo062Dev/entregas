# Rota · Gestão de entregas

Primeira etapa do produto: **painel administrativo web e aplicativo Android do entregador**, com navegação demonstrativa dentro do próprio aplicativo. A integração com o Alpha7 será a última etapa, conforme a prioridade definida.

A publicação automática do painel está preparada para GitHub Pages. Veja [a ativação e validação da hospedagem](docs/PUBLICACAO.md).

## Abrir o painel sem instalar o projeto

O arquivo `painel-rota.html` é uma versão interativa portátil. Baixe o arquivo e abra-o no Chrome do computador. Fontes, estilos, ícones e código estão incorporados, sem dependências de arquivos auxiliares. O botão **App do entregador** abre a prévia do entregador usando o mesmo HTML; os links de retorno preservam o nome e a localização do arquivo.

Para gerar novamente:

```sh
npm ci
npm run build:portable
```

Resultado: `.local/artifacts/painel-rota.html`. É uma demonstração local, sem endereço público nem conexão entre computadores. Os dados são armazenados pelo navegador quando ele permite armazenamento local. O build normal e o projeto Android continuam usando as rotas `/` e `/entregador`.

O HTML foi validado como documento único servido por HTTP local, incluindo links, cadastros, relatórios e entregas. O navegador automatizado deste ambiente bloqueia navegação em `file://`; por isso a abertura direta por duplo clique ainda precisa ser confirmada no computador do usuário.

## Executar

Requisitos: Node.js 22 ou superior e npm. O arquivo `package-lock.json` fixa as versões instaladas.

```sh
npm ci
npm run dev
```

O Vite informa o endereço local. O caminho `/` abre o painel; `/entregador` abre a interface do entregador no navegador. O botão **App do entregador** no painel também abre essa interface. No Android, o aplicativo abre diretamente a interface do entregador.

```sh
npm test
npm run build
npm run preview
```

O build de produção fica em `dist/`. Para servir em produção, configure seu servidor para retornar `index.html` nas rotas da aplicação.

Há também um teste de interface reutilizável em `scripts/ui-smoke.py`. Com o servidor Vite em execução, use `python scripts/ui-smoke.py` em um ambiente com Python, Playwright e Chromium. Neste ambiente essas ferramentas já estão disponíveis. `UI_SMOKE_URL` altera o endereço testado e `CHROMIUM_EXECUTABLE` permite selecionar o navegador. O teste usa um contexto isolado, exercita as duas interfaces e escreve resultados em `.local/qa/`.

O mesmo teste aceita o endereço de um HTML portátil em `UI_SMOKE_URL`; ele verifica também a troca entre painel e entregador. `UI_SMOKE_OUTPUT` permite salvar o relatório e as capturas em outra pasta.

## O que funciona nesta etapa

- Painel: indicadores derivados dos dados, seleção de entregadores no mapa, busca de entregas, filtros e atribuição de entregas pendentes.
- Relatórios: filtro por período e entregador, quilômetros demonstrativos e download CSV.
- Usuários: cadastro, edição e ativação/desativação local. O último administrador ativo é preservado.
- Entregador: seleção de perfil demonstrativo, turno, lista de entregas, mapa da rota dentro do app, instruções, progresso do percurso, confirmação de recebimento, histórico e perfil.
- Fluxo compartilhado: iniciar uma rota, avançar a simulação, informar o recebedor e confirmar a entrega atualiza os indicadores e os relatórios. Um entregador não pode iniciar duas rotas simultâneas.
- Dados salvos localmente e sincronizados entre abas **do mesmo navegador e da mesma origem**. A versão Android tem armazenamento próprio.

## Android

O projeto nativo está em `android/`, usando Capacitor 7 e Java 21. Veja [como compilar e instalar](docs/ANDROID.md).

```sh
npm run android:sync
npm run android:open
```

Também é possível usar `scripts/build-android.sh` com um Android SDK local já instalado. O APK debug é um artefato de desenvolvimento; a assinatura e publicação de produção serão feitas em etapa posterior.

## Limites da demonstração

Todos os nomes, entregas, endereços e valores apresentados são dados demonstrativos. O mapa é uma ilustração e não representa uma malha viária utilizável para condução. As posições e os quilômetros mudam pelo botão de simulação; o aplicativo **ainda não captura GPS nem oferece orientação real para dirigir**.

Esta etapa não possui servidor, login, permissões de acesso, banco compartilhado entre dispositivos, Alpha7 ou sincronização Android–painel. O gerenciamento de usuários demonstra a interface e as regras locais; não protege acesso a dados. Não use a demonstração para uma operação real.

A navegação definitiva será **dentro do aplicativo**, com um provedor de mapas e rotas. Não depende de abrir Waze ou Google Maps.

## Organização

```text
src/admin/          Painel administrativo e suas telas
src/driver/         Aplicativo do entregador
src/components/     Mapa demonstrativo compartilhado
src/types.ts        Contratos dos dados e ações
src/demo.ts         Dados fictícios
src/store.ts        Estado local e regras do fluxo
src/store.test.ts   Testes das regras de entregas e usuários
android/            Aplicação Android nativa
scripts/            Ferramentas para build Android
```

Fontes, ícones e mapa estão no bundle e funcionam sem serviços externos. A construção das interfaces não solicita credenciais.

## Próximas etapas

1. Revisar as interfaces com a operação e ajustar campos e fluxos.
2. Implementar API, autenticação e banco compartilhado.
3. Implementar GPS com permissões Android, captura em segundo plano, fila offline e medição validada de quilômetros.
4. Implementar mapas e navegação real dentro do aplicativo, testar em dispositivo Android e conectar ao acompanhamento no painel.
5. Integrar pedidos e endereços do Alpha7 após confirmar sua API ou formato de exportação.

As próximas etapas estão documentadas para manter clara a diferença entre as interfaces criadas agora e o sistema operacional completo.
