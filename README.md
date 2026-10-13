# Rota · Gestão de entregas

Painel administrativo web e aplicativo Android do entregador, agora com **login, permissões e API compartilhada com banco SQLite**. A integração com o Alpha7 permanece na última etapa.

O administrador gerencia usuários; o gestor acompanha entregas e relatórios e atribui pedidos; cada entregador acessa apenas seus próprios pedidos, perfil e histórico. O servidor valida essas permissões em cada solicitação. As telas consultam atualizações a cada cinco segundos, com sessões independentes por aba/dispositivo.

**Mapa, navegação e quilômetros continuam demonstrativos.** Esta versão não captura GPS nem oferece orientação real para dirigir. A conexão e os cadastros são funcionais; a operação de entregas pode ser exercitada com dados fictícios em um banco de desenvolvimento.

## Executar o sistema conectado

Requisitos: **Node.js 24** e npm. O `package-lock.json` fixa as dependências.

```sh
npm ci
cp .env.example .env
```

Preencha `ROTA_ADMIN_EMAIL`, `ROTA_ADMIN_PASSWORD` e, opcionalmente, `ROTA_ADMIN_NAME` no arquivo `.env`. A senha deve ter de 12 a 128 caracteres. Não existe senha padrão. Esses valores provisionam o primeiro administrador de um banco novo; depois disso, as contas são gerenciadas pelo painel. O arquivo `.env` e os bancos em `.local/` ficam fora do Git.

```sh
npm run dev
```

Esse comando inicia a API na porta 3001 e o Vite na porta 5173. `/` abre o painel; `/entregador` abre a interface do entregador. O Vite encaminha `/api` ao servidor. `npm run dev:ui` inicia somente as telas e exige uma API disponível para login.

O administrador pode cadastrar contas e definir ou redefinir suas senhas em **Usuários**. Um novo usuário com perfil **Entregador** recebe um cadastro de entregador, inicialmente fora do turno. Contas sem vínculo não recebem dados de outro entregador. O perfil Gestor não acessa a gestão de usuários.

Veja [configuração, API e persistência](docs/API.md) e [fluxos das interfaces](docs/INTERFACES.md).

## Exercitar o fluxo de entregas

Para um banco de desenvolvimento **novo e separado**, configure no `.env`:

```dotenv
API_DEMO_SEED=1
DATABASE_PATH=.local/data/demo.sqlite
```

Defina também `ROTA_DEMO_DRIVER_PASSWORD` se quiser provisionar o acesso do entregador `entregador1@example.com`. Sem esse valor, o administrador pode abrir o cadastro desse entregador no painel e definir uma senha. Os demais cadastros fictícios não possuem senha inicial.

Entre no painel com o administrador configurado e, em outro navegador ou contexto privado, no app com o entregador. Inicie uma rota, avance as quatro etapas da simulação e confirme o recebedor. O painel recebe o novo status, histórico e quilômetros pelo servidor, inclusive quando os clientes estão em dispositivos diferentes com acesso à mesma API.

O modo do banco é gravado na primeira inicialização. Mudar `API_DEMO_SEED` depois não transforma um banco operacional em demonstrativo nem apaga dados. Use outro `DATABASE_PATH` para mudar de modo. Um banco operacional novo começa sem pedidos fictícios; entrada de pedidos e GPS serão desenvolvidos nas próximas etapas.

## Verificar e compilar

```sh
npm test
npm run build
```

Os testes cobrem regras de entregas, autenticação, isolamento entre entregadores, revogação de sessões, concorrência, persistência e falhas de conexão. `npm run check` verifica TypeScript nas telas e no servidor.

`npm run build` gera a interface conectada em `dist/`. Para servir interface e API juntas:

```sh
npm start
```

O comando carrega `.env`, inicia em modo de produção e serve `dist/`. Configure HTTPS no proxy reverso para acesso externo; a aplicação Android exige um endereço HTTPS da API. A pasta do banco precisa de armazenamento persistente e backup. A API funciona como processo único; expansão para várias instâncias e banco dedicado fica para uma etapa posterior. [Detalhes da publicação](docs/PUBLICACAO.md).

## Prévia portátil das telas

```sh
npm run build:portable
```

Gera `.local/artifacts/painel-rota.html`: um HTML único com fontes, ícones, estilos e código incorporados. Essa prévia mantém o modo local de demonstração, sem login ou API. O botão **App do entregador** abre a interface pelo mesmo arquivo; a navegação também funciona sob caminhos como `/entregas/`.

A prévia usa armazenamento do navegador, quando disponível, e sincroniza apenas abas da mesma origem. **GitHub Pages hospeda essa demonstração; não hospeda o servidor conectado.** A versão conectada não usa os cadastros locais da prévia.

Há duas verificações de interface em Python/Playwright: `scripts/ui-smoke.py` para a prévia e `scripts/connected-smoke.py` para a API com duas sessões isoladas. Os artefatos de QA ficam em `.local/`. Consulte [o roteiro e as variáveis de QA](docs/INTERFACES.md).

## Android

O projeto nativo está em `android/`, com Capacitor 7, JDK 21 e SDK 35. Ele abre o login do entregador e conecta à mesma API do painel. A sessão tem prazo de 12 horas; o usuário pode sair pelo perfil.

```sh
npm run android:sync
npm run android:open
```

O endereço da central pode ser definido em `VITE_API_URL` antes do build ou informado no login do Android. Autorize a origem `https://localhost` do Capacitor em `ROTA_ALLOWED_ORIGINS` no servidor. [Compilação e configuração Android](docs/ANDROID.md).

O APK debug é para desenvolvimento. A assinatura de produção e testes em aparelho físico permanecem pendentes.

## Organização

```text
src/admin/          Painel administrativo
src/driver/         Aplicativo do entregador
src/auth/           Login responsivo
src/connected.ts    Sessão, chamadas API e sincronização
src/domain.ts       Regras compartilhadas de entregas e usuários
src/store.ts        Armazenamento da prévia portátil
src/components/     Mapa ilustrativo
server/             API HTTP, validação, sessões e SQLite
android/            Aplicação Android nativa
scripts/            Desenvolvimento, QA e builds Android
```

## Próximas etapas

1. GPS Android: permissões, captura em segundo plano, fila offline e medição de quilômetros.
2. Mapas e navegação real dentro do app, com provedor de rotas, e acompanhamento geográfico no painel.
3. Testes de campo no Android e preparação da operação, recuperação de acesso e publicação.
4. Integração de pedidos e endereços do Alpha7, após confirmar sua API ou formato de exportação.
