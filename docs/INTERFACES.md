# Interfaces da primeira etapa

## Administração

**Visão geral** reúne a operação em uma tela: total de entregas, entregues, entregadores disponíveis e distância demonstrativa; mapa com seleção de entregador; e lista de entregas recentes.

**Entregas** permite localizar destinatários, filtrar o status e o entregador e atribuir uma entrega ainda pendente. As rotas em andamento não podem ser reatribuídas.

**Relatórios** calcula distâncias a partir das viagens, respeitando os filtros de data e entregador. A distância de uma rota em andamento está incluída; as viagens concluídas têm horário de término. Os arquivos CSV preservam acentos e tratam campos que poderiam ser interpretados como fórmulas de planilha.

**Usuários** demonstra a gestão de administradores, gestores e entregadores. É uma interface local, sem login nesta fase. Usuários vinculados a entregadores em rota não podem ser desativados até a conclusão. A função do último administrador ativo não pode ser removida.

## Entregador

O aplicativo Android abre a operação do entregador. A versão para navegador permite revisar as mesmas telas antes de instalar o APK.

**Minha rota** apresenta o turno, a próxima entrega e a navegação demonstrativa interna. A demonstração avança em quatro etapas; os quilômetros simulados seguem o progresso do trajeto e não leituras de GPS.

**Entregas** apresenta os pedidos atribuídos, endereço e status. **Histórico** apresenta viagens e quilômetros. **Perfil** apresenta a identificação e permite trocar o entregador da demonstração.

A confirmação de entrega exige o nome de quem recebeu. O aplicativo impede iniciar outra entrega quando existe uma rota em andamento, confirmar antes da chegada simulada ou operar com um usuário local desativado.

## Roteiro para revisão

1. Abra a interface do entregador e selecione Rafael Costa.
2. Inicie uma entrega pendente.
3. Avance a simulação até chegar ao destino.
4. Confirme a entrega com um nome de recebedor.
5. Confira o status e os quilômetros no painel, aberto em outra aba do mesmo navegador.
6. Experimente filtros, relatório CSV e cadastro de um usuário.

O mesmo fluxo pode ser revisado no APK Android, mas o painel web não recebe os dados do APK nesta etapa; a conexão entre dispositivos depende da futura API.
