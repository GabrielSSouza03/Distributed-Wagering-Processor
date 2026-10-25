# Distributed Wagering Processor

Serviço financeiro que processa apostas de provedores de jogos com correção sob duplicata, entrega fora de ordem e várias instâncias ao mesmo tempo.

Regras de negócio, concorrência, idempotência, mensageria, observabilidade e limitações de desenho estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Código

```text
src/
  main.ts                         HTTP, shutdown, filtro de erro
  modules/wallet                  agregado, abertura e consultas
  modules/wagering                regras, caso de uso e store
  modules/messaging               inbox, outbox, consumidor, scheduler
  modules/identity                porta de identidade
  infrastructure                  PostgreSQL, SQS, métricas, OpenTelemetry
  shared/domain                   Money, hash canônico, envelope de evento
```

| Módulo           | Responsabilidade                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `wallet`         | Abre a carteira, aplica débito e crédito e devolve o lançamento correspondente.                     |
| `wagering`       | Valida a operação, resolve referência, persiste o resultado e enfileira eventos na mesma transação. |
| `messaging`      | Consome `wager-transactions.fifo`, publica a outbox e reprocessa `PENDING_REFERENCE`.               |
| `identity`       | Guard global. Health fica aberto.                                                                   |
| `infrastructure` | Schema, papel `wagering_app`, cliente SQS e telemetria.                                             |

`FinancialModule` monta os casos de uso com `Clock` e `IdGenerator`. O domínio não importa NestJS nem tipos do ORM.

```mermaid
flowchart LR
  subgraph entradas
    HTTP[HTTP]
    FILA[SQS wager-transactions]
  end
  HTTP --> UC[ProcessWagerTransaction]
  FILA --> UC
  UC --> PG[(PostgreSQL)]
  PG --> OUT[Outbox publisher]
  OUT --> EVT[SQS wagering-events]
  SCH[Scheduler] --> PG
```

```mermaid
sequenceDiagram
  participant Provedor
  participant API
  participant UC as ProcessWagerTransaction
  participant PG as PostgreSQL
  participant Pub as Outbox publisher
  participant SQS as wagering-events

  Provedor->>API: POST /wagering/transactions
  API->>UC: execute
  UC->>PG: trava a carteira, grava transação, ledger e outbox
  PG-->>UC: commit
  UC-->>API: resultado
  API-->>Provedor: 200, 202 ou 422
  Pub->>PG: FOR UPDATE SKIP LOCKED
  Pub->>SQS: publica depois do commit
```

## Tecnologias

| Tecnologia    | Versão fixada                       | Função                                                            |
| ------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Bun           | 1.4.4                               | Runtime, pacotes, testes e execução de TypeScript                 |
| TypeScript    | 5.9.3, `strict`                     | Tipagem. `tsc --noEmit` é o typecheck; o Bun não faz isso sozinho |
| NestJS        | 12.2.0                              | HTTP, módulos e ciclo de vida dos workers                         |
| MikroORM      | 7.2.5                               | PostgreSQL, Unit of Work e `LockMode.PESSIMISTIC_WRITE`           |
| PostgreSQL    | 17.6                                | Consistência, ledger e idempotência                               |
| Zod           | 4.1.12                              | Contrato HTTP e da mensagem SQS                                   |
| MiniStack     | imagem fixada por digest no Compose | SQS local                                                         |
| Pino          | 10.1.0                              | Log JSON                                                          |
| OpenTelemetry | SDK 0.300.0, API 1.10.0             | Exportação opcional de traces e métricas                          |
| k6            | 1.3.0, via Compose                  | Experimento de carga opcional                                     |

## Pré-requisitos

- Bun 1.4.4
- Docker com Compose, para PostgreSQL e MiniStack
- Porta 5432 livre para o Postgres e 4566 para o MiniStack
- Porta 3000 livre para a API, se o padrão for mantido

Não é necessário cliente `psql` nem k6 instalado na máquina. O typecheck usa o TypeScript das devDependencies.

## Execução local

Caminho usado pelos testes e pelo CI: API no host, Postgres e MiniStack no Compose. O diretório de dados do Postgres está em `tmpfs`. Recriar o container apaga schema, papel e dados; a migration precisa rodar de novo.

```bash
git clone https://github.com/GabrielSSouza03/Distributed-Wagering-Processor.git
cd Distributed-Wagering-Processor
cp .env.example .env
bun install
docker compose up -d --wait postgres ministack
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wagering bun run migration:up
bun run queues:init
bun run start
```

`migration:up` aplica `Migration202610230001`. O comando lê `DATABASE_URL`, não `MIGRATION_DATABASE_URL`, e cria o papel `wagering_app`. Por isso a migration usa o superusuário `postgres`. O `bun run start` seguinte carrega o `.env` e conecta como `wagering_app`.

`queues:init` cria as três filas FIFO antes da API. Se a API subir primeiro, `ensureQueue` cria a fila sem a redrive policy.

