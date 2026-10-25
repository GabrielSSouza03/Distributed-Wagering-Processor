# Arquitetura

O PostgreSQL é a fronteira de consistência. HTTP e SQS chamam o mesmo caso de
uso, `ProcessWagerTransaction`. A ordenação FIFO do SQS é uma otimização, não
uma garantia da qual a corretude depende. A carteira é a unidade de
concorrência.

## Papéis do processo

Uma única imagem roda papéis selecionados por `APP_ROLES` (padrão `api`):
`api` (HTTP), `consumer` (fila `wager-transactions.fifo`), `outbox` (publicação
em `wagering-events.fifo`) e `scheduler` (reprocessamento de referências
pendentes). No Compose, três réplicas rodam todos os papéis.

## Autenticação

Não há autenticação. `ProviderIdentityGuard` é registrado como guard global e
consulta `ProviderIdentityPort`, cuja implementação atual é
`NoopProviderIdentity`: ela aceita qualquer valor de `Authorization`, inclusive
nenhum, e só preenche `x-provider-subject`. Endpoints `/health` ficam fora do
guard. Um provedor OIDC externo, como o Keycloak, entraria como outra
implementação dessa porta. Não existe tabela local de usuários.

O SQS é tratado como transporte interno confiável. O `providerId` de uma
mensagem não é autenticado; ele delimita a idempotência e a busca de
referências. `playerId` e moeda são conferidos contra a carteira, e a
referência precisa ser do mesmo provedor, jogador, carteira e rodada.

## Carteiras

`POST /wallets` cria a carteira com `initialBalance`. Saldo inicial positivo
grava, na mesma transação SQL, uma transação `OPENING` (provedor `internal`),
uma entrada de crédito no ledger e os eventos na outbox. A unicidade
`(player_id, currency)` impede uma segunda carteira na mesma moeda.

## Dinheiro

`Money` é um value object imutável. O valor é um `bigint` em centavos. Entrada
e saída são strings decimais com escala 2 (`"25.00"`). O parse nunca passa por
`number` do JavaScript. Uma biblioteca decimal é dispensável: o desafio fixa a
escala em duas casas, e soma e subtração em unidades menores são exatas.

O PostgreSQL guarda valores como `numeric(19,2)`. O mapper converte entre a
string decimal e `Money`. O domínio não usa tipos do MikroORM.

## Concorrência

Toda mudança financeira trava a linha da carteira com `SELECT … FOR UPDATE`
(`LockMode.PESSIMISTIC_WRITE`). A transação referenciada é lida sem lock
próprio: uma reversão válida pertence à mesma carteira, então o lock da
carteira já serializa a decisão de elegibilidade. O reprocessamento de
referências pendentes trava primeiro a linha da transação pendente e depois a
carteira. Locks são por carteira, então carteiras diferentes andam em paralelo.
Não há mutex global nem local ao processo.

A `DATABASE_URL` define `lock_timeout=2s`. Sem isso o Postgres espera o lock
indefinidamente e o `503` de contenção nunca ocorre.

O banco é o árbitro final:

- uma carteira por `(player_id, currency)`;
- uma chave de idempotência e um `external_transaction_id` por provedor;
- uma entrada de ledger por `(transaction_id, wallet_id)`;
- uma reversão bem-sucedida por transação referenciada;
- saldo da carteira nunca negativo, e cada entrada de ledger com
  `balance_before ± amount = balance_after`.

Um lost update não consegue commitar um segundo débito dos mesmos fundos.

O caso exigido (saldo `100.00`, duas apostas concorrentes de `80.00`) resulta em
uma aposta `PROCESSED`, uma rejeição `INSUFFICIENT_FUNDS`, uma entrada de débito
e saldo final `20.00`.

## Reversão exclusiva

O desafio proíbe reverter uma referência duas vezes com o mesmo tipo de
operação. Isso ainda permitiria que uma aposta processada fosse reembolsada e
depois sofresse rollback, creditando duas vezes.

Este serviço é mais estrito. Uma transação processada pode ser consumida por no
máximo uma reversão bem-sucedida, seja `REFUND` ou `ROLLBACK`.

- `WIN` pode referenciar opcionalmente um `BET` processado do mesmo provedor,
  jogador, carteira, moeda e rodada. O valor do prêmio é livre, e um `WIN` não
  consome o slot de reversão.
- `REFUND` referencia apenas um `BET` processado.
- `ROLLBACK` referencia um `BET`, `WIN` ou `REFUND` processado. O rollback de um
  débito é crédito; o rollback de um crédito é débito.
- `BET` e `LOSS` não aceitam referência.
- A referência precisa estar `PROCESSED` e ser do mesmo provedor, jogador,
  carteira e rodada (`INVALID_REFERENCE`) e da mesma moeda
  (`CURRENCY_MISMATCH`). Em `REFUND` e `ROLLBACK` o valor precisa ser igual
  (`AMOUNT_MISMATCH`).
