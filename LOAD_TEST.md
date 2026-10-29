# Teste de carga

```bash
docker compose up -d postgres localstack-aws
bun run test:load
```

O script ([`scripts/load-test.ts`](./scripts/load-test.ts)) é autossuficiente:

- recria um banco exclusivo (`${DATABASE_NAME}_load`) pelas migrations e cria filas exclusivas;
- roda **sem autenticação** por padrão; com `LOAD_AUTH=true`, liga a autenticação nas instâncias e usa tokens reais do Keycloak (ver [Com autenticação](#com-autenticação-keycloak));
- sobe **3 instâncias reais** da aplicação no modo com os três papéis num processo (`src/main.ts`), cada uma com HTTP, consumidores SQS, publishers da outbox e worker de referências. As execuções mais recentes ([papéis separados](#papéis-separados-prometheus-e-grafana), [ambiente recriado do zero](#ambiente-recriado-do-zero) e [partidas dobradas, ordem por wallet, retenção e OpenTelemetry](#partidas-dobradas-ordem-por-wallet-retenção-e-opentelemetry) [código final, com Swagger](#código-final-com-swagger) [Loki e Alloy no ar](#loki-e-alloy-no-ar) [tracing por camada e da API até o worker](#tracing-por-camada-e-da-api-até-o-worker) [repetição sem mudança de código](#repetição-sem-mudança-de-código) [segunda repetição](#segunda-repetição-sem-mudança-de-código) e [terceira repetição](#execução-atual-terceira-repetição-sem-mudança-de-código)) foram feitas depois da separação das imagens por papel no Compose (`api`, `consumer`, `workers`) e da entrada do Prometheus e do Grafana. As anteriores citam as réplicas `app`, o serviço único que existia então;
- aplica a carga, verifica a correção do resultado e remove as filas no fim;
- grava o relatório em `load-test/reports/<timestamp>.{md,json}`;
- termina com código 1 se encontrar qualquer inconsistência.

| Parâmetro | Padrão | |
|---|---|---|
| `LOAD_INSTANCES` | 3 | instâncias da aplicação |
| `LOAD_CONCURRENCY` | 64 | usuários virtuais HTTP |
| `LOAD_DURATION_SECONDS` / `LOAD_WARMUP_SECONDS` | 30 / 5 | janela medida / aquecimento (descartado) |
| `LOAD_WALLETS` / `LOAD_HOT_WALLETS` / `LOAD_HOT_SHARE` | 200 / 5 / 0.1 | wallets comuns, wallets disputadas e fração do tráfego para elas |
| `LOAD_SQS_MESSAGES` | 2000 | mensagens da fase SQS |
| `LOAD_DATABASE_NAME` | `${DATABASE_NAME}_load` | banco exclusivo |
| `LOAD_AUTH` | `false` | `true` = autenticação ligada, com tokens do Keycloak (`docker compose up -d keycloak`) |
| `LOAD_AUTH_ISSUER` | `AUTH_ISSUER` ou `http://localhost:8080/realms/wagering` | emissor/realm do Keycloak |

## Metodologia

1. **Preparação:** 200 wallets comuns (saldo 1.000.000,00) e 5 hot wallets (saldo 500,00, para gerar rejeições por saldo insuficiente).
2. **Fase HTTP:** 64 usuários virtuais em laço fechado (*closed loop*: cada um envia a próxima requisição quando recebe a resposta), distribuídos em round-robin entre as 3 instâncias. 5s de aquecimento descartados e 30s medidos. Mistura de operações:
   - 70% `BET`, 20% `WIN`, 10% `LOSS`, com valores aleatórios em centavos inteiros (o gerador também não usa ponto flutuante para dinheiro);
   - 5% de `REFUND` de apostas do próprio usuário já processadas, cada aposta estornada no máximo uma vez;
   - 5% de **replays** idempotentes (reenvio idêntico da requisição anterior);
   - 10% do tráfego vai para as hot wallets, o que provoca disputa de lock e rejeições.
3. **Fase SQS:** 2000 mensagens `WagerTransactionRequested` mais cerca de 10% de **reentregas** (mesmo `messageId`), enviadas em lote o mais rápido possível. O throughput do consumidor é a razão entre as mensagens únicas e o tempo do primeiro envio ao último commit. A latência é medida do envio ao `processed_at` da inbox (ambos com o relógio do host).
4. **Outbox:** a idade do evento pendente mais antigo é amostrada a cada 1s durante a carga, via `/metrics`. Ao final, o lag por evento (`published_at − occurred_at`) é calculado em SQL, em percentis, e também se mede o tempo de drenagem depois que a carga para.
5. **Concorrência:** os contadores das 3 instâncias são somados: `wagering_concurrency_conflicts_total` (lock timeout, deadlock, corrida de inserção, modificação concorrente), retentativas, DLQ e duplicatas.
6. **Correção depois da carga:**
   - em **todas** as wallets: saldo igual ao ledger, sequência de `wallet_version` sem lacunas e nenhum saldo negativo;
   - nenhuma transação em `PENDING_REFERENCE` sobrando.

Contagem de erro: falha de rede e 5xx. Os códigos `422` (rejeição de negócio) e `200` (replay) são respostas corretas e não entram como erro.

## Ambiente

| | |
|---|---|
| Máquina | Apple M4 Pro (14 núcleos), 48 GB, macOS 26 (darwin 25.6) |
| Aplicação | 3 processos Bun 1.4.4 **no host**, pool de 10 conexões PostgreSQL por instância |
| PostgreSQL | 16.15 em Docker |
| SQS | LocalStack em Docker: **community `localstack/localstack:4.10`** na [configuração final](#configuração-final-localstack-community-410); Pro nas execuções anteriores |
| **VM do Docker** | **2 CPUs · 2 GB** nas primeiras execuções; **2 CPUs · 10 GB** nas [execuções finais](#execuções-com-a-vm-de-10-gb). Compartilhados por PostgreSQL, LocalStack e, depois da autenticação, Keycloak |

Tudo roda na mesma máquina. O gerador de carga e as 3 instâncias disputam a CPU do host, e o banco, o broker e o IdP disputam os 2 núcleos da VM do Docker. Os números abaixo **não** representam a capacidade de um ambiente de produção. Valem como comparação relativa e para localizar gargalos.

## Resultados

### Execução de referência (parâmetros padrão)

| HTTP | |
|---|---|
| Requisições medidas | 18.822 em 30s |
| **Throughput** | **625 req/s** |
| **Taxa de erro** | **0,000%** (nenhum 5xx, nenhuma falha de rede, nenhum 503) |
| Status | 201: 17.390 · 200 (replay): 902 · 422 (rejeição de negócio): 530 |

| Latência (ms) | n | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
| todas | 18.822 | 101,3 | 151,1 | 175,5 | 260,6 |
| BET | 11.824 | 103,0 | 152,2 | 175,0 | 257,4 |
| WIN | 3.445 | 103,8 | 151,5 | 179,0 | 260,6 |
| LOSS | 1.685 | 94,0 | 140,3 | 168,1 | 232,6 |
| REFUND | 936 | 110,8 | 161,6 | 197,3 | 239,8 |
| replay idempotente | 932 | 75,1 | 113,4 | 129,6 | 175,5 |
| hot wallets | 1.732 | 102,1 | 153,3 | 173,3 | 206,7 |
| wallets comuns | 16.158 | 102,8 | 151,6 | 176,2 | 260,6 |

| SQS | |
|---|---|
| Mensagens | 2.000 únicas + 194 reentregas, todas deduplicadas (2.000 linhas na inbox) |
| **Throughput do consumidor** | **130 msg/s** (3 instâncias × 4 consumidores) |
| Latência envio → commit | p50 9,1s · p95 13,1s · p99 13,7s (fila: 2.194 mensagens enfileiradas em 3,2s) |

| Outbox | |
|---|---|
| Eventos publicados | 42.375 |
| Lag por evento | p50 8,8s · p95 13,0s · p99 13,3s · máx 13,4s |
| Lag amostrado durante a carga | máx 13,3s · médio 7,1s |
| Drenagem depois do fim da carga | **0,03s** |

| Concorrência e correção | |
|---|---|
| Conflitos de concorrência | 0 |
| Retentativas / DLQ | 0 / 0 |
| Duplicatas detectadas (replay + inbox) | 1.255 |
| Wallets com saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) |
| Transações | 22.295 (21.783 processadas, 512 rejeitadas, 0 pendentes) |

### Estresse de hot wallet (`LOAD_HOT_WALLETS=1 LOAD_HOT_SHARE=0.5`)

Metade do tráfego numa única wallet, todas as operações dela serializadas pelo `SELECT … FOR UPDATE`:

| | Throughput | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
| todas | 396 req/s | 135,9 ms | 397,8 ms | 546,9 ms | 1.166,8 ms |
| hot wallet | ~185 tx/s numa única wallet | 211,8 ms | 473,3 ms | 616,4 ms | 1.166,8 ms |
| wallets comuns | — | 91,1 ms | 236,9 ms | 290,6 ms | 346,3 ms |

Erros: 0 · conflitos de concorrência: 0 · 1.667 rejeições por saldo insuficiente na hot wallet · **consistente**.

### Com autenticação (Keycloak)

Duas execuções seguidas com os parâmetros padrão, nas mesmas condições (o Keycloak também ocupando a VM do Docker, por isso a linha de base fica abaixo da execução de referência acima). Na execução autenticada:

- as instâncias validam cada requisição: assinatura RS256 pelo JWKS do Keycloak, emissor, audience, validade e papel, além do isolamento por provedor;
- o gerador usa tokens reais por *client credentials*: `backoffice` para criar wallets e `provider-a` para as transações, renovados antes de expirar.

| HTTP | Sem autenticação | Com autenticação | Diferença |
|---|---|---|---|
| Throughput | 565,7 req/s | 561,1 req/s | −0,8% |
| Latência p50 | 112,2 ms | 113,5 ms | +1,3 ms |
| Latência p95 | 166,5 ms | 166,2 ms | ≈ |
| Latência p99 | 196,8 ms | 190,6 ms | ≈ (ruído) |
| Erros / 401 / 403 | 0 / — / — | 0 / 0 / 0 | |
| Correção após a carga | consistente | consistente | |

**O custo da autenticação ficou dentro do ruído da medição.** O IdP não está no caminho de cada requisição: o gerador obtém um token por cliente a cada poucos minutos, e cada instância só verifica a assinatura localmente, com as chaves do JWKS em cache. Em produção, o custo real é uma verificação RS256 por requisição, desprezível perto da transação SQL.

As fases de SQS e outbox não usam autenticação. As diferenças entre as duas execuções nessas fases vêm do estado do LocalStack, que foi reiniciado entre elas (ver limitações), e não da autenticação.

### Reexecução de verificação (após a autenticação)

Execução com os parâmetros padrão (autenticação desligada) sobre o código depois da autenticação e da remoção do `@nestjs/cli`, ainda com o LocalStack Pro, para confirmar que os resultados se reproduzem. Condições:

- o LocalStack foi reiniciado antes da execução, com a memória zerada;
- as réplicas `app` do Compose ficaram paradas durante a medição;
- o **Keycloak estava no ar** na VM do Docker (cerca de 510 MB), o que não acontecia na execução de referência.

| HTTP | |
|---|---|
| Requisições medidas | 18.582 em 30s |
| **Throughput** | **616,6 req/s** |
| **Taxa de erro** | **0,000%** (nenhum 5xx, nenhuma falha de rede, nenhum 503) |
| Status | 201: 17.121 · 200 (replay): 860 · 422 (rejeição de negócio): 601 |

| Latência (ms) | n | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
| todas | 18.582 | 103,0 | 152,4 | 176,8 | 320,9 |
| BET | 11.693 | 105,1 | 153,7 | 178,1 | 320,9 |
| WIN | 3.353 | 104,7 | 151,8 | 177,1 | 266,1 |
| LOSS | 1.703 | 96,1 | 142,9 | 165,7 | 230,7 |
| REFUND | 934 | 111,5 | 162,6 | 186,7 | 214,3 |
| replay idempotente | 899 | 75,2 | 115,2 | 128,4 | 155,6 |
| hot wallets | 1.712 | 105,5 | 160,3 | 201,0 | 320,9 |
| wallets comuns | 15.971 | 104,2 | 152,6 | 175,9 | 230,7 |

| SQS, outbox e correção | |
|---|---|
| Mensagens SQS | 2.000 únicas + 200 reentregas, todas deduplicadas (2.000 linhas na inbox) |
| Throughput do consumidor | 99,8 msg/s |
| Latência envio → commit (SQS) | p50 10,3s · p95 15,6s · p99 17,6s (2.200 mensagens enfileiradas em 3,4s) |
| Eventos publicados pela outbox | 41.865 |
| Lag por evento (outbox) | p50 8,4s · p95 12,3s · p99 12,7s · máx 12,9s |
| Drenagem da outbox depois do fim da carga | 0,29s |
| Conflitos de concorrência / retentativas / DLQ | 0 / 0 / 0 |
| Duplicatas detectadas (replay + inbox) | 1.218 |
| Wallets com saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) |
| Transações | 22.071 (21.494 processadas, 577 rejeitadas, 0 pendentes) |

Comparação com a execução de referência:

| | Referência | Reexecução | Diferença |
|---|---|---|---|
| Throughput HTTP | 625,4 req/s | 616,6 req/s | −1,4% |
| Latência p50 / p95 / p99 | 101,3 / 151,1 / 175,5 ms | 103,0 / 152,4 / 176,8 ms | +1,7 / +1,3 / +1,3 ms |
| Taxa de erro | 0% | 0% | — |
| Consumidor SQS | 130 msg/s | 99,8 msg/s | −23% |
| Lag da outbox (p50 / p99) | 8,8s / 13,3s | 8,4s / 12,7s | ≈ |
| Drenagem da outbox | 0,03s | 0,29s | ≈ (abaixo de 1s) |
| Correção | consistente | consistente | — |

A fase HTTP se reproduziu com diferença de cerca de 1,5%, dentro do ruído de execuções no mesmo host. O consumidor SQS ficou cerca de 23% mais lento. Na fase SQS, PostgreSQL e LocalStack dividem os 2 núcleos da VM do Docker com o Keycloak, que não estava no ar na execução de referência. O código do consumidor não mudou entre as duas execuções.

### Execuções com a VM de 10 GB

A memória da VM do Docker passou de 2 GB para 10 GB, ainda com 2 CPUs. As duas variantes rodaram **em sequência, sem reiniciar nada no meio**, o que antes derrubava o LocalStack. Condições:

- Keycloak e as 3 réplicas `app` do Compose no ar durante as medições (as réplicas ociosas);
- LocalStack sem reinício entre as execuções; chegou a cerca de 1,2 GB, o que na VM de 2 GB teria estourado.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 16.922 | 17.251 |
| **Throughput** | **562,3 req/s** | **572,5 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Status | 201: 15.636 · 200: 823 · 422: 463 | 201: 15.958 · 200: 831 · 422: 462 |
| Latência p50 / p95 / p99 | 112,1 / 175,5 / 213,1 ms | 111,3 / 165,4 / 187,7 ms |
| BET p50 / p99 | 113,7 / 213,7 ms | 112,9 / 187,9 ms |
| Replay idempotente p50 / p99 | 82,9 / 181,3 ms | 82,6 / 138,9 ms |
| Hot wallets p50 / p99 | 117,3 / 226,8 ms | 117,4 / 206,8 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| Mensagens SQS (únicas + reentregas) | 2.000 + 196, todas deduplicadas | 2.000 + 191, todas deduplicadas |
| Throughput do consumidor | 133,2 msg/s | 119,2 msg/s |
| Latência envio → commit (p50 / p99) | 8,8s / 13,3s | 9,4s / 14,4s |
| Eventos publicados pela outbox | 38.785 | 40.127 |
| Lag por evento (p50 / p99) | 7,6s / 11,5s | 8,1s / 12,2s |
| Drenagem da outbox depois do fim da carga | 0,04s | 0,04s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Duplicatas detectadas | 1.156 | 1.159 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Transações (processadas / rejeitadas / pendentes) | 20.377 (19.934 / 443 / 0) | 21.057 (20.608 / 449 / 0) |

O que a memória maior mudou e o que não mudou:

- **Estabilidade:** duas execuções completas seguidas, sem OOM e sem precisar reiniciar o LocalStack.
- **Vazão:** **não mudou.** A fase HTTP ficou em cerca de 560–575 req/s, na mesma faixa das execuções com o Keycloak na VM de 2 GB (561–566 req/s). O limite é CPU: os 2 núcleos da VM, divididos entre PostgreSQL, LocalStack e Keycloak, mais o host compartilhado com o gerador. Memória não era o gargalo.
- **Autenticação:** a execução autenticada foi até ligeiramente mais rápida (+1,8%), o que confirma que a diferença entre as duas variantes é ruído. A verificação local do JWT não aparece no custo.
- **SQS:** 119–133 msg/s, voltando à faixa da referência (130 msg/s). A queda para 99,8 msg/s na reexecução anterior coincidiu com a fase SQS disputando a VM pequena com o Keycloak.

### Configuração final (LocalStack community 4.10)

Esta é a configuração com que o projeto é entregue: LocalStack **community `localstack/localstack:4.10`**, sem token, e VM do Docker com 2 CPUs e 10 GB. O ambiente foi recriado do zero (`docker compose down --volumes` e `up`). As duas variantes rodaram em sequência, sem reiniciar nada no meio, com Keycloak e as 3 réplicas `app` do Compose no ar (as réplicas ociosas).

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 16.140 | 15.865 |
| **Throughput** | **536,2 req/s** | **526,9 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Status | 201: 14.948 · 200: 776 · 422: 416 | 201: 14.610 · 200: 773 · 422: 482 |
| Latência p50 / p95 / p99 | 118,4 / 172,4 / 202,5 ms | 120,3 / 173,4 / 207,3 ms |
| BET p50 / p99 | 120,1 / 203,0 ms | 122,4 / 208,9 ms |
| Replay idempotente p50 / p99 | 86,4 / 163,9 ms | 88,0 / 150,7 ms |
| Hot wallets p50 / p99 | 122,2 / 210,6 ms | 122,0 / 211,7 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| Mensagens SQS (únicas + reentregas) | 2.000 + 206, todas deduplicadas | 2.000 + 203, todas deduplicadas |
| **Throughput do consumidor** | **181,8 msg/s** | **206,0 msg/s** |
| Latência envio → commit (p50 / p99) | 6,0s / 9,8s | 4,8s / 8,7s |
| Eventos publicados pela outbox | 37.701 | 36.741 |
| Lag por evento (p50 / p99) | 5,4s / 8,9s | 3,0s / 6,7s |
| Drenagem da outbox depois do fim da carga | 0,30s | 0,04s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Duplicatas detectadas | 1.123 | 1.095 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Transações (processadas / rejeitadas / pendentes) | 19.830 (19.414 / 416 / 0) | 19.319 (18.854 / 465 / 0) |
| Pico de memória do LocalStack | ~420 MB | ~550 MB |

Comparação com as execuções anteriores, que usavam a Pro na mesma VM de 10 GB:

| | Pro (sem / com auth) | Community 4.10 (sem / com auth) | Diferença |
|---|---|---|---|
| Throughput HTTP | 562,3 / 572,5 req/s | 536,2 / 526,9 req/s | −5% a −8% |
| Latência HTTP p99 | 213,1 / 187,7 ms | 202,5 / 207,3 ms | ≈ |
| Consumidor SQS | 133,2 / 119,2 msg/s | 181,8 / 206,0 msg/s | **+37% a +73%** |
| Lag da outbox (p50) | 7,6 / 8,1 s | 5,4 / 3,0 s | **menor** |
| Pico de memória do LocalStack | ~1,2 GB | ~550 MB | **−55%** |

- **Correção:** igual em todas as configurações. Nenhum erro, nenhuma duplicata aplicada, nenhuma divergência entre saldo e ledger.
- **SQS e outbox:** a community responde mais rápido no caminho SQS deste projeto. O consumidor processa mais mensagens por segundo, os publishers da outbox acompanham melhor (lag menor) e o broker usa menos da metade da memória.
- **HTTP:** caiu cerca de 5–8%. Provavelmente é efeito colateral do ponto anterior: com o SQS mais rápido, os publishers da outbox publicam mais durante a fase HTTP e ocupam mais dos mesmos 2 núcleos da VM, que PostgreSQL, LocalStack e Keycloak dividem. A latência p99 ficou na mesma faixa.
- **Autenticação:** a diferença entre as duas variantes continua no ruído (−1,7% de vazão e cerca de 2 ms no p50).

### Papéis separados, Prometheus e Grafana

Mesma configuração final (LocalStack community 4.10, VM de 2 CPUs e 10 GB), agora com o Compose da entrega: imagens separadas por papel e observabilidade no ar. Durante as medições estavam rodando, ociosas, as réplicas do Compose (3 `api`, 2 `consumer`, 2 `workers`, sobre o banco de desenvolvimento e as filas padrão), além do Keycloak, do Prometheus coletando essas 7 réplicas a cada 5s e do Grafana. O gerador continua subindo 3 instâncias próprias com os três papéis num processo (`src/main.ts`), num banco e em filas exclusivos. As duas variantes rodaram em sequência, sem reiniciar nada.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 16.189 | 15.089 |
| **Throughput** | **537,7 req/s** | **501,0 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Status | 201: 15.030 · 200: 750 · 422: 409 | 201: 13.980 · 200: 701 · 422: 408 |
| Latência p50 / p95 / p99 | 118,7 / 170,6 / 203,2 ms | 126,2 / 184,2 / 224,3 ms |
| BET p50 / p99 | 120,7 / 204,3 ms | 128,5 / 227,0 ms |
| Replay idempotente p50 / p99 | 87,4 / 144,4 ms | 91,7 / 172,2 ms |
| Hot wallets p50 / p99 | 122,2 / 224,1 ms | 128,8 / 240,1 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| Mensagens SQS (únicas + reentregas) | 2.000 + 240, todas deduplicadas | 2.000 + 200, todas deduplicadas |
| **Throughput do consumidor** | **181,6 msg/s** | **196,3 msg/s** |
| Latência envio → commit (p50 / p99) | 5,9s / 10,1s | 5,1s / 9,0s |
| Eventos publicados pela outbox | 38.365 | 35.110 |
| Lag por evento (p50 / p99) | 4,7s / 7,7s | 3,9s / 6,7s |
| Drenagem da outbox depois do fim da carga | 0,30s | 0,03s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Duplicatas detectadas | 1.131 | 1.026 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Transações (processadas / rejeitadas / pendentes) | 20.153 (19.751 / 402 / 0) | 18.451 (18.057 / 394 / 0) |
| Memória do LocalStack ao fim da execução | ~420 MB | ~550 MB |

Comparação com a execução anterior da configuração final:

| | Configuração final (sem / com auth) | Execução atual (sem / com auth) | Diferença |
|---|---|---|---|
| Throughput HTTP | 536,2 / 526,9 req/s | 537,7 / 501,0 req/s | +0,3% / −4,9% |
| Latência HTTP p99 | 202,5 / 207,3 ms | 203,2 / 224,3 ms | ≈ / +17 ms |
| Consumidor SQS | 181,8 / 206,0 msg/s | 181,6 / 196,3 msg/s | ≈ / −4,7% |
| Lag da outbox (p50) | 5,4 / 3,0 s | 4,7 / 3,9 s | ≈ |
| Drenagem da outbox | 0,30 / 0,04 s | 0,30 / 0,03 s | ≈ |

- **Correção:** igual a todas as execuções anteriores. Nenhum erro, nenhuma duplicata aplicada, nenhuma divergência entre saldo e ledger, nenhuma pendência no fim.
- **Sem autenticação:** praticamente idêntica à execução anterior (vazão +0,3%, percentis HTTP, consumidor e drenagem na mesma faixa). As 7 réplicas ociosas do Compose, o Prometheus e o Grafana não tiveram custo mensurável.
- **Com autenticação:** 6,8% abaixo da variante sem autenticação, mais que a diferença de 1,7% medida antes. A verificação do JWT é local (RS256 com as chaves do JWKS em cache), e nas execuções anteriores o custo dela ficou dentro do ruído. Nesta execução não foi isolada a causa. Uma hipótese é a disputa da CPU do host e da VM na segunda execução seguida, com o LocalStack crescendo de ~420 MB para ~550 MB, mas isso não foi verificado. Para separar o efeito, seria preciso alternar a ordem das variantes e repetir cada uma algumas vezes.
- **Relatórios:** `load-test/reports/2026-10-28T16-35-55-853Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-28T16-36-52-195Z.{md,json}` (com autenticação). A pasta está no `.gitignore`.

### Ambiente recriado do zero

Mesma configuração da seção anterior, com o ambiente recriado do zero (`docker compose down --remove-orphans --volumes` e `docker compose up -d`): PostgreSQL, Prometheus e Grafana sem dados, LocalStack e Keycloak recém-iniciados. O `setup` aplicou a migration inicial consolidada (que substituiu as 5 migrations anteriores com o mesmo schema) e criou as filas. Antes da carga, a suíte completa passou (456 testes). As duas variantes rodaram em sequência, sem reiniciar nada, com as réplicas do Compose ociosas, o Prometheus e o Grafana no ar.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 17.392 | 16.577 |
| **Throughput** | **577,5 req/s** | **549,9 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Status | 201: 16.153 · 200: 822 · 422: 417 | 201: 15.356 · 200: 786 · 422: 435 |
| Latência p50 / p95 / p99 | 108,5 / 167,2 / 191,8 ms | 113,9 / 181,5 / 221,3 ms |
| BET p50 / p99 | 110,5 / 192,5 ms | 116,0 / 219,4 ms |
| Replay idempotente p50 / p99 | 79,6 / 143,5 ms | 81,9 / 161,6 ms |
| Hot wallets p50 / p99 | 112,3 / 213,7 ms | 118,7 / 238,6 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| Mensagens SQS (únicas + reentregas) | 2.000 + 214, todas deduplicadas | 2.000 + 197, todas deduplicadas |
| **Throughput do consumidor** | **184,7 msg/s** | **188,4 msg/s** |
| Latência envio → commit (p50 / p99) | 5,8s / 9,7s | 6,0s / 9,6s |
| Eventos publicados pela outbox | 39.854 | 38.206 |
| Lag por evento (p50 / p99) | 5,5s / 9,1s | 4,8s / 8,8s |
| Drenagem da outbox depois do fim da carga | 0,04s | 0,28s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Duplicatas detectadas | 1.187 | 1.094 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Transações (processadas / rejeitadas / pendentes) | 20.949 (20.551 / 398 / 0) | 20.010 (19.592 / 418 / 0) |
| Memória do LocalStack ao fim da execução | ~430 MB | ~580 MB |

Comparação com a execução anterior (papéis separados, ambiente já em uso):

| | Anterior (sem / com auth) | Atual (sem / com auth) | Diferença |
|---|---|---|---|
| Throughput HTTP | 537,7 / 501,0 req/s | 577,5 / 549,9 req/s | +7,4% / +9,8% |
| Latência HTTP p99 | 203,2 / 224,3 ms | 191,8 / 221,3 ms | −11 / −3 ms |
| Consumidor SQS | 181,6 / 196,3 msg/s | 184,7 / 188,4 msg/s | ≈ |
| Lag da outbox (p50) | 4,7 / 3,9 s | 5,5 / 4,8 s | ≈ |

- **Correção:** igual a todas as execuções anteriores. Nenhum erro, nenhuma duplicata aplicada, nenhuma divergência entre saldo e ledger, nenhuma pendência no fim.
- **Vazão HTTP maior:** a única mudança de código desde a execução anterior foi a consolidação das migrations, que não altera tabelas, índices nem consultas (o schema foi conferido por `pg_dump`). A causa provável é o ambiente recém-criado (volumes vazios, LocalStack e Keycloak recém-iniciados), mas isso não foi isolado.
- **Autenticação:** 4,8% abaixo da variante sem autenticação. Somando as execuções medidas, essa diferença oscilou entre 1,7% e 6,8%, sempre com a variante autenticada rodando em segundo lugar. A verificação do JWT é local; separar o custo dela da ordem de execução exigiria alternar as variantes e repetir cada uma.
- **Relatórios:** `load-test/reports/2026-10-28T17-17-35-733Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-28T17-18-26-355Z.{md,json}` (com autenticação).

### Partidas dobradas, ordem por wallet, retenção e OpenTelemetry

Mesmo ambiente (LocalStack community 4.10, VM de 2 CPUs e 10 GB), agora com o Jaeger também no ar. O tracing fica desligado nas instâncias do gerador (`OTEL_ENABLED=false`), então os números medem o código, não a exportação de spans. A verificação de correção ganhou duas linhas: contrapartida na moeda da wallet e balancete (Σ saldos materializados das wallets + Σ contas de sistema = 0).

**Base no mesmo ambiente.** Para comparar com justiça, o código do último commit (sem nenhuma das mudanças) foi rodado de novo, numa worktree separada e num banco de carga próprio, logo antes das medições: **571,6 req/s**, p50 109,9 ms, p99 205,1 ms.

**Dois modelos de ledger de partidas dobradas** (sem autenticação):

| Variante | Vazão HTTP | p50 / p99 |
|---|---|---|
| Base (último commit) | 571,6 req/s | 109,9 / 205,1 ms |
| Tabela de partidas (N pernas) + constraint triggers diferidos, primeira versão | 348,1 req/s | 179,3 / 346,6 ms |
| Idem, com contas e partidas num só `INSERT` e o trigger numa só consulta | 387,4 req/s | 161,5 / 316,7 ms |
| Idem, sem os triggers (A/B temporário) | 463,5 req/s | 133,2 / 277,4 ms |
| Sem partidas e sem triggers (A/B temporário) | 503,5 req/s | 124,2 / 232,4 ms |
| Sem a regra de ordem por wallet (A/B temporário, com partidas) | 373,8 req/s | 166,5 / 317,7 ms |
| **Transferência por linha (adotado)** | **454,8 req/s** | **140,2 / 243,7 ms** |
| Transferência por linha sem a FK da contrapartida (A/B temporário) | 488,0 req/s | 129,7 / 274,7 ms |

- **A ordem por wallet não custou vazão:** com e sem a regra, 387 e 374 req/s, dentro da variação entre execuções.
- **Os triggers diferidos eram o maior custo** (cerca de 18%): rodam no commit, ainda com o lock da wallet, três vezes por transação. As linhas de partida custavam mais cerca de 8%.
- **Modelo adotado:** cada lançamento do extrato é a própria transferência (conta da wallet × `counter_account_id`), balanceada por construção, sem tabela de partidas nem triggers. Custa cerca de 20% da base; a FK da contrapartida responde por cerca de 7%, porque cada `INSERT` trava em `KEY SHARE` a mesma linha da conta do provedor. Foi mantida pela integridade referencial no schema.
- **Os cerca de 12% restantes** (503 contra 571, sem nenhum ledger novo) vêm das demais mudanças (índices extras da outbox, `seq`, reserva em duas etapas) somadas à variação entre execuções; não foram isolados um a um.
- Variantes "A/B temporário": alterações feitas só para a medição e desfeitas em seguida.

Resultado do modelo adotado, nas duas variantes:

| | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 13.705 | 13.849 |
| **Throughput** | **454,8 req/s** | **459,7 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 140,2 / 208,2 / 243,7 ms | 136,4 / 220,1 / 272,0 ms |
| Hot wallets p50 / p99 | 145,3 / 269,4 ms | 139,0 / 298,7 ms |
| **Throughput do consumidor** | **164,4 msg/s** | **160,5 msg/s** |
| Lag por evento (p50 / p99) | 6,7s / 18,2s | 7,6s / 19,5s |
| Drenagem da outbox depois do fim da carga | 3,82s | 5,58s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 17.030 (16.738 / 292 / 0) | 17.213 (16.844 / 369 / 0) |

- **Correção:** igual a todas as execuções anteriores, agora também no ledger de partidas dobradas.
- **Autenticação:** desta vez a variante autenticada ficou 1% acima, dentro do ruído, o que reforça que a diferença das execuções anteriores vinha da ordem das rodadas.
- **Outbox:** o lag e a drenagem pioraram nesta rodada (p99 de 18–20s, drenagem de 4–6s), sem retentativas. A ordem por wallet faz uma wallet muito ativa ser publicada por um publisher de cada vez, em lotes de até 10. As execuções intermediárias, com a mesma regra, tiveram lag p50 de 1,2–3,9s, então a variação entre rodadas é grande; não foi isolado.
- **Relatórios:** `load-test/reports/2026-10-28T18-43-29-536Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-28T18-44-24-629Z.{md,json}` (com autenticação).

### Código final, com Swagger

Esta rodada mede o código como está agora: com a documentação Swagger e os comentários reescritos, nada que passe pelo caminho quente. O ambiente é o mesmo da seção anterior, com as réplicas do Compose, o Prometheus, o Grafana e o Jaeger no ar e ociosos, e o tracing desligado nas instâncias do gerador. Antes da carga, a suíte completa passou (495 testes), e as duas variantes rodaram em sequência, sem reiniciar nada.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 14.872 | 14.909 |
| **Throughput** | **494,1 req/s** | **494,3 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 127,7 / 196,7 / 240,8 ms | 126,5 / 206,8 / 250,8 ms |
| Hot wallets p50 / p99 | 134,9 / 270,2 ms | 131,6 / 271,3 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| **Throughput do consumidor** | **171,7 msg/s** | **156,9 msg/s** |
| Lag por evento (p50 / p99) | 5,7s / 12,4s | 7,4s / 18,1s |
| Drenagem da outbox depois do fim da carga | 0,53s | 3,06s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 18.197 (17.850 / 347 / 0) | 18.178 (17.816 / 362 / 0) |

A correção continua total, como em todas as rodadas anteriores: nenhum erro, nenhuma divergência entre saldo e ledger, contrapartidas na moeda certa, balancete zerado e nenhuma transação pendente no fim.

A vazão ficou em 494 req/s nas duas variantes, um pouco acima da rodada anterior (455 e 460 req/s). Como o Swagger e os comentários não mexem no processamento das transações, atribuímos a diferença à variação normal entre rodadas, que já vimos ser de alguns pontos percentuais neste ambiente. A autenticação, desta vez, não teve custo nenhum, com a mesma vazão nas duas variantes. Isso reforça a leitura das rodadas anteriores: a verificação local do JWT não pesa, e as diferenças medidas antes vinham da ordem em que as variantes rodavam.

O lag da outbox segue alto durante o pico e variando bastante de uma rodada para outra, mas a fila drena em segundos assim que a carga para, sem nenhuma retentativa.

Os relatórios estão em `load-test/reports/2026-10-28T19-58-46-416Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-28T19-59-39-233Z.{md,json}` (com autenticação).

### Loki e Alloy no ar

Esta rodada repete a anterior com o Loki e o Grafana Alloy no Compose. O código da aplicação não mudou desde a rodada com Swagger; a diferença está só no ambiente. Antes da carga, a suíte completa passou (495 testes), e as duas variantes rodaram em sequência, sem reiniciar nada.

Vale saber o que esta rodada mede e o que não mede. As instâncias do gerador rodam como processos no host, e não como containers, então os logs delas não passam pelo Alloy nem pelo Loki. O que entra na conta é ter os dois serviços no ar na mesma VM do Docker, ao lado das réplicas ociosas do Compose, do Prometheus, do Grafana e do Jaeger. Juntos, Loki e Alloy ficaram abaixo de 1% de CPU e em torno de 140 MB de memória durante a carga.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 15.042 | 13.460 |
| **Throughput** | **499,3 req/s** | **446,5 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 124,5 / 215,9 / 284,9 ms | 141,1 / 220,6 / 265,2 ms |
| Hot wallets p50 / p99 | 128,7 / 293,7 ms | 145,2 / 275,1 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| **Throughput do consumidor** | **152,8 msg/s** | **155,6 msg/s** |
| Lag por evento (p50 / p99) | 8,9s / 15,5s | 6,5s / 17,1s |
| Drenagem da outbox depois do fim da carga | 2,05s | 2,11s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 18.419 (18.059 / 360 / 0) | 16.668 (16.270 / 398 / 0) |

A correção continua total nas duas variantes: nenhum erro, nenhuma divergência entre saldo e ledger, contrapartidas na moeda certa, balancete zerado e nenhuma pendência no fim.

Sem autenticação, a vazão ficou em 499 req/s, praticamente a mesma da rodada anterior (494 req/s), o que mostra que ter Loki e Alloy no ar não pesou no caminho quente. Com autenticação, ela caiu para 446 req/s, cerca de 10% abaixo. Na rodada anterior as duas variantes empataram, e em rodadas mais antigas a autenticada ficou de 1% acima a 7% abaixo. Como a verificação do JWT é local e não mudou, lemos essa oscilação como variação entre rodadas neste ambiente, sempre com a variante autenticada rodando em segundo lugar. Isolar o efeito de verdade exigiria alternar a ordem das variantes e repetir cada uma algumas vezes.

O consumidor da fila ficou em torno de 155 msg/s nas duas variantes, um pouco abaixo da rodada anterior. O lag da outbox continua alto durante o pico, mas a fila drenou em cerca de 2s depois da carga, sem nenhuma retentativa.

Os relatórios estão em `load-test/reports/2026-10-29T12-54-31-165Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-29T12-55-23-337Z.{md,json}` (com autenticação).

### Tracing por camada e da API até o worker

Esta rodada mede o código com o tracing por camada e o trace contínuo da API até o worker. Para isso, cada use case passou a ser envolvido por um wrapper, a liquidação passou a abrir spans pela porta `Tracer`, o `EntityManager` rastreado passou a ser usado em toda transação e a gravação da transação passou a guardar o `traceparent` de origem. O ambiente é o mesmo da rodada anterior, com Loki e Alloy no ar. A suíte completa passou antes da carga (499 testes), e as duas variantes rodaram em sequência, sem reiniciar nada.

As instâncias do gerador rodam com o tracing desligado, como nas rodadas anteriores. Então o que entra na conta é só o custo de o código passar pelos wrappers e verificar, a cada chamada, se há um trace ativo, e não o de criar e exportar spans.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 14.085 | 13.095 |
| **Throughput** | **467,4 req/s** | **434,3 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 128,7 / 234,9 / 293,7 ms | 143,1 / 234,8 / 290,5 ms |
| Hot wallets p50 / p99 | 132,6 / 334,5 ms | 147,0 / 315,9 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| **Throughput do consumidor** | **178,3 msg/s** | **170,0 msg/s** |
| Lag por evento (p50 / p99) | 4,1s / 13,9s | 5,4s / 13,5s |
| Drenagem da outbox depois do fim da carga | 1,05s | 1,04s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 17.361 (17.048 / 313 / 0) | 16.329 (16.046 / 283 / 0) |

A correção continua total nas duas variantes, como em todas as rodadas: nenhum erro, nenhuma divergência entre saldo e ledger, contrapartidas na moeda certa, balancete zerado e nenhuma pendência no fim.

A vazão HTTP ficou um pouco abaixo da rodada anterior: 467 contra 499 req/s sem autenticação e 434 contra 446 req/s com autenticação, uma queda de 3% a 6%. Parte disso pode vir das camadas novas, já que agora toda chamada de use case e toda instrução SQL passa por um wrapper que verifica se há trace ativo. Mas a diferença está dentro da variação que já vimos entre rodadas neste ambiente (494 a 499 req/s nas duas rodadas anteriores, sem mudança de código entre elas), então não dá para atribuí-la com segurança. Separar o efeito exigiria repetir as variantes várias vezes, com e sem os wrappers.

Na outra ponta, a outbox se saiu melhor do que na rodada anterior: o lag por evento caiu (p50 de 4,1 a 5,4s, contra 6,5 a 8,9s), a fila drenou em cerca de 1s depois da carga e o consumidor subiu para 170 a 178 msg/s. Como o lag da outbox varia bastante de uma rodada para outra, também tratamos isso como variação, e não como efeito das mudanças.

Os relatórios estão em `load-test/reports/2026-10-29T13-23-32-426Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-29T13-24-22-222Z.{md,json}` (com autenticação).

### Repetição sem mudança de código

Entre a rodada anterior e esta, o código da aplicação não mudou: só a documentação (o índice do README e o título do índice no ARCHITECTURE). Por isso, esta execução vale como medida da variação natural entre rodadas neste ambiente. A suíte completa passou antes da carga (499 testes), e as duas variantes rodaram em sequência, sem reiniciar nada.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 13.769 | 12.778 |
| **Throughput** | **456,6 req/s** | **423,8 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 134,4 / 230,5 / 276,9 ms | 142,5 / 268,0 / 343,1 ms |
| Hot wallets p50 / p99 | 142,9 / 297,1 ms | 147,9 / 356,1 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| **Throughput do consumidor** | **161,2 msg/s** | **153,4 msg/s** |
| Lag por evento (p50 / p99) | 5,5s / 15,6s | 6,0s / 13,1s |
| Drenagem da outbox depois do fim da carga | 1,04s | 1,04s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 17.049 (16.742 / 307 / 0) | 16.071 (15.728 / 343 / 0) |

A correção continua total nas duas variantes, como em todas as rodadas.

Com o mesmo código, a vazão ficou 2% abaixo da rodada anterior nas duas variantes (456 contra 467 req/s sem autenticação e 424 contra 434 req/s com autenticação). É uma boa referência para ler as comparações deste documento: diferenças de poucos pontos percentuais entre rodadas estão dentro do ruído do ambiente.

As últimas rodadas mostram uma pequena queda contínua, e uma explicação provável é o estado acumulado do ambiente. O LocalStack estava no ar desde a recriação da stack e já tinha passado por várias rodadas seguidas; logo depois desta, ele ainda estava em 87% de CPU, provavelmente limpando as filas da execução, com 572 MB de memória. Como o LocalStack divide os 2 núcleos da VM com o PostgreSQL, isso pesa na vazão. Não verificamos essa hipótese; para confirmar, seria preciso reiniciar o LocalStack e repetir a rodada. Para comparações mais justas entre versões, a recomendação continua sendo partir de um ambiente recém-criado.

Os relatórios estão em `load-test/reports/2026-10-29T13-34-05-045Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-29T13-34-56-613Z.{md,json}` (com autenticação).

### Segunda repetição sem mudança de código

Mais uma rodada com exatamente o mesmo código das duas anteriores, de novo com a suíte completa passando antes (499 testes) e as duas variantes em sequência, sem reiniciar nada. Com três rodadas da mesma versão, dá para enxergar melhor quanto este ambiente varia sozinho.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 13.857 | 13.651 |
| **Throughput** | **460,0 req/s** | **453,1 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 134,0 / 223,9 / 273,9 ms | 133,4 / 241,6 / 307,7 ms |
| Hot wallets p50 / p99 | 138,4 / 310,6 ms | 138,6 / 338,0 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| **Throughput do consumidor** | **167,7 msg/s** | **175,7 msg/s** |
| Lag por evento (p50 / p99) | 4,7s / 13,7s | 3,5s / 10,2s |
| Drenagem da outbox depois do fim da carga | 0,54s | 0,54s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 17.259 (16.882 / 377 / 0) | 16.950 (16.631 / 319 / 0) |

A correção continua total, como em todas as rodadas.

As três rodadas com o mesmo código, lado a lado:

| Rodada | Sem autenticação | Com autenticação |
|---|---|---|
| [Tracing por camada](#tracing-por-camada-e-da-api-até-o-worker) | 467,4 req/s | 434,3 req/s |
| [Repetição](#repetição-sem-mudança-de-código) | 456,6 req/s | 423,8 req/s |
| Segunda repetição | 460,0 req/s | 453,1 req/s |
| **Faixa** | **456,6 a 467,4 (±1,2%)** | **423,8 a 453,1 (±3,3%)** |

Sem autenticação, a vazão ficou numa faixa estreita, de pouco mais de 2% entre a menor e a maior. Com autenticação, a faixa foi bem mais larga, perto de 7%. Isso ajuda a ler as rodadas anteriores: as diferenças entre a variante com e sem autenticação, que já foram de +1% a −10%, cabem nessa variação e não indicam um custo real da verificação do JWT.

Esta rodada também desmente a hipótese da seção anterior. A vazão não continuou caindo: subiu nas duas variantes, mesmo com o LocalStack ainda mais carregado do que antes (100% de CPU e 588 MB logo depois da carga). A queda observada entre as rodadas anteriores era, portanto, variação comum, e não efeito de estado acumulado no LocalStack.

Os relatórios estão em `load-test/reports/2026-10-29T13-41-46-246Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-29T13-42-35-174Z.{md,json}` (com autenticação).

### Execução atual (terceira repetição sem mudança de código)

O código da aplicação continua o mesmo das três rodadas anteriores; desde então, só o README mudou. A suíte completa passou antes da carga (499 testes), e as duas variantes rodaram em sequência, sem reiniciar nada.

| HTTP | Sem autenticação | Com autenticação (Keycloak) |
|---|---|---|
| Requisições medidas | 13.656 | 14.268 |
| **Throughput** | **453,4 req/s** | **473,9 req/s** |
| **Taxa de erro** | **0,000%** | **0,000%** (nenhum 401/403) |
| Latência p50 / p95 / p99 | 135,5 / 233,7 / 297,7 ms | 126,1 / 245,6 / 378,2 ms |
| Hot wallets p50 / p99 | 140,6 / 311,1 ms | 128,4 / 385,7 ms |

| SQS, outbox e correção | Sem autenticação | Com autenticação |
|---|---|---|
| **Throughput do consumidor** | **169,2 msg/s** | **147,7 msg/s** |
| Lag por evento (p50 / p99) | 4,4s / 13,7s | 9,1s / 19,9s |
| Drenagem da outbox depois do fim da carga | 0,78s | 7,36s |
| Conflitos / retentativas / DLQ | 0 / 0 / 0 | 0 / 0 / 0 |
| Saldo ≠ ledger / lacunas / saldo negativo | **0 / 0 / 0** (205 wallets) | **0 / 0 / 0** (205 wallets) |
| Contrapartida em moeda ≠ da wallet | **0** | **0** |
| Balancete (Σ wallets + Σ contas de sistema) | **0,00** | **0,00** |
| Transações (processadas / rejeitadas / pendentes) | 17.039 (16.775 / 264 / 0) | 17.630 (17.216 / 414 / 0) |

A correção continua total, como em todas as rodadas.

Agora são quatro rodadas com o mesmo código:

| Rodada | Sem autenticação | Com autenticação |
|---|---|---|
| [Tracing por camada](#tracing-por-camada-e-da-api-até-o-worker) | 467,4 req/s | 434,3 req/s |
| [Repetição](#repetição-sem-mudança-de-código) | 456,6 req/s | 423,8 req/s |
| [Segunda repetição](#segunda-repetição-sem-mudança-de-código) | 460,0 req/s | 453,1 req/s |
| Terceira repetição (esta) | 453,4 req/s | 473,9 req/s |
| **Faixa** | **453,4 a 467,4 (±1,5%)** | **423,8 a 473,9 (±5,6%)** |

Sem autenticação, a vazão segue estável: são 3% entre a menor e a maior rodada. Com autenticação, a faixa ficou ainda mais larga, com quase 12% entre a menor e a maior, e desta vez a variante autenticada passou a sem autenticação, com a maior vazão já medida para ela. Isso fecha a questão levantada nas rodadas anteriores: a verificação do JWT não tem custo mensurável, e as diferenças entre as duas variantes são variação do ambiente. A variante autenticada roda sempre em segundo lugar e é a que mais oscila, o que sugere que o estado deixado pela primeira rodada pesa mais do que a autenticação em si.

Na variante autenticada, a outbox teve uma das piores rodadas: lag p99 de quase 20s e 7,4s de drenagem. Ainda assim, não houve retentativa, e a fila terminou sem nada pendente. Como essa variante também teve a maior vazão HTTP, gerou mais eventos durante a carga, o que ajuda a explicar a fila mais longa no fim.

Os relatórios estão em `load-test/reports/2026-10-29T14-16-52-693Z.{md,json}` (sem autenticação) e `load-test/reports/2026-10-29T14-17-50-485Z.{md,json}` (com autenticação).

### Gargalo encontrado e corrigido: publicação da outbox

A primeira execução completa mostrou o publisher da outbox ficando para trás de forma crescente:

| | Antes | Depois |
|---|---|---|
| Lag por evento (p50 / p99) | 67,6s / 85,3s | 8,8s / 13,3s |
| Lag máximo amostrado durante a carga | 29,1s | 13,3s |
| Drenagem depois do fim da carga | **82,1s** | **0,03s** |
| Custo da reserva de um lote com 45 mil pendentes (`EXPLAIN ANALYZE`) | 14,5ms (seq scan + sort) | **0,038ms** (index scan) |

Duas causas, ambas corrigidas:

1. **Índice que não servia à consulta.** O índice parcial era `(next_attempt_at, occurred_at)`, mas a reserva ordena por `occurred_at, id`. Cada lote ordenava o backlog inteiro, e o custo crescia exatamente quando o backlog crescia. Agora o índice é `(occurred_at, id) WHERE published_at IS NULL` (hoje parte da migration inicial consolidada).
2. **Publicação sequencial por instância.** O custo de cada lote é dominado pela ida e volta ao SQS. Agora cada instância roda `OUTBOX_PUBLISHER_CONCURRENCY` laços (padrão 4), com segurança garantida pelo `SKIP LOCKED`.

## Análise

- **Reprodutibilidade:** a reexecução após a autenticação ficou a cerca de 1,5% da referência na fase HTTP (vazão e percentis). A fase SQS é mais sensível ao broker e ao que mais estiver rodando na VM do Docker: com o LocalStack community 4.10 (configuração final), o consumidor chegou a 182–206 msg/s.
- **Correção sob carga:** em todas as execuções, nenhum erro, nenhum crédito ou débito duplicado (1.255 duplicatas detectadas e absorvidas), nenhuma divergência entre saldo e ledger, nenhuma lacuna na sequência do ledger e nenhum saldo negativo. Isso inclui o cenário com metade do tráfego numa única wallet.
- **Latência HTTP dominada por fila:** com 64 usuários em laço fechado, a lei de Little dá 64 / 625 ≈ 102ms, praticamente o p50 medido. O tempo de serviço é bem menor; o que se mede é principalmente espera por CPU e conexões, num ambiente em que tudo divide a mesma máquina e o banco tem 2 núcleos. O replay é o caminho mais barato (cerca de 25% mais rápido), porque responde sem pegar o lock da wallet.
- **Hot wallet:** a serialização por lock limita uma única wallet a cerca de 185 transações/s nesta máquina (cerca de 5ms de seção crítica). As outras wallets continuam com latência próxima da referência. Não houve lock timeout (limite de 5s), por isso a métrica de conflitos ficou em zero: ela conta disputas que **falham**, não esperas por lock. Medir o tempo de espera por lock é uma melhoria possível.
- **Outbox:** depois da correção, o lag fica limitado e a drenagem é imediata quando a carga para. Durante o pico (cerca de 1.100 eventos/s produzidos), o lag ainda sobe até cerca de 13s: a publicação para o LocalStack, na VM de 2 núcleos, é mais lenta que a produção de eventos. O gauge `wagering_outbox_lag_seconds` mostra exatamente isso em produção.
- **SQS:** 130 msg/s com 12 consumidores. Cada mensagem custa receive, uma transação e delete, com ida e volta ao LocalStack. A latência ponta a ponta reflete o enfileiramento de 2.194 mensagens em 3s, não o tempo de processamento de cada uma.

## Limitações e próximos passos

- **Mesmo host para tudo:** gerador, aplicação, banco e broker na mesma máquina, com o banco, o broker e o IdP numa VM de 2 CPUs (2 GB e, depois, 10 GB). Aumentar a memória não mudou a vazão, porque o limite é CPU. Para números representativos, separar o gerador e dar mais **CPU** ao PostgreSQL.
- **OOM do LocalStack (VMs pequenas):** com a VM de 2 GB, o LocalStack foi morto por falta de memória em execuções seguidas, porque guardava as dezenas de milhares de eventos publicados que ninguém consumia. O script apaga suas filas ao final, mas o processo do LocalStack não devolve toda a memória; com o Keycloak também na VM, a segunda execução seguida ainda estourou. **Com 10 GB isso deixou de ocorrer:** duas execuções seguidas, com o LocalStack Pro chegando a cerca de 1,2 GB. A community 4.10, usada na configuração final, chegou a cerca de 550 MB. **Recomendação:** pelo menos 4 GB para a VM do Docker; com menos, reiniciar o LocalStack entre execuções (`docker compose restart localstack-aws && bun run sqs:setup`).
- **Pool e publishers:** cada laço de publicação segura uma conexão durante a ida ao SQS. Com o pool padrão de 10 conexões, aumentar `OUTBOX_PUBLISHER_CONCURRENCY` além de 4 tira conexões do HTTP e dos consumidores. Uma execução com 8 laços não foi medida de forma limpa, porque coincidiu com o OOM. Escalar a publicação pede um pool maior ou uma reserva com expiração (lease) fora da transação (ver `ARCHITECTURE.md`).
- **Tamanho do lote:** o `SendMessageBatch` do SQS limita cada lote a 10 mensagens, o que fixa o tamanho do lote da outbox.
- **Duração:** a janela de 30s mostra o regime, mas não efeitos de longo prazo (crescimento da outbox e da inbox, autovacuum).
