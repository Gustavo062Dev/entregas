# GPS, quilômetros e acompanhamento

A aplicação conectada possui rastreamento GPS nativo no Android, fila local de posições e cálculo de distância no servidor. O painel apresenta a última posição geográfica recebida e consulta atualizações a cada cinco segundos. A prévia portátil continua usando apenas simulação.

## Usar no Android

1. Publique a API por HTTPS e crie uma conta de entregador pelo painel. Use um banco operacional com `API_DEMO_SEED=0`; GPS real não é permitido em banco demonstrativo.
2. Entre no Android, informe o endereço da central e inicie o turno.
3. Toque em **Ativar GPS**. Autorize localização precisa; o Android pode solicitar autorização para a notificação do rastreamento.
4. Com a permissão de notificação, uma notificação permanente indica que a captura está ativa. No Android 13 ou superior, negar notificações mantém o serviço visível no gerenciador de apps ativos; use o aplicativo para parar a coleta. A captura continua com a tela apagada ou com outro app aberto enquanto o serviço permanece em execução.
5. **Parar GPS**, inclusive na notificação, remove a captura imediatamente. Encerrar o turno, sair da conta, expirar o acesso ou perder a autorização também interrompe a captura.

A versão web do entregador acompanha dados, mas não ativa esse serviço Android. O rastreamento não começa automaticamente ao entrar. Não é solicitada permissão de localização permanente de fundo: o serviço de localização é iniciado por uma ação na tela visível e usa as permissões concedidas para esse serviço. A notificação apresenta o controle para interrompê-lo.

Se o Android matar o processo ou o usuário forçar a parada, a coleta não reinicia sozinha. Pontos já guardados continuam na fila privada e podem ser enviados ao abrir o app com o mesmo acesso; ativar uma nova coleta exige nova ação. A continuidade e consumo de bateria precisam ser testados nos aparelhos usados pela operação, incluindo as configurações de economia de energia de cada fabricante.

## Fila sem internet

Posições são guardadas em SQLite na área privada do app, separadas por endereço da central, usuário, vínculo de entregador e sessão GPS. Senhas e tokens não são gravados nessa fila; o serviço recebe o token apenas em memória. Backup do app está desativado para não copiar esses registros para backup de dispositivo.

O serviço tenta enviar lotes durante a captura. Depois de reconectar ou abrir o aplicativo, a sincronização também tenta esvaziar os registros pendentes daquele mesmo vínculo. O servidor confirma IDs individuais; reenviar um lote não soma quilômetros duas vezes. Não é enviado um registro usando a identidade de outro usuário ou de outro entregador.

A fila tem limite de 20 mil posições. Descartes por atingir esse limite são apresentados ao entregador. Interromper a coleta não exige conexão: o horário de parada permanece pendente até a sincronização concluir o envio. A API pode receber registros atrasados capturados antes do encerramento; registros fora da janela recebem confirmação de rejeição e não entram no cálculo. A sessão encerrada no servidor interrompe a coleta correspondente no Android.

Falha de escrita local interrompe a captura em vez de fingir que um ponto foi salvo. Sessões expiradas ou sem permissão param a coleta e mantêm registros pendentes para a identidade original. O fluxo de pedidos e confirmação de entrega ainda depende de conexão; nesta etapa, a fila offline é de GPS.

## Como a distância é calculada

O servidor utiliza distância geográfica entre amostras, sem confiar em um valor de quilômetros enviado pelo celular. Mantém metros sem arredondar acumuladamente e formata a apresentação na interface.

Filtros desta versão:

- Precisão informada pelo GPS de até 50 metros.
- Coordenadas e horários válidos; tolerância de relógio de 30 segundos no futuro e fila de até sete dias.
- Ordem crescente de captura e IDs únicos por sessão.
- Velocidade aparente de até 180 km/h entre amostras próximas.
- Movimento mínimo de oito metros ou da incerteza média dos pontos, o que for maior, para reduzir ruído quando parado.
- Intervalos acima de dois minutos reiniciam a referência e são registrados como interrupção. A distância desse intervalo não é inventada.