| Comando                   | Efeito                                                |
| ------------------------- | ----------------------------------------------------- |
| `bun run start:dev`       | Mesmo processo, com reload                            |
| `bun run build`           | Bundle em `dist/` para a imagem                       |
| `bun run migration:down`  | Desfaz a migration. Não remove o papel `wagering_app` |
| `bun run migration:check` | Compara entidades e schema via MikroORM               |
| `bun run typecheck`       | `tsc --noEmit`                                        |
| `bun run lint`            | ESLint                                                |
| `bun run format`          | Prettier em escrita                                   |
| `bun run format:check`    | Prettier em verificação. Roda no CI                   |

A API escuta em `0.0.0.0` na porta `PORT` (padrão 3000). Health: `GET /health/live` e `GET /health/ready`.

### Containers da aplicação

O profile `app` sobe o job de migration e as réplicas descritas em [ARCHITECTURE.md](ARCHITECTURE.md). Essas réplicas não publicam a porta 3000 no host. O k6, no profile `load`, chama `http://app:3000` pela rede do Compose.

```bash
docker compose up -d --wait postgres ministack
bun run queues:init
docker compose --profile app up -d --build
```

O job `migrate` usa o superusuário.

### Carga e telemetria opcionais

```bash
docker compose --profile load run --rm k6 run /scripts/wagering.js
docker compose --profile observability up -d
```

O segundo comando publica o Grafana em `http://localhost:3001`. Para o processo no host exportar traces, descomente `OTEL_EXPORTER_OTLP_ENDPOINT` no `.env`. O que o script de carga mede está em [ARCHITECTURE.md](ARCHITECTURE.md).

## Variáveis de ambiente

Valores abaixo são os do ambiente local. Não são segredos de produção. O `.env` local não é versionado.

| Variável                       | Obrigatória                  | Função                                                                                      | Exemplo                                                  |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `PORT`                         | não                          | Porta HTTP. Padrão 3000                                                                     | `3000`                                                   |
| `APP_ROLES`                    | não                          | `api`, `consumer`, `outbox`, `scheduler`. Padrão `api`, e nesse padrão os workers não sobem | `api,consumer,outbox,scheduler`                          |
| `DATABASE_URL`                 | sim em runtime               | Conexão da aplicação e da migration. O exemplo inclui `lock_timeout=2s`                     | ver `.env.example`                                       |
| `MIGRATION_DATABASE_URL`       | sim para os testes de schema | Superusuário. O migrator ignora esta variável                                               | `postgresql://postgres:postgres@localhost:5432/wagering` |
| `AWS_ENDPOINT_URL`             | não                          | Endpoint SQS. Padrão `http://localhost:4566`                                                | `http://localhost:4566`                                  |
| `AWS_REGION`                   | não                          | Região do cliente. Padrão `us-east-1`                                                       | `us-east-1`                                              |
| `AWS_ACCESS_KEY_ID`            | não                          | Credencial local. Padrão `local`                                                            | `local`                                                  |
| `AWS_SECRET_ACCESS_KEY`        | não                          | Credencial local. Padrão `local`                                                            | `local`                                                  |
| `WAGER_QUEUE_URL`              | não                          | Fila de entrada. Sem ela, o consumidor resolve pelo nome                                    | URL do MiniStack                                         |
| `WAGER_DLQ_URL`                | não                          | DLQ. Sem ela, o consumidor resolve pelo nome                                                | URL do MiniStack                                         |
| `EVENTS_QUEUE_URL`             | não                          | Fila da outbox                                                                              | URL do MiniStack                                         |
| `WAGER_MAX_RECEIVES`           | não                          | Recepções antes da DLQ. Padrão 5                                                            | `5`                                                      |
| `LOG_LEVEL`                    | não                          | Nível do Pino. Padrão `info`                                                                | `info`                                                   |
| `OTEL_SERVICE_NAME`            | não                          | Nome do serviço no recurso OTEL                                                             | `distributed-wagering-processor`                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | não                          | Se ausente, o SDK não inicia                                                                | `http://localhost:4318`                                  |
| `DB_DEBUG`                     | não                          | Log SQL do MikroORM quando `true`                                                           | `true`                                                   |
| `FAIL_AFTER_COMMIT_BEFORE_ACK` | não                          | Falha injetada depois do commit e antes do ack. Só para o teste de crash                    | `true`                                                   |

## API

Sem autenticação. Os exemplos assumem `http://localhost:3000`. Status HTTP, hash do payload e códigos de falha estão em [ARCHITECTURE.md](ARCHITECTURE.md).

Erros lançados antes de um resultado de negócio usam este corpo, com `Content-Type: application/json`:

```json
{
  "type": "https://wagering.local/problems/invalid-request",
  "title": "Invalid request",
  "status": 400,
  "detail": "headers.idempotency-key: Idempotency-Key is required and must have at most 255 characters",
  "instance": "/wagering/transactions",
  "code": "INVALID_REQUEST"
}
```

### Carteiras

