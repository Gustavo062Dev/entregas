# API e banco compartilhado

O servidor usa Node.js 24, HTTP e SQLite. Interface e API podem ser servidas pela mesma origem em produção, enquanto o Vite encaminha `/api` durante o desenvolvimento. O Android usa o mesmo servidor por HTTPS.

## Configuração

Copie `.env.example` para `.env` e preencha os dados do primeiro administrador. O `.env` não é versionado. Nenhuma credencial de serviço externo é necessária nesta etapa.

| Variável | Uso |
| --- | --- |
| `ROTA_ADMIN_EMAIL` | E-mail do primeiro administrador, obrigatório em banco novo. |
| `ROTA_ADMIN_PASSWORD` | Senha de 12–128 caracteres, obrigatória em banco novo. |
| `ROTA_ADMIN_NAME` | Nome do primeiro administrador. |
| `DATABASE_PATH` | Arquivo SQLite; padrão `.local/data/rota.sqlite`. |
| `HOST` / `PORT` | Padrões `127.0.0.1` / `3001`. O desenvolvimento usa porta 3001 para o proxy Vite. |
| `API_DEMO_SEED` | `1` inicia um banco novo com dados fictícios e avanço de simulação; `0` inicia vazio. |
| `ROTA_DEMO_DRIVER_PASSWORD` | Opcional: senha inicial do entregador fictício `entregador1@example.com`. |
| `ROTA_ALLOWED_ORIGINS` | Origens exatas adicionais para CORS, separadas por vírgula. Android Capacitor usa `https://localhost`. |
| `VITE_API_URL` | URL HTTPS incorporada ao frontend; vazio usa a origem web atual. Pode ser informada no login Android. |

`npm run dev` carrega `.env` e inicia os dois processos. `npm run server:dev` inicia somente a API. `npm start` serve API e `dist/` em produção, depois de `npm run build`. O primeiro administrador não é reconfigurado ao mudar variáveis em um banco existente: altere a conta autenticado pelo painel.

## Sessões e acesso

O login emite um token aleatório com validade de 12 horas. Senhas usam scrypt com sal individual; tokens são armazenados no servidor como SHA-256. As respostas não contêm hashes ou senhas. O cliente guarda o token no `sessionStorage`; configuração de URL fica no `localStorage`. Logout remove a sessão local e solicita revogação ao servidor. Sem rede, a remoção local continua imediata, e a sessão remota permanece limitada ao prazo de expiração.

O servidor verifica o cadastro ativo em cada solicitação. Redefinir senha, alterar papel, vínculo ou e-mail e desativar usuário revoga as sessões correspondentes. Um entregador em rota não pode ser desativado antes da conclusão; o último administrador ativo é preservado. O administrador define a senha inicial e pode redefini-la; recuperação por e-mail ainda não foi implementada.

| Perfil | Dados e ações |
| --- | --- |
| Administrador | Painel, atribuição, relatórios e gestão de usuários. |
| Gestor | Painel, atribuição e relatórios; sem gestão de usuários. |
| Entregador | Somente seu perfil, entregas e viagens; turno e execução de suas entregas. |

A filtragem ocorre no servidor, inclusive nas respostas após alterações. Ocultar botões na interface não substitui a validação da API.

## Endpoints

Envie corpos JSON com `Content-Type: application/json`. Rotas autenticadas usam `Authorization: Bearer <token>`; tokens não vão na URL.

| Método e caminho | Contrato |
| --- | --- |
| `GET /api/health` | Público: `{ok:true}`. |
| `POST /api/auth/login` | `{email,password}` → `{token,user,expiresAt}`. |
| `GET /api/auth/me` | Sessão atual → `{user,expiresAt}`. |
| `POST /api/auth/logout` | Revoga o token e retorna 204. |
| `GET /api/state` | `{state,revision,simulation}` filtrado pelo perfil. |
| `POST /api/commands` | `{command,revision}` → `{state,revision,simulation,message}`. |
| `POST /api/users` | Administrador: `{user,password?}` → estado atualizado. |

Os comandos são `assign`, `start`, `advance`, `complete`, `availability` e `toggle-user`, com contratos em `src/domain.ts`. `save-user` é tratado somente por `/api/users`, e `reset` não é permitido no servidor. `advance` só funciona em banco demonstrativo. Uma conta nova ou fictícia sem credencial precisa de senha em `/api/users`; edição de conta com senha existente pode preservá-la.

Erros retornam `{error:string}`: 400 para dados inválidos, 401 para sessão ausente/expirada, 403 para ação sem permissão, 409 para revisão desatualizada, 413 para corpo acima de 32 KB e 422 para regra de negócio rejeitada. Login tem limite de tentativas e resposta 429. Rotas API desconhecidas retornam 404, inclusive quando a interface SPA está sendo servida.

## Persistência e sincronização

SQLite armazena o estado compartilhado, credenciais, sessões e o modo do banco. Alterações usam transação e revisão crescente; comandos enviados com revisão antiga não sobrescrevem dados recentes. O cliente recarrega após conflito e pede que o usuário revise e repita a ação. Não reenvia automaticamente uma alteração cujo resultado ficou incerto por falha de rede.

As telas consultam o servidor a cada cinco segundos quando visíveis. Erros de rede mantêm os últimos dados na tela e bloqueiam alterações até **Tentar novamente** sincronizar. Comandos de entregas exigem conexão; a fila offline é específica para pontos GPS no Android. Não há websocket nesta fase. O APK não depende do armazenamento local da demonstração web.

`API_DEMO_SEED` só define o modo na criação do banco. Reiniciar com outra configuração não mistura nem substitui dados: use arquivos separados para testes e operação. Um banco operacional novo começa com apenas o administrador; o GPS pode registrar o turno do entregador cadastrado, enquanto pedidos e rotas viárias precisam das próximas etapas. O banco demonstrativo mantém os rótulos de simulação ao reiniciar.

## Operação do servidor

Mantenha o arquivo SQLite em volume persistente e com backup. Banco e diretório são criados com permissões restritas. Para copiar um backup simples, pare o processo antes; para backups online, use a API de backup SQLite. Esta implementação foi pensada para uma única instância Node; várias instâncias e crescimento da operação pedem banco e arquitetura dedicados.

Publique por proxy HTTPS, mantendo a API e a interface na mesma origem. Para Android, autorize `https://localhost` explicitamente em CORS e informe o endereço HTTPS público. Não coloque senhas, banco ou tokens em `dist/`, no Git ou no HTML portátil.

## Validação

`npm test` executa testes HTTP reais com bancos temporários: autenticação, expiração/revogação, isolamento de dados, permissões, persistência, concorrência e entrega compartilhada. Os testes do cliente verificam respostas obsoletas, falhas de rede, conflitos, permissão GPS pendente após logout e isolamento da fila. Os testes GPS validam pontos, deduplicação, relógio, lacunas e distribuição diária. Veja [os endpoints GPS e seus limites](GPS.md). `npm run check` verifica tipos do servidor e frontend.