- Um `ROLLBACK` que deixaria o saldo negativo é `REVERSAL_INSUFFICIENT_FUNDS`,
  distinto de `INSUFFICIENT_FUNDS`. `REFUND` sempre credita e não tem esse
  caso.
- Repetir a chave de idempotência vencedora devolve o resultado original. Outro
  comando contra uma referência já revertida é `REFERENCE_ALREADY_REVERSED`.
- Linhas rejeitadas e `PENDING_REFERENCE` não consomem o slot.

`wager_one_reversal_idx` é um índice único parcial em `reference_transaction_id`
onde `kind in ('REFUND','ROLLBACK')` e `status = 'PROCESSED'`. Fazer rollback de
um reembolso é uma segunda aresta: a aposta foi consumida pelo reembolso, e esse
reembolso pode, por sua vez, ser consumido uma vez.

## Idempotência

`Idempotency-Key` é autoritativa e única por provedor. `payloadHash` é o
SHA-256 de um JSON canônico: chaves de objeto ordenadas recursivamente, ordem
de arrays preservada, campos `undefined` omitidos, UTF-8, sem metadados de
transporte. Os campos com hash são `providerId`, `externalTransactionId`,
`walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money` e
`referenceExternalTransactionId`.

Mesma chave e mesmo hash devolve o resultado gravado, incluindo o saldo
observado naquela operação (`resulting_balance`), com `idempotentReplay: true`.
Mesma chave com hash diferente é `IDEMPOTENCY_CONFLICT` e não é replay. Se duas
requisições com a mesma chave correm em paralelo, a perdedora recebe violação
de `wager_provider_idempotency_unique` e o caso de uso é reexecutado, caindo no
caminho de replay.

No consumer, o inbox deduplica por `(consumer_name, message_id)` na mesma
transação SQL da escrita financeira. Um `messageId` repetido devolve o
resultado da transação com a mesma chave de idempotência. O consumer só
confirma a mensagem no SQS depois do commit.

## Status HTTP

| Situação                                                                                                      | Status |
| ------------------------------------------------------------------------------------------------------------- | ------ |
| Carteira criada                                                                                               | 201    |
| Processada                                                                                                    | 200    |
| Aceita como `PENDING_REFERENCE`                                                                               | 202    |
| Payload inválido ou `Idempotency-Key` ausente                                                                 | 400    |
| Carteira ou transação não encontrada                                                                          | 404    |
| Conflito de idempotência ou outra violação de unicidade (`23505`)                                             | 409    |
| Rejeição de negócio persistida (`status: REJECTED`)                                                           | 422    |
| Carteira de outro jogador ou moeda (`WALLET_CONTEXT_MISMATCH`) ou regra de domínio violada antes de persistir | 422    |
| Lock timeout, falha de serialização ou deadlock (`55P03`, `40001`, `40P01`)                                   | 503    |

Um replay idempotente devolve o status HTTP correspondente ao status gravado da
transação original (200, 202 ou 422).

`503` significa que o chamador pode tentar de novo com a mesma chave de
idempotência. `422` é terminal para aquele comando.

## Códigos de falha