`POST /wallets` responde 201. `version` nasce em 1 e só aumenta quando o saldo muda; a abertura com saldo positivo já nasce na versão 1. Saldo zero não gera `OPENING` nem lançamento. O mesmo jogador e a mesma moeda de novo respondem 409 `UNIQUE_CONFLICT`.

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

`GET /wallets/:walletId` devolve `id`, `playerId`, `balance` e `version`. UUID desconhecido: 404.

`GET /wallets/:walletId/ledger?limit=50&cursor=...` pagina por `seq` crescente. `limit` vai de 1 a 100; o padrão é 50. `nextCursor` só vem quando há próxima página. O cursor é opaco: base64url de `{"seq":"<n>"}`. Cursor malformado cai no 500 genérico.

`POST /wallets/:walletId/reconciliation`:

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42
}
```

### Transações

`POST /wagering/transactions` exige `Idempotency-Key`, com no máximo 255 caracteres. A convenção recomendada é `{providerId}:{externalTransactionId}`. `amount` segue `^(0|[1-9]\d*)\.\d{2}$`. Só `LOSS` pode ser `0.00`. Objeto com campo desconhecido é recusado. `BET` ou `LOSS` com referência, e `REFUND` ou `ROLLBACK` sem ela, respondem 422 `INVALID_TRANSACTION_REFERENCE` e não gravam a transação.

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

`GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` devolvem identificadores, `kind`, `money`, `status`, `failureCode`, `balance` quando houver saldo resultante, `createdAt` e `processedAt`.

### Fila de entrada

`MessageGroupId` deve ser a carteira quando o produtor quiser ordenar por ela. A deduplicação do broker está desligada.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

### Eventos

A outbox grava o envelope de `IntegrationEvent.toJSON()`: `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` quando existe, `occurredAt`, `version` e `data`. Valores monetários em `data` são strings decimais.

| Evento                             | Quando                                          |
| ---------------------------------- | ----------------------------------------------- |
| `WagerTransactionProcessed`        | Operação aplicada, inclusive `LOSS` e `OPENING` |
| `WagerTransactionRejected`         | Rejeição de negócio persistida                  |
| `WalletBalanceChanged`             | Somente quando o saldo muda                     |
| `WagerTransactionPendingReference` | Referência ainda não encontrada                 |

## Testes

Os testes de integração e de concorrência usam o Postgres e o MiniStack do Compose, a migration aplicada e as filas criadas. Cada arquivo desses grupos termina conferindo `saldo da carteira == soma do ledger` e saldo não negativo nas carteiras que tocou. Cenários com mais de um processo sobem `src/main.ts` de verdade. `TEST_APP_LOGS=true` mostra o log desses processos.

```bash
bun test
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test:load
```

`bun test` e `test:unit` são o mesmo comando: testes em `src/`, sem Docker. Integração e concorrência rodam com concorrência 1. `test:load` precisa do profile `app` no ar.

| Cenário pedido                                                | Arquivo                                       |
| ------------------------------------------------------------- | --------------------------------------------- |
| A mesma aposta 50 vezes em paralelo                           | `test/integration/api.integration.test.ts`    |
| Duas apostas de `80.00` sobre saldo `100.00`                  | `test/integration/api.integration.test.ts`    |
| Carteiras distintas em paralelo, sem bloqueio cruzado         | `test/concurrency/wallets-parallel.test.ts`   |
| Três processos na mesma carteira                              | `test/concurrency/multi-instance.test.ts`     |
| Processo morto depois do commit e antes do ack                | `test/concurrency/crash-before-ack.test.ts`   |
| Dois publishers na mesma outbox                               | `test/concurrency/outbox-publishers.test.ts`  |
| `REFUND`, `ROLLBACK` e `WIN` antes da referência, e expiração | `test/integration/out-of-order.test.ts`       |
| `SIGKILL`, restart e estado final consistente                 | `test/concurrency/restart-recovery.test.ts`   |
| Constraints do schema                                         | `test/integration/schema.integration.test.ts` |
| Atomicidade de carteira, ledger, transação, inbox e outbox    | `test/integration/atomicity.test.ts`          |
| Redelivery, retry com backoff e DLQ                           | `test/integration/consumer-dlq.test.ts`       |

Unidade cobre `Money`, hash canônico, invariantes da carteira, transições de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, conflito de moeda e payload divergente.

O CI (`.github/workflows/ci.yml`) roda com token somente leitura (`permissions: contents: read`). Instala Bun 1.4.4 com lockfile congelado, roda `format:check`, lint, typecheck e unidade, sobe Postgres e MiniStack, aplica a migration como `postgres` e roda integração e concorrência. `test:load` fica de fora do workflow.

## Shutdown, status e logs

- `SIGTERM` aborta o long poll. Mensagem em processamento não é confirmada e volta após o visibility timeout de 30 segundos. O handler corrente não é drenado.
- `PENDING` é o estado inicial em memória. O status não terminal que a API devolve é `PENDING_REFERENCE`.
- Os logs não trazem `messageId`, `transactionId`, `walletId` e `providerId` em toda linha. `x-correlation-id` com até 128 caracteres vira o id da requisição e volta no header.