Pontos rejeitados não deslocam a última localização confiável nem aumentam quilômetros. Reenvios idênticos só confirmam o registro anterior; reutilizar um ID com outros dados é conflito e reverte o lote inteiro. Amostras fora da sessão são rejeitadas individualmente para não travar outras posições válidas do lote.

O GPS fornece uma **estimativa de distância**, sujeita a perdas de sinal, curvas entre amostras e ao ruído do sensor. Essa estimativa não foi calibrada com o odômetro de um veículo e não deve ser tratada como medição certificada. Os filtros precisam de validação de campo antes de usar os valores para pagamento.

## Turnos, entregas e relatórios

O GPS mede todo o período de captura durante o turno, incluindo deslocamentos sem entrega em andamento. `gpsDays` reúne esses metros por entregador e dia em **America/Sao_Paulo**; um segmento que cruza a meia-noite é dividido proporcionalmente.

Viagens vinculadas a entregas recebem somente segmentos capturados dentro do seu período, inclusive quando os pontos chegam depois da confirmação. Essa distância é um subconjunto dos quilômetros do turno. O total diário e o CSV usam os dias GPS e não somam esse subconjunto de novo. Registros antigos de simulação ficam identificados por sua origem.

O painel apresenta precisão e idade da última posição. Após dois minutos, o marcador indica localização antiga. Sem um ponto confiável, mostra **Aguardando localização**, sem colocar o entregador em uma coordenada fictícia. O mapa é geográfico; o acompanhamento se atualiza pela consulta ao servidor, não por websocket.

## Mapa e navegação

O mapa usa Leaflet e, por padrão, imagens do OpenStreetMap com atribuição visível. `VITE_MAP_TILE_URL` e `VITE_MAP_ATTRIBUTION` permitem configurar um provedor HTTPS adequado à operação. Não há download em massa, pré-carregamento ou mapa offline. A utilização do servidor público deve respeitar a [política de tiles do OpenStreetMap](https://operations.osmfoundation.org/policies/tiles/).

O mapa acompanha a posição; **rotas viárias e instruções reais de navegação dentro do app ainda não foram implementadas**. Na operação GPS, não são exibidas instruções fictícias de curva ou um percentual de chegada baseado na simulação. A confirmação exige o recebedor e é manual, sem alegar que o GPS comprovou chegada ao endereço. Geocodificação de destinos e provedor de rotas fazem parte da próxima etapa. Alpha7 continua por último.

## API

Somente o usuário entregador ativo pode escrever GPS. Administradores e gestores acompanham pelo estado autorizado da API.

| Endpoint POST | Corpo e resultado |
| --- | --- |
| `/api/tracking/start` | `{deviceId}` cria ou retoma uma sessão do mesmo aparelho durante turno ativo; retorna sessão e estado. Outro aparelho ativo recebe 409. |
| `/api/tracking/points` | `{sessionId,points:[{id,latitude,longitude,accuracy,recordedAt}]}`; até 100 pontos. Retorna `ackIds`, aceitos, rejeitados, duplicados, `active` e estado. |
| `/api/tracking/stop` | `{sessionId,stoppedAt?}` encerra sem excluir capturas aceitas. O horário é ajustado à última captura aceita quando houver pequeno adiantamento do relógio GPS. |

O Android usa o cabeçalho `X-Rota-Tracking-Response: compact` nos envios e encerramentos: recebe confirmação e metadados sem carregar todo o histórico. Consultas da interface continuam recebendo o estado autorizado. Proprietário, recibos e estado são persistidos atomicamente. O estado do entregador não expõe sessões ou coordenadas de outros usuários. A API guarda posição recente, referências, recibos e totais; não oferece exportação de toda a sequência de coordenadas nesta etapa.

## Validação realizada e pendente

Testes automatizados usam amostras sintéticas para conferir distância, filtros, duplicação, persistência, papéis, horário e relatórios. A verificação de navegador usa a API real com sessões separadas; imagens de mapa podem ser substituídas por uma imagem de teste para dispensar o provedor externo. Isso não equivale a uma viagem real com GPS.

O build Android e as permissões declaradas são verificados em compilação. Testes em aparelho físico, tela apagada, perda de sinal, perda de rede, revogação de permissão e comparação com odômetro permanecem necessários antes de uma operação real.