Gravados em `failure_code` de transações rejeitadas: `INSUFFICIENT_FUNDS`,
`REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `INVALID_REFERENCE`,
`REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`.

`IDEMPOTENCY_CONFLICT` é devolvido apenas como erro HTTP 409 e não é gravado.
`PERMANENT_INFRASTRUCTURE_FAILURE` existe no enum e no estado `FAILED`, mas
nenhum fluxo atual o produz.

## Referências pendentes

`REFUND`, `ROLLBACK` ou `WIN` cuja referência ainda não existe é gravado como
`PENDING_REFERENCE`, com `WagerTransactionPendingReference` na outbox. O
scheduler busca lotes de até 25 pendentes vencidas e as reprocessa. Cada falha
incrementa `attempts` e define `next_attempt_at` como `min(300, 2^attempts)`
segundos (expoente limitado a 8). A oitava tentativa rejeita a transação com
`REFERENCE_NOT_FOUND` e enfileira `WagerTransactionRejected` na mesma
transação. As sete esperas anteriores somam cerca de quatro minutos, o que
cobre um atraso curto sem segurar a pendência indefinidamente. Se outra
reversão consumiu a referência enquanto esta estava pendente, o reprocessamento
rejeita com `REFERENCE_ALREADY_REVERSED`.

## Falhas no consumer

Uma rejeição de negócio é persistida e a mensagem é confirmada. JSON inválido
ou violação do schema, como valor zero em um tipo que mexe no saldo, vai para
a DLQ como `INVALID_MESSAGE`. Qualquer outro erro é tratado como transitório: a
visibilidade é estendida por `min(300, 2^receiveCount)` segundos (expoente
limitado a 8). No recebimento número `WAGER_MAX_RECEIVES` (padrão 5) o próprio
consumer move a mensagem para a DLQ como `RETRIES_EXHAUSTED`, então o limite
não depende da redrive policy do broker.

Erros de aplicação que não viram rejeição persistida (`WALLET_NOT_FOUND`,
`WALLET_CONTEXT_MISMATCH`, `IDEMPOTENCY_CONFLICT`, referência em `BET` ou
`LOSS`) caem no caminho transitório e chegam à DLQ como `RETRIES_EXHAUSTED`.

## Outbox

Linhas de carteira, ledger, transação, inbox e outbox são commitadas juntas. O
publisher reivindica até 25 linhas vencidas com `FOR UPDATE SKIP LOCKED` e
grava `claimed_until = now() + 30s` como lease; essa transação termina antes do
envio. Depois envia ao SQS FIFO com `MessageGroupId = aggregate_id` e
`MessageDeduplicationId = id do evento`, e então grava `published_at`.

Um crash antes do envio deixa a linha pendente; outra instância a pega quando
o lease expira. Um crash depois do envio e antes de `published_at` pode
publicar o mesmo evento duas vezes; consumidores deduplicam pelo id do evento.
Um envio com falha incrementa `attempts`, libera o lease e adia a próxima
tentativa por `min(300, 2^attempts)` segundos (expoente limitado a 8).

## Ledger

O ledger é append-only. Triggers rejeitam update, delete e truncate, e o papel
`wagering_app` só tem `select` e `insert` na tabela. Transações em estado
terminal (`PROCESSED`, `REJECTED`, `FAILED`) também são imutáveis por trigger.
`LOSS` e transações rejeitadas não geram entrada.
`POST /wallets/:walletId/reconciliation` compara o saldo gravado com a soma do
ledger, reporta a divergência e não a corrige.

## Observabilidade

Logs são JSON estruturado (pino) com correlation id, vindo de
`x-correlation-id` ou gerado, e ecoado na resposta. `Authorization`, `Cookie`,
`money` e `initialBalance` do corpo são mascarados. Liveness (`/health/live`)
não toca dependências. Readiness (`/health/ready`) verifica PostgreSQL e SQS.

Métricas emitidas:

- `wager_transactions_total` (status, kind) e `wager_duplicates_total`: só no
  endpoint HTTP, não no consumer;
- `wager_dlq_messages_total` (reason): no consumer.

`wager_lock_conflicts_total` e `wager_processing_duration_ms` estão declaradas
mas não recebem medições.

OpenTelemetry (traces e métricas OTLP) é ligado quando
`OTEL_EXPORTER_OTLP_ENDPOINT` está definido e exporta para o serviço opcional
`otel-lgtm` do Compose (perfil `observability`). O Grafana fica na porta 3001.
Retries e lag da outbox ficam visíveis em `outbox_messages`
(`published_at is null`, `attempts`, `next_attempt_at`) e não são métricas
separadas.

## Carga

`bun run test:load` roda k6 com taxa constante de 20 requisições por segundo
durante 30 segundos, distribuídas aleatoriamente entre cinco carteiras com saldo
inicial `10000.00`. Cada requisição é um `BET` de `1.00`. O check aceita HTTP
200, 202 e 422. Os thresholds são `http_req_failed < 5%` e `p95 < 2000 ms`.
Nenhum número de throughput ou latência é registrado aqui; um resultado só tem
significado para a máquina que o executou.

## Limitações

- Sem provedor de identidade. A porta noop aceita qualquer `Authorization` e
  não autentica o provedor.
- Métricas de conflito de lock, latência, retry e lag da outbox não são
  emitidas, e o consumer não conta transações nem replays.
- A reconciliação não loga nem conta divergência.
- O script de carga não registra p50, p99 nem esperas de lock; p95 aparece
  apenas no resumo e no threshold do k6.
- Reutilizar um `externalTransactionId` com outra `Idempotency-Key` viola
  `wager_provider_external_unique`, e o caso de uso é reexecutado sem
  condição de parada, entrando em loop.
- `InboxMessage` e `OutboxMessage` modelam a seção 6.5 do enunciado, mas o
  store e o publisher gravam e reprocessam inbox e outbox direto pelos
  registros do ORM. O backoff efetivo da outbox é o do publisher,
  `min(300, 2^attempts)` segundos; `OutboxMessage.scheduleRetry` usa outra
  fórmula e só é exercitado nos testes de unidade.
- `POST /wallets/:walletId/reconciliation` responde 201, o padrão do NestJS
  para `POST`, embora não crie recurso.
