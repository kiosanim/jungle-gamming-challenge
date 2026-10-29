# Distributed Wagering Processor

Um serviço financeiro distribuído que processa as transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por provedores de jogos, tanto por **HTTP** quanto por **SQS**. Ele continua correto quando as mensagens chegam duplicadas, fora de ordem ou são processadas ao mesmo tempo por várias instâncias.

A especificação do desafio está no [`CHALLENGE.md`](./CHALLENGE.md). As decisões técnicas, as garantias, os trade-offs e as limitações estão no [`ARCHITECTURE.md`](./ARCHITECTURE.md), e a metodologia, o ambiente e os resultados do teste de carga, no [`LOAD_TEST.md`](./LOAD_TEST.md).

## Índice

- [Stack](#stack)
- [Como rodar (passo a passo)](#como-rodar-passo-a-passo)
   - [Pré-requisitos](#pré-requisitos)
   - [1. Configurar o `.env`](#1-configurar-o-env)
   - [2a. Subir tudo com Docker Compose (uma imagem por papel)](#2a-subir-tudo-com-docker-compose-uma-imagem-por-papel)
   - [Documentação da API (Swagger)](#documentação-da-api-swagger)
   - [Métricas, logs e traces](#métricas-logs-e-traces)
   - [Seguir uma operação de ponta a ponta no Grafana](#seguir-uma-operação-de-ponta-a-ponta-no-grafana)
   - [2b. Ou rodar a aplicação no host (desenvolvimento)](#2b-ou-rodar-a-aplicação-no-host-desenvolvimento)
   - [3. Obter tokens no Keycloak](#3-obter-tokens-no-keycloak)
   - [4. Fluxo de ponta a ponta](#4-fluxo-de-ponta-a-ponta)
   - [5. Enviar operações pela fila SQS e ler os eventos publicados](#5-enviar-operações-pela-fila-sqs-e-ler-os-eventos-publicados)
   - [6. Rodar os testes](#6-rodar-os-testes)
   - [7. Parar](#7-parar)
- [Comandos](#comandos)
- [API — exemplos de requisição e resposta](#api--exemplos-de-requisição-e-resposta)
   - [`POST /wallets` — abrir wallet](#post-wallets--abrir-wallet)
   - [`GET /wallets/:walletId` — consultar wallet](#get-walletswalletid--consultar-wallet)
   - [`POST /wagering/transactions` — submeter operação](#post-wageringtransactions--submeter-operação)
   - [`GET /wagering/transactions/:transactionId` — consultar por id interno](#get-wageringtransactionstransactionid--consultar-por-id-interno)
   - [`GET /providers/:providerId/wagering/transactions/:externalTransactionId` — consultar pelo id do provedor](#get-providersprovideridwageringtransactionsexternaltransactionid--consultar-pelo-id-do-provedor)
   - [`GET /wallets/:walletId/ledger` — extrato paginado](#get-walletswalletidledger--extrato-paginado)
   - [`POST /wallets/:walletId/reconciliation` — reconciliação](#post-walletswalletidreconciliation--reconciliação)
   - [`GET /health/live` e `GET /health/ready` — health checks (públicos)](#get-healthlive-e-get-healthready--health-checks-públicos)
   - [`GET /metrics` — métricas Prometheus (público)](#get-metrics--métricas-prometheus-público)
   - [Mensagem SQS de entrada (`wager-transactions.fifo`)](#mensagem-sqs-de-entrada-wager-transactionsfifo)
   - [Eventos publicados (`wagering-events.fifo`)](#eventos-publicados-wagering-eventsfifo)
- [Estrutura](#estrutura)

## Stack

O projeto usa Bun 1.4 (como runtime, gerenciador de pacotes e test runner), TypeScript em modo estrito, NestJS 12, PostgreSQL 16, MikroORM 7, AWS SQS (emulado pelo LocalStack) e Docker Compose. Para observabilidade, Prometheus (`prom-client`), Loki com Grafana Alloy, OpenTelemetry e Jaeger, todos reunidos no Grafana.

## Como rodar (passo a passo)

### Pré-requisitos

Você vai precisar do [Bun](https://bun.sh) 1.4.x, mas só para desenvolver localmente e rodar os testes e o teste de carga. O resto roda em Docker, com Docker Compose.

Reserve **pelo menos 4 GB** para a VM do Docker. PostgreSQL, LocalStack e Keycloak juntos usam cerca de 1,2 GB em repouso, e o LocalStack cresce sob carga (há detalhes no [`LOAD_TEST.md`](./LOAD_TEST.md)).

O Compose usa a versão **community do LocalStack, fixada em `localstack/localstack:4.10`**, que roda **sem token** e já inclui o SQS. Evitamos a tag `latest` porque ela passou a exigir licença.

### 1. Configurar o `.env`

```bash
cp .env.sample .env
```

O `.env.sample` já vem com valores de desenvolvimento que funcionam com o Docker Compose, então a cópia basta para subir tudo. Ajuste o que quiser pela tabela abaixo; as senhas que vêm nele servem só para a máquina local.

| Chave | Descrição | Padrão | Exemplo |
|---|---|---|---|
| `PORT` | Porta HTTP da aplicação | `3000` | `3000` |
| `DATABASE_HOST` | Host do PostgreSQL (no Compose, as réplicas usam `postgres`) | `localhost` | `localhost` |
| `DATABASE_PORT` | Porta do PostgreSQL | `5432` | `5432` |
| `DATABASE_USER` | Usuário do PostgreSQL; o container do Compose o cria na primeira subida | — | `wagering` |
| `DATABASE_PASSWORD` | Senha do PostgreSQL | — | `<senha-local>` |
| `DATABASE_NAME` | Banco da aplicação; também criado pelo container do Compose | — | `wagering` |
| `TEST_DATABASE_NAME` | Banco exclusivo dos testes, recriado pelas migrations a cada arquivo | `${DATABASE_NAME}_test` | `wagering_test` |
| `WORKERS_ENABLED` | Liga o consumidor SQS e os workers (outbox e `PENDING_REFERENCE`); `false` deixa só a API HTTP | `true` | `true` |
| `PENDING_REFERENCE_INTERVAL_MS` | Intervalo do worker que reprocessa transações em `PENDING_REFERENCE` (ms) | `1000` | `1000` |
| `OUTBOX_PUBLISH_INTERVAL_MS` | Intervalo do publisher da outbox (ms) | `200` | `200` |
| `SQS_ENDPOINT_URL` | Endpoint do emulador (LocalStack/MiniStack); **vazio** usa a AWS real com a cadeia padrão de credenciais | `http://localhost:4566` | `http://localhost:4566` |
| `SQS_REGION` | Região do SQS | `us-east-1` | `us-east-1` |
| `SQS_ACCESS_KEY_ID` | Access key usada com o emulador | `test` | `test` |
| `SQS_SECRET_ACCESS_KEY` | Secret key usada com o emulador | `test` | `test` |
| `WAGER_TRANSACTIONS_QUEUE_NAME` | Fila FIFO de entrada das operações | `wager-transactions.fifo` | `wager-transactions.fifo` |
| `WAGER_TRANSACTIONS_DLQ_NAME` | DLQ da fila de entrada | `wager-transactions-dlq.fifo` | `wager-transactions-dlq.fifo` |
| `OUTBOX_QUEUE_NAME` | Fila FIFO de destino dos eventos de integração da outbox | `wagering-events.fifo` | `wagering-events.fifo` |
| `LOCK_TIMEOUT` | Espera máxima por lock de linha no PostgreSQL; ao estourar, a resposta é `503` | `5s` | `5s` |
| `SQS_CONSUMER_CONCURRENCY` | Consumidores SQS por instância | `1` | `1` |
| `SQS_CONSUMER_MAX_ATTEMPTS` | Entregas de uma mensagem antes de ir para a DLQ | `5` | `5` |
| `SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | Visibilidade da mensagem em processamento; é também o tempo de volta à fila depois de um crash | `30` | `30` |
| `LOG_LEVEL` | Nível mínimo de log (`fatal`, `error`, `warn`, `log`, `debug`, `verbose`) | `log` | `log` |
| `OUTBOX_PUBLISHER_CONCURRENCY` | Laços de publicação da outbox por instância; cada um usa uma conexão do pool durante a ida ao SQS | `4` | `4` |
| `AUTH_ENABLED` | Liga a validação de tokens; `false` aceita requisições sem token | `true` | `true` |
| `AUTH_ISSUER` | Emissor esperado no `iss` do token; obrigatório com a autenticação ligada | — (obrigatório com autenticação ligada) | `http://localhost:8080/realms/wagering` |
| `AUTH_AUDIENCE` | Audience esperada no `aud` do token | `wagering-api` | `wagering-api` |
| `AUTH_JWKS_URL` | Endereço das chaves públicas do IdP (no Compose, `keycloak:8080`) | `{AUTH_ISSUER}/protocol/openid-connect/certs` | `http://localhost:8080/realms/wagering/protocol/openid-connect/certs` |
| `AUTH_PROVIDER_CLAIM` | Claim do token com o provedor representado pelo cliente | `provider_id` | `provider_id` |
| `KEYCLOAK_ADMIN_USER` | Usuário do console administrativo do Keycloak no Compose | `admin` | `admin` |
| `KEYCLOAK_ADMIN_PASSWORD` | Senha do console administrativo do Keycloak no Compose | `admin` | `<senha-do-console>` |
| `GRAFANA_ADMIN_USER` | Usuário administrador do Grafana no Compose | `admin` | `admin` |
| `GRAFANA_ADMIN_PASSWORD` | Senha do administrador do Grafana no Compose | `admin` | `<senha-do-grafana>` |
| `OTEL_ENABLED` | Liga o tracing OpenTelemetry (no Compose, ligado nos três papéis) | `false` | `true` |
| `OTEL_SERVICE_NAME` | Nome do serviço nos traces; vazio usa o nome do papel (`wagering-api`, `wagering-consumer`, `wagering-workers`) | nome do papel | `wagering` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Coletor OTLP/HTTP dos traces (no Compose, `jaeger:4318`) | `http://localhost:4318` | `http://localhost:4318` |
| `OTEL_TRACES_SAMPLER_ARG` | Fração dos traces amostrados na raiz (os filhos seguem o pai) | `1` | `0.1` |
| `OUTBOX_RETENTION_HOURS` | Idade a partir da qual mensagens **já publicadas** da outbox são apagadas | `168` (7 dias) | `168` |
| `INBOX_RETENTION_HOURS` | Idade a partir da qual registros da inbox são apagados (mantenha ≥ 336, a retenção máxima do SQS) | `336` (14 dias) | `336` |
| `RETENTION_INTERVAL_MS` | Intervalo da rotina de retenção | `60000` | `60000` |

A coluna "Padrão" mostra o valor usado quando a variável fica vazia ou não existe. O `.env` está no `.gitignore` e não entra na imagem Docker.

> As variáveis do SQS têm nomes próprios (`SQS_*`) de propósito: assim o serviço não herda sem querer um `AWS_ENDPOINT_URL` ou credenciais globais configuradas na máquina.

### 2a. Subir tudo com Docker Compose (uma imagem por papel)

```bash
docker compose up -d --build
```

Este comando sobe os seguintes serviços:

| Serviço | Papel |
|---|---|
| `postgres` | banco (porta 5432) |
| `localstack-aws` | SQS (porta 4566) |
| `keycloak` | Identity Provider, realm `wagering` (porta 8080) |
| `setup` | execução única: `migration:up` (CLI do MikroORM) e criação das filas FIFO |
| `api` × 3 | rotas HTTP de negócio, com autenticação (portas 3000, 3001 e 3002) |
| `consumer` × 2 | consumidor da fila `wager-transactions.fifo` |
| `workers` × 2 | publisher da outbox, worker de `PENDING_REFERENCE` e retenção da outbox/inbox |
| `prometheus` | coleta o `/metrics` de todas as réplicas de `api`, `consumer` e `workers` (porta 9090) |
| `grafana` | métricas, logs e traces num lugar só, com o dashboard "Wagering — visão geral" (porta 3030) |
| `jaeger` | traces OpenTelemetry das réplicas: OTLP/HTTP na 4318, interface na 16686 |
| `loki` | logs centralizados das réplicas, guardados por 7 dias (porta 3100) |
| `alloy` | coletor que lê o stdout das réplicas de `api`, `consumer` e `workers` e envia para o Loki (interface na 12345) |

Cada papel tem a sua própria imagem, gerada a partir de um alvo do [`Dockerfile`](./Dockerfile) multi-stage, que tem uma base comum e um estágio por papel:

| Imagem | Alvo | Comando |
|---|---|---|
| `wagering-api:local` | `api` | `bun src/main-api.ts` |
| `wagering-consumer:local` | `consumer` | `bun src/main-consumer.ts` |
| `wagering-workers:local` | `workers` | `bun src/main-workers.ts` |
| `wagering-setup:local` | `setup` | `bun run migration:up && bun run sqs:setup` |

O consumidor e os workers também escutam HTTP na porta 3000 interna, mas só para `/health/*` e `/metrics`, que o healthcheck do Compose e o Prometheus usam. Neles, as rotas de negócio respondem 404. Cada papel escala de forma independente, por exemplo com `docker compose up -d --scale consumer=4`.

A subida segue uma ordem. Primeiro vêm PostgreSQL, LocalStack e Keycloak, cada um esperando o próprio healthcheck. Depois roda o `setup`, e só quando ele termina com sucesso sobem `api`, `consumer` e `workers`.

Para conferir se tudo subiu:

```bash
docker compose ps                        # api-1..3, consumer-1..2 e workers-1..2 "healthy"
curl -s localhost:3000/health/ready      # {"status":"ok","checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}
docker compose logs -f consumer          # logs JSON de um papel (api, consumer ou workers)
```

### Documentação da API (Swagger)

Cada réplica da API serve a documentação interativa em <http://localhost:3000/docs>, e o documento OpenAPI em JSON fica em <http://localhost:3000/docs-json>. Ela descreve todas as rotas, os cabeçalhos (como a `Idempotency-Key`), os formatos de entrada e saída e todos os status que cada rota pode devolver, com exemplos.

Para testar pelo navegador, gere um token como mostrado no [passo 3](#3-obter-tokens-no-keycloak), clique em *Authorize* e cole o token. A documentação em si não pede autenticação. O consumidor e os workers não a servem, porque não têm rotas de negócio.

### Métricas, logs e traces

O **Prometheus** fica em <http://localhost:9090>. Em *Status → Targets* aparecem as réplicas de `api`, `consumer` e `workers`. Elas são descobertas pelo DNS do Compose, então réplicas criadas com `--scale` entram na coleta sozinhas. A coleta acontece a cada 5s, e os dados ficam guardados por 7 dias.

O **Grafana** fica em <http://localhost:3030> e reúne as três fontes: métricas do Prometheus, logs do Loki e traces do Jaeger. O dashboard "Wagering — visão geral" é a página inicial e abre sem login, só para leitura; para editar, entre com `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`. Ele mostra vazão, latência (p50, p95 e p99), duplicatas, conflitos de concorrência, retentativas e DLQ, outbox, `PENDING_REFERENCE`, reconciliações, réplicas no ar, memória e CPU e, no fim, uma seção de logs com o volume por nível e por papel, os avisos e erros e as requisições recentes.

Os três estão ligados entre si. Numa linha de log com `traceId`, o detalhe da linha traz um link que abre o trace no Jaeger. No sentido contrário, cada span do Jaeger tem um botão que abre no Loki os logs daquele mesmo trace. Para explorar à vontade, use *Explore* e escolha Loki, Prometheus ou Jaeger. Algumas consultas úteis no Loki:

```logql
{app="wagering", service="api"}                     # logs de um papel
{app="wagering", level=~"warn|error"}               # só avisos e erros
{app="wagering"} | traceId="<traceId>"              # tudo de uma requisição
{app="wagering"} | json | walletId="<walletId>"     # tudo de uma wallet
```

Os logs chegam ao **Loki** (<http://localhost:3100>) pelo **Grafana Alloy** (<http://localhost:12345>), que lê o stdout das réplicas pelo socket do Docker. A aplicação não precisou mudar: ela continua escrevendo JSON no stdout. O nível vira label, e o `traceId` e o `correlationId` vão como metadado estruturado, o que permite filtrar por eles sem multiplicar os streams do Loki.

O **Jaeger** fica em <http://localhost:16686>. Escolha o serviço (`wagering-api`, `wagering-consumer` ou `wagering-workers`) e busque por tag, como `wagering.transactionId=<id>`, ou cole direto o `traceId`, que volta no header `x-trace-id` de cada requisição e também aparece nos logs. O trace vai da API até o worker: nele aparecem a requisição e, logo depois, a publicação dos eventos dela, e, se a operação ficou em `PENDING_REFERENCE`, também a resolução feita pelo worker mais tarde. Um trace de `POST /wagering/transactions` mostra cada camada da aplicação, uma dentro da outra: a requisição HTTP, o use case, a transação SQL, a decisão das regras de negócio e a gravação dos efeitos, com cada instrução SQL no lugar em que foi executada. O span de publicação no worker aparece ligado a ele. Todo span traz a sua camada no atributo `wagering.layer`, então dá para buscar, por exemplo, `wagering.layer=domain`. O Jaeger também está configurado como datasource no Grafana, em *Explore → Jaeger*.

Os datasources e o dashboard são provisionados a partir de [`observability/`](./observability) e ficam versionados no repositório. Por isso, mudanças feitas pela interface não são salvas: para alterar o dashboard, edite o JSON em `observability/grafana/dashboards/`.

### Seguir uma operação de ponta a ponta no Grafana

Antes de começar, entre no Grafana com `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` (o padrão é `admin` / `admin`). O acesso anônimo é só de leitura, e o Grafana não mostra o *Explore* para esse papel. Lembre também que só aparece o tráfego que passa pelas réplicas do Compose (portas 3000 a 3002 ou a fila SQS do Compose): o `bun test` e o teste de carga sobem instâncias próprias, com o tracing desligado. O Jaeger guarda os traces em memória, então eles somem quando o container dele reinicia.

**1. Gere uma operação.** Use o Swagger (<http://localhost:3000/docs>) ou o `curl` do [passo 4](#4-fluxo-de-ponta-a-ponta) com `-i`, para ver os cabeçalhos. Na resposta do `POST /wagering/transactions`, anote o header `x-trace-id` (o `traceId`) e o `transactionId` do corpo. Espere um ou dois segundos para o worker publicar os eventos.

**2. Abra o trace.** No menu da esquerda, vá em *Explore*, escolha o datasource **Jaeger**, mude o *Query type* para **TraceID**, cole o `traceId` e clique em *Run query*. A linha do tempo mostra a operação inteira: no `wagering-api`, a requisição, o use case, a transação SQL, a decisão das regras (`WagerSettlement.decide`) e a gravação dos efeitos; no `wagering-workers`, a publicação de cada evento (`publish WalletBalanceChanged`, por exemplo). Clique num span para ver os atributos, como `wagering.layer`, `wagering.status` e `wagering.failureCode`. Se a operação foi um `REFUND` que ficou pendente, o mesmo trace mostra, mais adiante, o worker resolvendo a transação.

**3. Vá para os logs.** Com um span aberto, clique em *Logs for this span*. A tela se divide e o Loki mostra as linhas da API e do worker que têm esse `traceId`.

Também dá para começar por outro ponto:

- **Pelo `transactionId`:** no *Explore*, escolha **Jaeger** com o *Query type* **Search**, selecione o serviço `wagering-api` ou `wagering-workers` e preencha *Tags* com `wagering.transactionId=<id>`.
- **Por uma linha de log:** no *Explore* com **Loki** (por exemplo, `{app="wagering"} | json | transactionId="<id>"`) ou na seção *Logs (Loki)* do dashboard, expanda uma linha e, no campo **TraceID**, clique em *Abrir trace no Jaeger*.
- **Pelas métricas:** no *Explore* com **Prometheus**, uma consulta como `sum by (status) (rate(wagering_transactions_total[1m]))` mostra o efeito no mesmo período.

### 2b. Ou rodar a aplicação no host (desenvolvimento)

```bash
bun install
docker compose up -d postgres localstack-aws keycloak
bun run migration:up        # aplica as migrations (CLI do MikroORM)
bun run sqs:setup           # cria as filas FIFO (idempotente)
bun run start:dev           # http://localhost:3000, com watch
```

O `start` e o `start:dev` sobem os três papéis num processo só (`src/main.ts`). Se quiser rodar um papel isolado, como acontece nas imagens, use `bun run start:api`, `start:consumer` ou `start:workers`, com uma `PORT` diferente para cada processo.

Para desenvolver sem tokens, rode `AUTH_ENABLED=false bun run start:dev`. Assim o Keycloak deixa de ser necessário.

### 3. Obter tokens no Keycloak

O Compose sobe o Keycloak em `localhost:8080`, já com o realm `wagering` importado de [`keycloak/realm-wagering.json`](./keycloak/realm-wagering.json). Os clientes se autenticam com OAuth2 *client credentials*:

| Cliente | Secret (só desenvolvimento) | Papel | Claim `provider_id` | Acesso |
|---|-----------------------------|---|---|---|
| `provider-a` | `provider-a-dev-secret`     | `provider` | `provider-a` | rotas de wagering do `provider-a` |
| `provider-b` | `provider-b-dev-secret`     | `provider` | `provider-b` | rotas de wagering do `provider-b` |
| `backoffice` | `backoffice-dev-secret`     | `operator` | — | wallets, extrato e reconciliação |

O console administrativo fica em `http://localhost:8080`, com o login de `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` (o padrão é `admin` / `admin`).

```bash
token() {
  curl -s http://localhost:8080/realms/wagering/protocol/openid-connect/token \
    -d grant_type=client_credentials -d client_id=$1 -d client_secret=$1-dev-secret \
    | sed 's/.*"access_token":"\([^"]*\)".*/\1/'
}
OPERATOR=$(token backoffice)    # papel operator: wallets, extrato e reconciliação
PROVIDER_A=$(token provider-a)  # papel provider, provider_id = provider-a
PROVIDER_B=$(token provider-b)  # papel provider, provider_id = provider-b
AZUL=$'\033[34m'; VERDE=$'\033[32m'; RESET=$'\033[0m'   # cores ANSI (bash e zsh)
echo "${AZUL}OPERATOR TOKEN:${RESET} ${VERDE}${OPERATOR}${RESET}"
echo "${AZUL}PROVIDER_A TOKEN:${RESET} ${VERDE}${PROVIDER_A}${RESET}"
echo "${AZUL}PROVIDER_B TOKEN:${RESET} ${VERDE}${PROVIDER_B}${RESET}"
```

Cada token vale 5 minutos. A resposta do endpoint de token tem este formato (o token foi encurtado):

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5…",
  "expires_in": 300,
  "refresh_expires_in": 0,
  "token_type": "Bearer",
  "not-before-policy": 0,
  "scope": ""
}
```

#### Para que serve cada token

Os três tokens vêm de clientes diferentes do Keycloak e representam quem chama a API. O que muda entre eles é o papel e, nos provedores, a claim `provider_id`, e é com essas duas informações que a API decide o que cada um pode fazer.

O `OPERATOR` é o backoffice, a equipe interna do operador. Ele abre wallets, consulta saldo e extrato e faz a reconciliação, mas não submete apostas: quem administra as wallets não movimenta dinheiro em nome de um jogo.

O `PROVIDER_A` e o `PROVIDER_B` são provedores de jogos. Eles enviam as operações (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) e consultam as próprias transações, mas não mexem nas rotas de wallet. Os dois têm o mesmo papel; o que os diferencia é o `provider_id`. O `PROVIDER_B` está aqui justamente para mostrar o isolamento entre provedores: um nunca enxerga nem altera o que é do outro.

| O que se tenta fazer | `OPERATOR` | `PROVIDER_A` | `PROVIDER_B` |
|---|---|---|---|
| Abrir, consultar, ver o extrato e reconciliar wallets | permitido | `403 FORBIDDEN` | `403 FORBIDDEN` |
| Enviar uma operação com `"providerId": "provider-a"` | `403 FORBIDDEN` | permitido | `403 PROVIDER_MISMATCH` |
| Consultar `/providers/provider-a/wagering/transactions/...` | `403 FORBIDDEN` | permitido | `403 PROVIDER_MISMATCH` |
| Consultar pelo id interno uma transação do `provider-a` | `403 FORBIDDEN` | permitido | `404`, sem revelar que a transação existe |

A idempotência e o `externalTransactionId` também são separados por provedor. Por isso, o `provider-a` e o `provider-b` podem usar o mesmo id externo (`transaction-123`, por exemplo) sem que uma operação interfira na outra.

No fluxo do passo 4, o `OPERATOR` abre a wallet, o `PROVIDER_A` aposta e o `OPERATOR` volta para ver o extrato e reconciliar. Para ver o isolamento funcionando, repita uma das chamadas do provedor usando o `PROVIDER_B`.

### 4. Fluxo de ponta a ponta

```bash
# 1. backoffice abre a wallet
curl -s -X POST localhost:3000/wallets -H "Authorization: Bearer $OPERATOR" \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1001","initialBalance":{"amount":"100.00","currency":"BRL"}}'
WALLET_ID=<id devolvido>

# 2. provider-a aposta (qualquer réplica: 3000, 3001 ou 3002)
curl -s -X POST localhost:3001/wagering/transactions -H "Authorization: Bearer $PROVIDER_A" \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"player-1001\",
       \"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",
       \"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# 3. extrato e reconciliação
curl -s "localhost:3002/wallets/$WALLET_ID/ledger?limit=50" -H "Authorization: Bearer $OPERATOR"
curl -s -X POST "localhost:3002/wallets/$WALLET_ID/reconciliation" -H "Authorization: Bearer $OPERATOR"
```

### 5. Enviar operações pela fila SQS e ler os eventos publicados

Dentro do container do LocalStack, o `awslocal` já vem apontando para o emulador. Ele avisa que foi descontinuado em favor do `lstk aws`, mas continua funcionando normalmente.

```bash
QUEUE=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000

# enviar uma operação (MessageGroupId = walletId: ordem por wallet)
docker exec localstack-aws-main awslocal sqs send-message \
  --queue-url $QUEUE/wager-transactions.fifo \
  --message-group-id "$WALLET_ID" --message-deduplication-id msg-docs-1 \
  --message-body "{\"messageId\":\"msg-docs-1\",\"type\":\"WagerTransactionRequested\",
    \"occurredAt\":\"2026-10-27T22:50:00.000Z\",\"data\":{\"providerId\":\"provider-a\",
    \"externalTransactionId\":\"transaction-200\",\"idempotencyKey\":\"provider-a:transaction-200\",
    \"playerId\":\"player-1001\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-988\",
    \"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

# a transação aparece processada pelo consumidor
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-200 \
  -H "Authorization: Bearer $PROVIDER_A"

# ler eventos de integração publicados pela outbox
docker exec localstack-aws-main awslocal sqs receive-message \
  --queue-url $QUEUE/wagering-events.fifo --max-number-of-messages 10 --message-attribute-names All
```

### 6. Rodar os testes

```bash
docker compose up -d postgres localstack-aws keycloak   # dependências reais
bun test                       # tudo: unidade, integração e concorrência
bun run test:unit              # domínio e unidades (src/)
bun run test:integration       # PostgreSQL, SQS e Keycloak reais
bun run test:concurrency       # 3 processos reais da aplicação, com SIGKILL e reinício
bun run test:load              # teste de carga (relatório em load-test/reports/)
LOAD_AUTH=true bun run test:load   # carga com autenticação via Keycloak
```

Os testes usam um banco só deles (`TEST_DATABASE_NAME`), recriado pelas migrations a cada arquivo, e filas exclusivas que são apagadas no final. O teste contra o Keycloak de verdade é pulado se o Keycloak não estiver no ar.

### 7. Parar

```bash
docker compose stop api consumer workers   # SIGTERM: consumidores e workers terminam o trabalho em andamento
docker compose down          # remove os containers e mantém o volume do PostgreSQL
docker compose down -v       # também apaga os dados do PostgreSQL
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `start:dev` | sobe a aplicação com os três papéis num processo (com watch em `start:dev`) |
| `bun run start:api` / `start:consumer` / `start:workers` | sobe um papel só (o mesmo comando das imagens Docker) |
| `bun test` | todos os testes (unidade, integração e concorrência) |
| `bun run test:unit` | testes de unidade (`src/`) |
| `bun run test:integration` | integração com PostgreSQL e SQS reais (`test/integration`) |
| `bun run test:concurrency` | processos reais da aplicação: 3 instâncias com SIGKILL e reinício, e os papéis api/consumer/workers separados (`test/concurrency`) |
| `bun run test:load` | teste de carga com 3 instâncias; relatório em `load-test/reports/` (ver [`LOAD_TEST.md`](./LOAD_TEST.md)) |
| `bun run lint` | oxlint |
| `bun run migration:create` | gera migration a partir do diff entities × banco |
| `bun run migration:up` / `migration:down` | aplica / reverte |
| `bun run migration:list` / `migration:pending` | executadas / pendentes |
| `bun run migration:check` | falha se as entities divergirem do schema |
| `bun run sqs:setup` | cria as filas (`wager-transactions.fifo`, DLQ e `wagering-events.fifo`) |

Os testes de integração e de concorrência precisam do PostgreSQL e do LocalStack rodando (`docker compose up -d postgres localstack-aws`). Eles usam um banco próprio, `${DATABASE_NAME}_test` (ou o que estiver em `TEST_DATABASE_NAME`), recriado pelas migrations a cada arquivo, e filas exclusivas a cada execução.

## API — exemplos de requisição e resposta

A mesma referência está disponível de forma interativa no Swagger, em `/docs` (veja [Documentação da API](#documentação-da-api-swagger)). Com exceção de health e métricas, todas as rotas exigem `Authorization: Bearer <access token>` emitido pelo Keycloak (veja [Obter tokens no Keycloak](#3-obter-tokens-no-keycloak)). Os exemplos abaixo foram capturados da aplicação rodando no Docker Compose, com a autenticação ligada, e os ids são UUIDv7 reais.

Toda resposta traz o header `X-Correlation-Id`, com o valor recebido ou um gerado na hora. Os erros sempre seguem o formato `{ "error": { "code", "message" } }`, e o mapeamento completo de status está em [Mapeamento de status HTTP](./ARCHITECTURE.md#mapeamento-de-status-http).

| Método e rota | Papel | Descrição |
|---|---|---|
| `POST /wallets` | `operator` | abre wallet (saldo inicial > 0 gera `OPENING` + `CREDIT`) |
| `GET /wallets/:walletId` | `operator` | estado atual |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | `operator` | extrato, do mais recente para o mais antigo, com cursor opaco |
| `POST /wallets/:walletId/reconciliation` | `operator` | saldo armazenado × ledger (divergência sinalizada, nunca corrigida) |
| `POST /wagering/transactions` | `provider` | submete operação (header `Idempotency-Key` obrigatório; `providerId` = o do token) |
| `GET /wagering/transactions/:transactionId` | `provider` | consulta por id interno (só transações do próprio provedor) |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `provider` | consulta por id do provedor (só o próprio `providerId`) |
| `GET /health/live` · `GET /health/ready` | público | liveness · readiness (PostgreSQL + SQS) |
| `GET /metrics` | público | métricas Prometheus |

### `POST /wallets` — abrir wallet

```http
POST /wallets
Authorization: Bearer <token do backoffice>
Content-Type: application/json
X-Correlation-Id: corr-docs-1

{ "playerId": "player-1001", "initialBalance": { "amount": "100.00", "currency": "BRL" } }
```

`201 Created`. O saldo inicial gera, na mesma transação SQL, a transação interna `OPENING` e o lançamento `CREDIT`, com o aporte como contrapartida:

```json
{
  "id": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "playerId": "player-1001",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

`409 Conflict`, quando já existe wallet para esse `playerId + currency`:

```json
{ "error": { "code": "WALLET_ALREADY_EXISTS", "message": "Já existe wallet BRL para o player player-1001" } }
```

`400 Bad Request`, quando o valor tem mais de 2 casas (`"10.001"`):

```json
{ "error": { "code": "INVALID_PAYLOAD", "message": "initialBalance: amount inválido: \"10.001\" (esperado decimal não negativo com até 2 casas)" } }
```

### `GET /wallets/:walletId` — consultar wallet

```http
GET /wallets/01a17f88-6cc0-70aa-8d32-320fcca6ce14
Authorization: Bearer <token do backoffice>
```

`200 OK`:

```json
{
  "id": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "playerId": "player-1001",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

`404 Not Found`:

```json
{ "error": { "code": "WALLET_NOT_FOUND", "message": "Wallet 01a17f00-0000-7000-8000-000000000000 não encontrada" } }
```

### `POST /wagering/transactions` — submeter operação

```http
POST /wagering/transactions
Authorization: Bearer <token do provider-a>
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json

{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "player-1001",
  "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

`201 Created`, processada agora:

```json
{
  "transactionId": "01a17f88-a573-74d1-aa2f-03b6ae3afaa7",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

`200 OK`, no replay da mesma requisição (mesma chave e mesmo payload). A resposta é o resultado original, com o saldo daquele momento:

```json
{
  "transactionId": "01a17f88-a573-74d1-aa2f-03b6ae3afaa7",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": true
}
```

`409 Conflict`, quando a mesma `Idempotency-Key` chega com outro payload (`amount` 30.00):

```json
{ "error": { "code": "IDEMPOTENCY_CONFLICT", "message": "Idempotency-Key provider-a:transaction-123 já usada com outro payload" } }
```

`422 Unprocessable Entity`, na rejeição por regra de negócio (uma `BET` de 500.00 com saldo de 75.00). A transação fica registrada como `REJECTED`, sem lançamento:

```json
{
  "transactionId": "01a17f88-a5a8-706d-832e-715161ccbb8d",
  "status": "REJECTED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "failureCode": "INSUFFICIENT_FUNDS",
  "idempotentReplay": false
}
```

Os outros kinds seguem o mesmo contrato:

| Requisição (campos que mudam) | Status | Resposta |
|---|---|---|
| `"kind": "WIN"`, `"money": 40.00`, `"referenceExternalTransactionId": "transaction-123"` | `201` | `{"status":"PROCESSED","balance":{"amount":"115.00",…}}` |
| `"kind": "LOSS"`, `"money": 0.00` | `201` | `{"status":"PROCESSED","balance":{"amount":"115.00",…}}`, sem mexer no saldo |
| `"kind": "REFUND"`, `"money": 25.00`, `"referenceExternalTransactionId": "transaction-123"` | `201` | `{"status":"PROCESSED","balance":{"amount":"140.00",…}}` |
| `"kind": "REFUND"`, referência `transaction-999`, que ainda não existe | `202` | `{"transactionId":"…","status":"PENDING_REFERENCE","idempotentReplay":false}` |

`202 Accepted` significa que a operação foi aceita, mas o processamento ficou pendente: a referência ainda não chegou, e o worker resolve a transação quando ela chegar.

```json
{
  "transactionId": "01a17f88-a5ed-75fc-8ca6-1f88e06f9871",
  "status": "PENDING_REFERENCE",
  "idempotentReplay": false
}
```

Erros de contrato e de autenticação ficam assim:

| Situação | Status | Corpo |
|---|---|---|
| `"amount": "1e3"` (notação científica) | `400` | `{"error":{"code":"INVALID_PAYLOAD","message":"money: amount inválido: \"1e3\" (esperado decimal não negativo com até 2 casas)"}}` |
| sem o header `Idempotency-Key` | `400` | `{"error":{"code":"INVALID_PAYLOAD","message":"Idempotency-Key é obrigatória (até 256 caracteres)"}}` |
| sem `Authorization` | `401` + `WWW-Authenticate: Bearer realm="wagering"` | `{"error":{"code":"UNAUTHENTICATED","message":"Authorization: Bearer <token> ausente"}}` |
| token inválido, expirado ou adulterado | `401` | `{"error":{"code":"INVALID_TOKEN","message":"token inválido: …"}}` |
| token do `provider-b` com `"providerId": "provider-a"` | `403` | `{"error":{"code":"PROVIDER_MISMATCH","message":"o token não autoriza operar pelo provider provider-a"}}` |
| token do `backoffice` (sem papel `provider`) | `403` | `{"error":{"code":"FORBIDDEN","message":"papel exigido: provider"}}` |
| wallet inexistente | `404` | `{"error":{"code":"WALLET_NOT_FOUND","message":"Wallet … não encontrada"}}` |
| banco ou lock indisponível (transitório) | `503` + `Retry-After: 1` | `{"error":{"code":"SERVICE_UNAVAILABLE","message":"Falha transitória de infraestrutura"}}` |

### `GET /wagering/transactions/:transactionId` — consultar por id interno

```http
GET /wagering/transactions/01a17f88-a573-74d1-aa2f-03b6ae3afaa7
Authorization: Bearer <token do provider-a>
```

`200 OK`:

```json
{
  "transactionId": "01a17f88-a573-74d1-aa2f-03b6ae3afaa7",
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "playerId": "player-1001",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "createdAt": "2026-10-27T22:43:44.115Z",
  "processedAt": "2026-10-27T22:43:44.115Z"
}
```

`404 Not Found`, quando a transação é de **outro** provedor (aqui, com o token do `provider-b`). A resposta não revela que a transação existe:

```json
{ "error": { "code": "TRANSACTION_NOT_FOUND", "message": "Transação 01a17f88-a573-74d1-aa2f-03b6ae3afaa7 não encontrada" } }
```

### `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — consultar pelo id do provedor

```http
GET /providers/provider-a/wagering/transactions/transaction-128
Authorization: Bearer <token do provider-a>
```

`200 OK`. Neste exemplo, a transação ainda está esperando a referência:

```json
{
  "transactionId": "01a17f88-a5ed-75fc-8ca6-1f88e06f9871",
  "providerId": "provider-a",
  "externalTransactionId": "transaction-128",
  "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "playerId": "player-1001",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "15.00", "currency": "BRL" },
  "status": "PENDING_REFERENCE",
  "referenceExternalTransactionId": "transaction-999",
  "createdAt": "2026-10-27T22:43:44.237Z"
}
```

`403 Forbidden`, quando o `providerId` da rota não é o do token:

```json
{ "error": { "code": "PROVIDER_MISMATCH", "message": "o token não autoriza operar pelo provider provider-a" } }
```

### `GET /wallets/:walletId/ledger` — extrato paginado

```http
GET /wallets/01a17f88-6cc0-70aa-8d32-320fcca6ce14/ledger?limit=2
Authorization: Bearer <token do backoffice>
```

`200 OK`, com os lançamentos do mais recente para o mais antigo. Cada um traz a contrapartida da partida dobrada em `counterAccount`, que recebe a direção oposta à da wallet. O `nextCursor` é opaco:

```json
{
  "items": [
    {
      "id": "01a17f88-a5dd-7538-b0d5-88bbf39cdbe1",
      "transactionId": "01a17f88-a5dc-7399-b750-0b0ae55d4b73",
      "direction": "CREDIT",
      "money": { "amount": "25.00", "currency": "BRL" },
      "counterAccount": "provider:provider-a:BRL",
      "balanceBefore": { "amount": "115.00", "currency": "BRL" },
      "balanceAfter": { "amount": "140.00", "currency": "BRL" },
      "walletVersion": 4,
      "createdAt": "2026-10-27T22:43:44.220Z"
    },
    {
      "id": "01a17f88-a5ba-7362-98d1-01c78e9e4bd3",
      "transactionId": "01a17f88-a5ba-7361-a83f-ce3b1dc18b02",
      "direction": "CREDIT",
      "money": { "amount": "40.00", "currency": "BRL" },
      "counterAccount": "provider:provider-a:BRL",
      "balanceBefore": { "amount": "75.00", "currency": "BRL" },
      "balanceAfter": { "amount": "115.00", "currency": "BRL" },
      "walletVersion": 3,
      "createdAt": "2026-10-27T22:43:44.186Z"
    }
  ],
  "nextCursor": "eyJ2IjozfQ"
}
```

A próxima página é `GET /wallets/01a17f88-…/ledger?limit=2&cursor=eyJ2IjozfQ`. A última página vem com `"nextCursor": null`:

```json
{
  "items": [
    {
      "id": "01a17f88-a573-74d2-a3d0-9ae0c77a6474",
      "transactionId": "01a17f88-a573-74d1-aa2f-03b6ae3afaa7",
      "direction": "DEBIT",
      "money": { "amount": "25.00", "currency": "BRL" },
      "counterAccount": "provider:provider-a:BRL",
      "balanceBefore": { "amount": "100.00", "currency": "BRL" },
      "balanceAfter": { "amount": "75.00", "currency": "BRL" },
      "walletVersion": 2,
      "createdAt": "2026-10-27T22:43:44.115Z"
    },
    {
      "id": "01a17f88-6cc0-70ac-9849-4c3b1ca3f1e9",
      "transactionId": "01a17f88-6cc0-70ab-9420-1779a6d8573d",
      "direction": "CREDIT",
      "money": { "amount": "100.00", "currency": "BRL" },
      "counterAccount": "funding:BRL",
      "balanceBefore": { "amount": "0.00", "currency": "BRL" },
      "balanceAfter": { "amount": "100.00", "currency": "BRL" },
      "walletVersion": 1,
      "createdAt": "2026-10-27T22:43:29.600Z"
    }
  ],
  "nextCursor": null
}
```

`400 Bad Request`, com um cursor inválido (`?cursor=abc`) ou um `limit` fora do intervalo de 1 a 200:

```json
{ "error": { "code": "INVALID_PAYLOAD", "message": "cursor inválido" } }
```

### `POST /wallets/:walletId/reconciliation` — reconciliação

```http
POST /wallets/01a17f88-6cc0-70aa-8d32-320fcca6ce14/reconciliation
Authorization: Bearer <token do backoffice>
```

`200 OK`, quando está tudo consistente:

```json
{
  "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "storedBalance": { "amount": "140.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "140.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 4
}
```

Se houver divergência, a resposta continua sendo `200`, mas com `"consistent": false` e uma `difference` diferente de zero. A divergência é registrada em log e na métrica `wagering_reconciliations_total{result="divergent"}`, e **nunca** é corrigida automaticamente.

### `GET /health/live` e `GET /health/ready` — health checks (públicos)

`GET /health/live` responde `200 OK`:

```json
{ "status": "ok" }
```

`GET /health/ready` responde `200 OK` quando o PostgreSQL e o SQS estão acessíveis:

```json
{ "status": "ok", "checks": { "postgres": { "status": "up" }, "sqs": { "status": "up" } } }
```

E responde `503 Service Unavailable` quando alguma dependência não responde, como neste exemplo com o SQS fora do ar:

```json
{ "status": "unavailable", "checks": { "postgres": { "status": "up" }, "sqs": { "status": "down", "error": "Error" } } }
```

### `GET /metrics` — métricas Prometheus (público)

Um trecho real da saída:

```text
# HELP wagering_transactions_total Transações decididas, por canal, kind e status (replays não contam).
# TYPE wagering_transactions_total counter
wagering_transactions_total{channel="http",kind="BET",status="PROCESSED"} 1
wagering_transactions_total{channel="http",kind="BET",status="REJECTED"} 1
wagering_transactions_total{channel="http",kind="WIN",status="PROCESSED"} 1
wagering_transactions_total{channel="http",kind="LOSS",status="PROCESSED"} 1
wagering_transactions_total{channel="http",kind="REFUND",status="PROCESSED"} 1
wagering_transactions_total{channel="http",kind="REFUND",status="PENDING_REFERENCE"} 1
wagering_duplicates_total{type="idempotent_replay"} 1
wagering_processing_duration_seconds_sum{channel="http"} 0.019842269999790007
wagering_processing_duration_seconds_count{channel="http"} 7
wagering_outbox_lag_seconds 0
```

A lista completa de métricas está na seção [Observabilidade](./ARCHITECTURE.md#observabilidade) do ARCHITECTURE.md.

### Mensagem SQS de entrada (`wager-transactions.fifo`)

A mensagem tem o mesmo contrato de negócio do `POST /wagering/transactions`. A diferença é que a `idempotencyKey` vai dentro de `data`, e o `messageId` serve de chave de deduplicação na inbox:

```json
{
  "messageId": "msg-docs-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-27T22:50:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-200",
    "idempotencyKey": "provider-a:transaction-200",
    "playerId": "player-1001",
    "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
    "roundId": "round-988",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}
```

Uma mensagem malformada vai para a `wager-transactions-dlq.fifo` com o corpo original e os atributos `failureReason`, `sourceMessageId` e `receiveCount`.

### Eventos publicados (`wagering-events.fifo`)

O corpo de cada mensagem é o envelope do evento. A mensagem também leva os atributos `eventType`, `eventId` e, quando a origem tinha um trace, `traceparent`. O `MessageGroupId` é o `walletId`. Estes são exemplos reais do fluxo acima:

`WalletBalanceChanged`, emitido pelo débito da `BET`:

```json
{
  "eventId": "01a17f88-a575-7252-a07c-502c91b3c81b",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "correlationId": "01a17f88-a570-737b-b64a-a6a12d53c008",
  "occurredAt": "2026-10-27T22:43:44.115Z",
  "version": 1,
  "data": {
    "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
    "transactionId": "01a17f88-a573-74d1-aa2f-03b6ae3afaa7",
    "direction": "DEBIT",
    "money": { "amount": "25.00", "currency": "BRL" },
    "balanceBefore": { "amount": "100.00", "currency": "BRL" },
    "balanceAfter": { "amount": "75.00", "currency": "BRL" },
    "walletVersion": 2
  }
}
```

`WagerTransactionRejected`, emitido pela `BET` sem saldo:

```json
{
  "eventId": "01a17f88-a5a9-7756-8fa3-f09683c51acc",
  "eventType": "WagerTransactionRejected",
  "aggregateId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
  "correlationId": "01a17f88-a5a5-749f-a619-8e934e86be36",
  "occurredAt": "2026-10-27T22:43:44.168Z",
  "version": 1,
  "data": {
    "transactionId": "01a17f88-a5a8-706d-832e-715161ccbb8d",
    "providerId": "provider-a",
    "externalTransactionId": "transaction-124",
    "walletId": "01a17f88-6cc0-70aa-8d32-320fcca6ce14",
    "playerId": "player-1001",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "500.00", "currency": "BRL" },
    "failureCode": "INSUFFICIENT_FUNDS"
  }
}
```

O `correlationId` do evento é o mesmo `X-Correlation-Id` da requisição que o originou. Quem consome esses eventos deve deduplicar pelo `eventId`, porque a entrega é at-least-once.

## Estrutura

```
src/
  main.ts            os três papéis num processo (desenvolvimento e testes)
  main-api.ts        papel API (imagem wagering-api)
  main-consumer.ts   papel consumidor SQS (imagem wagering-consumer)
  main-workers.ts    papel workers (imagem wagering-workers)
  modules/           módulos Nest: core (compartilhado), ops (health/métricas), api, consumer, workers
  domain/            objetos de domínio puros (Money, Wallet, WagerTransaction, ledger com contrapartidas, inbox, outbox, eventos) + testes
  application/       use cases e portas (UnitOfWork, Clock, IdGenerator, EventPublisher, Metrics, Tracer)
  infrastructure/
    persistence/     entities (decorators MikroORM), mappers, repositórios com SQL explícito, UnitOfWork
    messaging/       cliente SQS, publisher da outbox, consumidor da fila, criação das filas
    workers/         publisher da outbox, resolução de PENDING_REFERENCE e retenção
    observability/   logger JSON, contexto de requisição, métricas Prometheus, tracing OpenTelemetry
    health/          readiness
  http/              controllers, DTOs, filtro de erros, guard de autenticação (JWT/JWKS), documentação OpenAPI
  migrations/        migrations versionadas e reversíveis
keycloak/            realm importado pelo Keycloak (clientes, papéis, claims)
observability/       configuração do Prometheus, do Loki e do Alloy, e provisionamento do Grafana (datasources e dashboard)
test/
  integration/       PostgreSQL e SQS reais
  concurrency/       processos reais da aplicação (3 instâncias; papéis separados)
  support/           helpers (banco de teste, filas, relógio controlável, instâncias)
scripts/sqs-setup.ts criação das filas
```
