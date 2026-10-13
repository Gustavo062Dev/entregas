# Interfaces e validação

## Acesso conectado

O painel começa pelo login de administrador ou gestor. O aplicativo Android e `/entregador` começam pelo login de entregador. Um perfil de entregador não abre o painel, e um perfil administrativo precisa entrar com a conta de entregador para testar o app. O servidor limita os dados e ações de cada conta.

No painel, **Visão geral** reúne indicadores, mapa ilustrativo e equipe. **Entregas** permite buscar, filtrar e atribuir pedidos pendentes. **Relatórios** filtra viagens por data/entregador e exporta CSV, preservando acentos e tratando fórmulas de planilha. As posições e distâncias permanecem demonstrativas; GPS está pendente.

**Usuários** aparece apenas para o administrador: cadastro, edição, ativação e redefinição de senha. Novas contas exigem senha de 12–128 caracteres. Um novo entregador recebe um perfil próprio; não usa a identidade de outro usuário. O último administrador ativo é preservado, e um entregador em rota precisa concluir a entrega antes de ser desativado.

No aplicativo, **Minha rota** apresenta turno, pedido e navegação interna demonstrativa. **Entregas** lista somente pedidos atribuídos ao usuário. **Histórico** apresenta suas viagens. **Perfil** mostra a identidade autenticada e permite sair; não oferece troca arbitrária de entregador.

As alterações esperam confirmação do servidor. Falhas de conexão exibem aviso e bloqueiam alterações até sincronizar novamente; conflitos não são sobrescritos silenciosamente. O painel consulta atualizações a cada cinco segundos quando está visível.

## Revisar a operação com dados fictícios

1. Configure um banco novo com `API_DEMO_SEED=1`, administrador e senha do entregador fictício; veja [API.md](API.md).
2. Execute `npm run dev` e entre no painel como administrador.
3. Abra `/entregador` em outro navegador ou contexto privado e entre como `entregador1@example.com`.
4. Inicie uma rota pendente, avance quatro etapas e confirme com o nome de quem recebeu.
5. Confira a atualização do status e quilômetros no painel e exporte o relatório.
6. Cadastre um usuário com senha, teste seu perfil, saia e tente acessar novamente após desativação.

O mesmo fluxo usa a API compartilhada no Android quando o aparelho alcança o servidor HTTPS. A validação em aparelho físico ainda está pendente. Em banco operacional sem dados fictícios, não há avanço de simulação; GPS e entrada de pedidos serão desenvolvidos em etapas seguintes.

## Teste de interface conectado

`scripts/connected-smoke.py` usa Chromium/Playwright e sessões isoladas. Prepare um banco demonstrativo **novo** com as credenciais de QA escolhidas; o script não reinicializa o banco nem deve ser executado sobre dados operacionais.

```sh
python scripts/connected-smoke.py
```

O endereço e as credenciais de teste podem ser definidos por `UI_SMOKE_URL`, `QA_ADMIN_EMAIL`, `QA_ADMIN_PASSWORD`, `QA_DRIVER_EMAIL` e `QA_DRIVER_PASSWORD`. Os valores padrão são fixtures fictícias declaradas no script, sem uso em produção. `CHROMIUM_EXECUTABLE` seleciona o navegador e `UI_SMOKE_OUTPUT` altera a pasta de resultados. Senhas e tokens não são gravados nos relatórios.

O roteiro valida login, criação de usuário, isolamento de perfis, entrega compartilhada, desativação, restauração e encerramento da sessão e layout em celular. Os resultados e capturas ficam em `.local/connected-qa/`.

## Prévia portátil

`npm run build:portable` mantém uma demonstração independente com armazenamento local, seleção de entregador fictício e nenhuma autenticação. Nessa prévia, mudanças sincronizam apenas entre abas da mesma origem. Ela é adequada para revisar as telas e pode ser hospedada no GitHub Pages.

`scripts/ui-smoke.py` valida essa demonstração. Sirva o HTML único por HTTP e informe o endereço terminado em `/index.html` com `UI_SMOKE_URL`; alternativamente, inicie o Vite com `--mode portable` e use o endereço local. `UI_SMOKE_OUTPUT` permite separar os artefatos; `CHROMIUM_EXECUTABLE` seleciona Chromium.

As credenciais e os dados do sistema conectado não são compartilhados com essa prévia.
