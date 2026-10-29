/**
 * Teste de carga: `bun run test:load`.
 *
 * Sobe N instâncias reais da aplicação contra um banco exclusivo
 * (`${DATABASE_NAME}_load`, recriado pelas migrations) e filas exclusivas,
 * aplica carga HTTP por tempo fixo e depois um lote via SQS, e gera um
 * relatório (Markdown + JSON em `load-test/reports/`).
 *
 * Parâmetros (variáveis de ambiente):
 *   LOAD_INSTANCES (3) · LOAD_CONCURRENCY (64) · LOAD_DURATION_SECONDS (30)
 *   LOAD_WARMUP_SECONDS (5) · LOAD_WALLETS (200) · LOAD_HOT_WALLETS (5)
 *   LOAD_HOT_SHARE (0.1) · LOAD_SQS_MESSAGES (2000) · LOAD_DATABASE_NAME (`${DATABASE_NAME}_load`)
 *   LOAD_AUTH (false): com `true`, liga a autenticação nas instâncias e usa
 *   tokens reais do Keycloak (client credentials). Precisa do Keycloak no ar
 *   (`docker compose up -d keycloak`); o emissor vem de LOAD_AUTH_ISSUER
 *   (padrão: AUTH_ISSUER ou http://localhost:8080/realms/wagering)
 *
 * Requer PostgreSQL e LocalStack no ar (`docker compose up -d postgres localstack-aws`).
 */
import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureQueues } from '../src/infrastructure/messaging/queues';
import { AppInstance, waitFor } from '../test/support/app-instance';
import { initTestOrm, sql, testDatabaseName } from '../test/support/database';
import { createSqsClient, deleteQueuesByName } from '../test/support/sqs';

// ---------------------------------------------------------------- configuração

const num = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);

const config = {
  instances: num('LOAD_INSTANCES', 3),
  concurrency: num('LOAD_CONCURRENCY', 64),
  durationSeconds: num('LOAD_DURATION_SECONDS', 30),
  warmupSeconds: num('LOAD_WARMUP_SECONDS', 5),
  wallets: num('LOAD_WALLETS', 200),
  hotWallets: num('LOAD_HOT_WALLETS', 5),
  sqsMessages: num('LOAD_SQS_MESSAGES', 2000),
  auth: process.env.LOAD_AUTH === 'true',
  /** Fração das operações dirigidas às hot wallets (contenção de lock). */
  hotShare: num('LOAD_HOT_SHARE', 0.1),
  replayShare: 0.05,
  refundShare: 0.05,
};

const AUTH_ISSUER =
  process.env.LOAD_AUTH_ISSUER ??
  process.env.AUTH_ISSUER ??
  'http://localhost:8080/realms/wagering';

/** Com autenticação, o provedor precisa ser um cliente do realm (`provider-a`). */
const PROVIDER_ID = config.auth ? 'provider-a' : 'provider-load';

/**
 * Tokens OAuth2 (client credentials) do Keycloak, renovados 60s antes de
 * expirar. Isso dá uma busca por cliente a cada ~4 min, então o IdP fica fora
 * do caminho quente: cada requisição só paga a verificação local da assinatura.
 */
class TokenSource {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async header(): Promise<Record<string, string>> {
    if (!config.auth) {
      return {};
    }
    return { Authorization: `Bearer ${await this.token()}` };
  }

  private token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) {
      return Promise.resolve(this.cached.token);
    }
    this.pending ??= fetch(`${AUTH_ISSUER}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`token ${this.clientId}: HTTP ${response.status}`);
        }
        const body = (await response.json()) as {
          access_token: string;
          expires_in: number;
        };
        this.cached = {
          token: body.access_token,
          expiresAt: Date.now() + body.expires_in * 1000,
        };
        return body.access_token;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

/** Credenciais de desenvolvimento do realm importado (keycloak/realm-wagering.json). */
const providerTokens = new TokenSource('provider-a', 'provider-a-dev-secret');
const operatorTokens = new TokenSource('backoffice', 'backoffice-dev-secret');

const suffix = randomUUID().slice(0, 8);
const QUEUES = {
  wagerTransactions: `load-wager-${suffix}.fifo`,
  wagerTransactionsDlq: `load-wager-dlq-${suffix}.fifo`,
  outbox: `load-events-${suffix}.fifo`,
};

// ------------------------------------------------------------------- utilidades

interface WalletRef {
  walletId: string;
  playerId: string;
  hot: boolean;
}

interface Operation {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

interface Sample {
  kind: string;
  replay: boolean;
  hot: boolean;
  status: number;
  ms: number;
}

/** Converte centavos inteiros em string decimal, sem passar por float. */
const amount = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const randomCents = (min: number, max: number) =>
  min + Math.floor(Math.random() * (max - min + 1));
const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function latencyStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1);
  return {
    count: sorted.length,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/** Soma todas as séries de uma métrica no formato de exposição Prometheus. */
function sumMetric(text: string, name: string): number {
  return text
    .split('\n')
    .filter(
      (line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `),
    )
    .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
}

function gauge(text: string, name: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ').pop()) : Number.NaN;
}

const fmt = (value: number, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

// ------------------------------------------------------------------- execução

async function main(): Promise<void> {
  // Banco exclusivo da carga (nunca o de desenvolvimento nem o de testes).
  process.env.TEST_DATABASE_NAME =
    process.env.LOAD_DATABASE_NAME ?? `${process.env.DATABASE_NAME}_load`;
  log(`Preparando banco ${testDatabaseName()} e filas…`);
  const orm = await initTestOrm();
  const sqs = createSqsClient();
  await ensureQueues(sqs, QUEUES);

  log(`Subindo ${config.instances} instâncias…`);
  const instances = await Promise.all(
    Array.from({ length: config.instances }, (_, i) => {
      const instance = new AppInstance(3201 + i, {
        DATABASE_NAME: testDatabaseName(),
        WAGER_TRANSACTIONS_QUEUE_NAME: QUEUES.wagerTransactions,
        WAGER_TRANSACTIONS_DLQ_NAME: QUEUES.wagerTransactionsDlq,
        OUTBOX_QUEUE_NAME: QUEUES.outbox,
        SQS_CONSUMER_CONCURRENCY: '4',
        LOG_LEVEL: 'error',
        ...(config.auth && {
          AUTH_ENABLED: 'true',
          AUTH_ISSUER,
          AUTH_JWKS_URL: `${AUTH_ISSUER}/protocol/openid-connect/certs`,
        }),
      });
      return instance.start().then(() => instance);
    }),
  );

  try {
    const environment = await describeEnvironment(orm);
    const wallets = await createWallets(instances);
    const http = await runHttpPhase(instances, wallets);
    const queue = await runSqsPhase(orm, sqs, wallets);
    const outbox = await drainOutbox(orm);
    const conflicts = await collectCounters(instances);
    const correctness = await checkCorrectness(orm);

    const report = {
      config,
      environment,
      http,
      queue,
      outbox,
      conflicts,
      correctness,
    };
    const markdown = renderReport(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync('load-test/reports', { recursive: true });
    writeFileSync(
      `load-test/reports/${stamp}.json`,
      JSON.stringify(report, null, 2),
    );
    writeFileSync(`load-test/reports/${stamp}.md`, markdown);
    console.log(`\n${markdown}`);
    log(`Relatório salvo em load-test/reports/${stamp}.{md,json}`);
    if (!correctness.consistent) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(instances.map((i) => i.stop()));
    // O LocalStack mantém as mensagens em memória (dezenas de milhares de
    // eventos por execução): sem remover as filas, uma VM pequena estoura.
    await deleteQueuesByName(sqs, Object.values(QUEUES));
    sqs.destroy();
    await orm.close(true);
  }
}

function log(message: string): void {
  console.log(`[load] ${message}`);
}

async function describeEnvironment(orm: MikroORM) {
  const [{ version }] = await sql(orm, 'select version()');
  const docker = Bun.spawnSync([
    'docker',
    'info',
    '--format',
    '{{.NCPU}} CPUs · {{.MemTotal}}',
  ]);
  const [dockerCpus, dockerMem] = docker.success
    ? docker.stdout.toString().trim().split(' · ')
    : ['?', '0'];
  return {
    dockerVm: `${dockerCpus} · ${Math.round(Number(dockerMem) / 1024 ** 3)} GB (compartilhados por PostgreSQL e LocalStack)`,
    os: `${platform()} ${release()} (${arch()})`,
    cpu: `${cpus()[0]?.model ?? 'desconhecida'} × ${cpus().length}`,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    bun: Bun.version,
    postgres: String(version).split(' on ')[0],
    sqs: 'localstack/localstack:4.10 (community, Docker)',
    topology:
      `${config.instances} instâncias da aplicação (processos Bun no host), ` +
      'PostgreSQL e LocalStack em Docker na mesma máquina',
  };
}

async function createWallets(instances: AppInstance[]): Promise<WalletRef[]> {
  log(`Criando ${config.wallets} wallets + ${config.hotWallets} hot wallets…`);
  const create = async (hot: boolean, index: number) => {
    const playerId = `load-player-${randomUUID()}`;
    const response = await fetch(
      `${instances[index % instances.length].url}/wallets`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await operatorTokens.header()),
        },
        body: JSON.stringify({
          playerId,
          // hot wallets com saldo baixo: provocam rejeições por saldo insuficiente
          initialBalance: {
            amount: hot ? '500.00' : '1000000.00',
            currency: 'BRL',
          },
        }),
      },
    );
    const body = (await response.json()) as { id: string };
    return { walletId: body.id, playerId, hot };
  };
  return Promise.all([
    ...Array.from({ length: config.wallets }, (_, i) => create(false, i)),
    ...Array.from({ length: config.hotWallets }, (_, i) => create(true, i)),
  ]);
}

function newOperation(wallet: WalletRef, kind: string): Operation {
  const externalTransactionId = `load-${randomUUID()}`;
  const cents =
    kind === 'LOSS'
      ? 0
      : kind === 'WIN'
        ? randomCents(100, 8000)
        : randomCents(100, 5000);
  return {
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `round-${randomUUID().slice(0, 8)}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount: amount(cents), currency: 'BRL' },
  };
}

async function runHttpPhase(instances: AppInstance[], wallets: WalletRef[]) {
  const normal = wallets.filter((w) => !w.hot);
  const hot = wallets.filter((w) => w.hot);
  const samples: Sample[] = [];
  const lagSamples: number[] = [];
  let rr = 0;
  let measuring = false;

  const send = async (op: Operation): Promise<number> => {
    const instance = instances[rr++ % instances.length];
    try {
      const response = await fetch(`${instance.url}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': op.idempotencyKey,
          ...(await providerTokens.header()),
        },
        body: JSON.stringify(op),
      });
      await response.arrayBuffer();
      return response.status;
    } catch {
      return 0; // erro de rede
    }
  };

  const virtualUser = async (deadline: number) => {
    const myBets: { op: Operation; wallet: WalletRef }[] = [];
    let last: { op: Operation; hot: boolean } | undefined;
    while (performance.now() < deadline) {
      const roll = Math.random();
      let op: Operation;
      let replay = false;
      let isHot = false;
      if (last && roll < config.replayShare) {
        op = last.op;
        replay = true;
        isHot = last.hot;
      } else if (
        myBets.length > 0 &&
        roll < config.replayShare + config.refundShare
      ) {
        const { op: bet, wallet } = myBets.splice(
          Math.floor(Math.random() * myBets.length),
          1,
        )[0];
        op = {
          ...newOperation(wallet, 'REFUND'),
          roundId: bet.roundId,
          money: bet.money,
          referenceExternalTransactionId: bet.externalTransactionId,
        };
        isHot = wallet.hot;
      } else {
        isHot = Math.random() < config.hotShare;
        const wallet = pick(isHot ? hot : normal);
        const kindRoll = Math.random();
        const kind = kindRoll < 0.7 ? 'BET' : kindRoll < 0.9 ? 'WIN' : 'LOSS';
        op = newOperation(wallet, kind);
      }

      const startedAt = performance.now();
      const status = await send(op);
      const ms = performance.now() - startedAt;
      if (measuring) {
        samples.push({ kind: op.kind, replay, hot: isHot, status, ms });
      }
      // BETs processadas podem ser estornadas depois por este usuário
      if (!replay && op.kind === 'BET' && status === 201) {
        const wallet = wallets.find((w) => w.walletId === op.walletId)!;
        myBets.push({ op, wallet });
      }
      last = { op, hot: isHot };
    }
  };

  const sampler = setInterval(async () => {
    const text = await fetch(`${instances[0].url}/metrics`)
      .then((r) => r.text())
      .catch(() => '');
    const lag = gauge(text, 'wagering_outbox_lag_seconds');
    if (measuring && Number.isFinite(lag)) {
      lagSamples.push(lag);
    }
  }, 1000);

  log(`Fase HTTP: aquecimento de ${config.warmupSeconds}s…`);
  const warmupEnd = performance.now() + config.warmupSeconds * 1000;
  await Promise.all(
    Array.from({ length: config.concurrency }, () => virtualUser(warmupEnd)),
  );

  log(
    `Fase HTTP: ${config.concurrency} usuários virtuais por ${config.durationSeconds}s…`,
  );
  measuring = true;
  const startedAt = performance.now();
  const deadline = startedAt + config.durationSeconds * 1000;
  await Promise.all(
    Array.from({ length: config.concurrency }, () => virtualUser(deadline)),
  );
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  measuring = false;
  clearInterval(sampler);

  const errors = samples.filter((s) => s.status === 0 || s.status >= 500);
  const byStatus = Object.fromEntries(
    [...new Set(samples.map((s) => s.status))]
      .sort()
      .map((status) => [
        String(status),
        samples.filter((s) => s.status === status).length,
      ]),
  );
  const group = (filter: (s: Sample) => boolean) =>
    latencyStats(samples.filter(filter).map((s) => s.ms));

  return {
    requests: samples.length,
    elapsedSeconds,
    throughputRps: samples.length / elapsedSeconds,
    errorRate: errors.length / (samples.length || 1),
    unavailable503: samples.filter((s) => s.status === 503).length,
    byStatus,
    latencyMs: {
      all: group(() => true),
      bet: group((s) => s.kind === 'BET' && !s.replay),
      win: group((s) => s.kind === 'WIN' && !s.replay),
      loss: group((s) => s.kind === 'LOSS' && !s.replay),
      refund: group((s) => s.kind === 'REFUND' && !s.replay),
      replay: group((s) => s.replay),
      hotWallets: group((s) => s.hot && !s.replay),
      normalWallets: group((s) => !s.hot && !s.replay),
    },
    outboxLagSampledSeconds: {
      samples: lagSamples.length,
      max: Math.max(...lagSamples, 0),
      mean: lagSamples.reduce((a, b) => a + b, 0) / (lagSamples.length || 1),
    },
  };
}

async function runSqsPhase(
  orm: MikroORM,
  sqs: SQSClient,
  wallets: WalletRef[],
) {
  const normal = wallets.filter((w) => !w.hot);
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: QUEUES.wagerTransactions }),
  );
  log(`Fase SQS: ${config.sqsMessages} mensagens (+10% reentregas)…`);

  const messages = Array.from({ length: config.sqsMessages }, () => {
    const wallet = pick(normal);
    const op = newOperation(wallet, Math.random() < 0.8 ? 'BET' : 'WIN');
    return { messageId: `load-msg-${randomUUID()}`, op };
  });
  const duplicates = messages.filter(() => Math.random() < 0.1);
  const deliveries = [...messages, ...duplicates];
  const sentAt = new Map<string, number>();

  const startedAt = Date.now();
  const batches: (typeof deliveries)[] = [];
  for (let i = 0; i < deliveries.length; i += 10) {
    batches.push(deliveries.slice(i, i + 10));
  }
  for (let i = 0; i < batches.length; i += 20) {
    await Promise.all(
      batches.slice(i, i + 20).map(async (batch) => {
        const now = Date.now();
        for (const { messageId } of batch) {
          if (!sentAt.has(messageId)) {
            sentAt.set(messageId, now);
          }
        }
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl,
            Entries: batch.map(({ messageId, op }, index) => ({
              Id: String(index),
              MessageGroupId: op.walletId,
              MessageDeduplicationId: randomUUID(),
              MessageBody: JSON.stringify({
                messageId,
                type: 'WagerTransactionRequested',
                occurredAt: new Date(now).toISOString(),
                data: op,
              }),
            })),
          }),
        );
      }),
    );
  }
  const enqueueSeconds = (Date.now() - startedAt) / 1000;

  const ids = messages.map((m) => m.messageId);
  const processedCount = async () =>
    Number(
      (
        await sql(
          orm,
          `select count(*) as n from inbox_message
            where consumer_name = 'wager-transactions' and processed_at is not null
              and message_id like 'load-msg-%'`,
        )
      )[0].n,
    );
  await waitFor(
    async () => (await processedCount()) >= ids.length,
    300_000,
    250,
  );

  const rows = await sql<{ message_id: string; processed_at: Date }>(
    orm,
    `select message_id, processed_at from inbox_message
      where consumer_name = 'wager-transactions' and message_id like 'load-msg-%'`,
  );
  const latencies = rows.map(
    (r) => new Date(r.processed_at).getTime() - sentAt.get(r.message_id)!,
  );
  const lastProcessed = Math.max(
    ...rows.map((r) => new Date(r.processed_at).getTime()),
  );
  const elapsedSeconds = (lastProcessed - startedAt) / 1000;

  return {
    uniqueMessages: ids.length,
    redeliveries: duplicates.length,
    enqueueSeconds,
    elapsedSeconds,
    throughputMessagesPerSecond: ids.length / elapsedSeconds,
    endToEndLatencyMs: latencyStats(latencies),
    inboxRows: rows.length,
  };
}

async function drainOutbox(orm: MikroORM) {
  log('Aguardando a outbox drenar…');
  const startedAt = Date.now();
  await waitFor(
    async () =>
      Number(
        (
          await sql(
            orm,
            'select count(*) as n from outbox_message where published_at is null',
          )
        )[0].n,
      ) === 0,
    300_000,
    250,
  );
  const [stats] = await sql(
    orm,
    `select count(*)::int as events,
            percentile_cont(0.5) within group (order by lag) as p50,
            percentile_cont(0.95) within group (order by lag) as p95,
            percentile_cont(0.99) within group (order by lag) as p99,
            max(lag) as max
       from (select extract(epoch from published_at - occurred_at) * 1000 as lag
               from outbox_message) l`,
  );
  return {
    events: Number(stats.events),
    drainAfterLoadSeconds: (Date.now() - startedAt) / 1000,
    publishLagMs: {
      p50: Number(stats.p50),
      p95: Number(stats.p95),
      p99: Number(stats.p99),
      max: Number(stats.max),
    },
  };
}

async function collectCounters(instances: AppInstance[]) {
  const texts = await Promise.all(
    instances.map((i) => fetch(`${i.url}/metrics`).then((r) => r.text())),
  );
  const total = (name: string) =>
    texts.reduce((sum, t) => sum + sumMetric(t, name), 0);
  const byReason: Record<string, number> = {};
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const match =
        /^wagering_concurrency_conflicts_total\{reason="([^"]+)"\} (\S+)/.exec(
          line,
        );
      if (match) {
        byReason[match[1]] = (byReason[match[1]] ?? 0) + Number(match[2]);
      }
    }
  }
  return {
    concurrencyConflicts: total('wagering_concurrency_conflicts_total'),
    concurrencyConflictsByReason: byReason,
    sqsRetries: sumMetric(texts.join('\n'), 'wagering_message_retries_total'),
    deadLetters: total('wagering_dead_letters_total'),
    duplicatesDetected: total('wagering_duplicates_total'),
  };
}

async function checkCorrectness(orm: MikroORM) {
  const [row] = await sql(
    orm,
    `select count(*)::int as wallets,
            count(*) filter (where w.balance <> coalesce(l.calculated, 0))::int as divergent,
            count(*) filter (where w.version <> coalesce(l.max_version, 1))::int as version_gaps,
            count(*) filter (where w.balance < 0)::int as negative
       from wallet w
       left join (select wallet_id,
                         sum(case direction when 'CREDIT' then amount else -amount end) as calculated,
                         max(wallet_version) as max_version
                    from wallet_ledger_entry group by wallet_id) l on l.wallet_id = w.id`,
  );
  // Partidas dobradas: toda contrapartida na moeda da wallet, e o balancete
  // (Σ saldos materializados das wallets + Σ contas de sistema) zerado.
  const [doubleEntry] = await sql(
    orm,
    `select (select count(*)::int
               from wallet_ledger_entry l
               join wallet w on w.id = l.wallet_id
               join ledger_account a on a.id = l.counter_account_id
              where a.currency <> w.currency) as currency_mismatch,
            ((select coalesce(sum(balance), 0) from wallet)
             + (select coalesce(sum(case direction when 'DEBIT' then amount else -amount end), 0)
                  from wallet_ledger_entry))::numeric(20,2)::text as trial_balance`,
  );
  const [tx] = await sql(
    orm,
    `select count(*)::int as transactions,
            count(*) filter (where status = 'PROCESSED')::int as processed,
            count(*) filter (where status = 'REJECTED')::int as rejected,
            count(*) filter (where status = 'PENDING_REFERENCE')::int as pending
       from wager_transaction where kind <> 'OPENING'`,
  );
  return {
    wallets: row.wallets,
    divergentWallets: row.divergent,
    versionGaps: row.version_gaps,
    negativeBalances: row.negative,
    counterCurrencyMismatch: doubleEntry.currency_mismatch,
    trialBalance: doubleEntry.trial_balance as string,
    transactions: tx.transactions,
    processed: tx.processed,
    rejected: tx.rejected,
    pendingReference: tx.pending,
    consistent:
      row.divergent === 0 &&
      row.version_gaps === 0 &&
      row.negative === 0 &&
      doubleEntry.currency_mismatch === 0 &&
      doubleEntry.trial_balance === '0.00',
  };
}

// -------------------------------------------------------------------- relatório

type Report = {
  config: typeof config;
  environment: Awaited<ReturnType<typeof describeEnvironment>>;
  http: Awaited<ReturnType<typeof runHttpPhase>>;
  queue: Awaited<ReturnType<typeof runSqsPhase>>;
  outbox: Awaited<ReturnType<typeof drainOutbox>>;
  conflicts: Awaited<ReturnType<typeof collectCounters>>;
  correctness: Awaited<ReturnType<typeof checkCorrectness>>;
};

function renderReport(r: Report): string {
  const row = (label: string, s: ReturnType<typeof latencyStats>) =>
    `| ${label} | ${s.count} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} |`;
  const l = r.http.latencyMs;
  return `# Relatório de carga — ${new Date().toISOString()}

## Ambiente

| | |
|---|---|
| SO | ${r.environment.os} |
| CPU | ${r.environment.cpu} |
| Memória | ${r.environment.memoryGb} GB |
| VM do Docker | ${r.environment.dockerVm} |
| Bun | ${r.environment.bun} |
| PostgreSQL | ${r.environment.postgres} |
| SQS | ${r.environment.sqs} |
| Topologia | ${r.environment.topology} |

Parâmetros: ${r.config.instances} instâncias · ${r.config.concurrency} usuários virtuais · ${r.config.durationSeconds}s medidos (+${r.config.warmupSeconds}s de aquecimento) · ${r.config.wallets} wallets + ${r.config.hotWallets} hot wallets (${r.config.hotShare * 100}% do tráfego) · ${r.config.sqsMessages} mensagens SQS · autenticação ${r.config.auth ? '**ligada** (tokens do Keycloak, RS256 validado pelo JWKS)' : 'desligada'}.

## HTTP — \`POST /wagering/transactions\`

| Métrica | Valor |
|---|---|
| Requisições medidas | ${r.http.requests} |
| Throughput | **${fmt(r.http.throughputRps)} req/s** |
| Taxa de erro (rede + 5xx) | **${fmt(r.http.errorRate * 100, 3)}%** |
| 503 (falha transitória) | ${r.http.unavailable503} |
| Status | ${Object.entries(r.http.byStatus)
    .map(([s, n]) => `${s}: ${n}`)
    .join(' · ')} |

Latência (ms):

| Operação | n | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
${row('todas', l.all)}
${row('BET', l.bet)}
${row('WIN', l.win)}
${row('LOSS', l.loss)}
${row('REFUND', l.refund)}
${row('replay idempotente', l.replay)}
${row('hot wallets', l.hotWallets)}
${row('wallets comuns', l.normalWallets)}

## SQS — \`wager-transactions.fifo\`

| Métrica | Valor |
|---|---|
| Mensagens únicas | ${r.queue.uniqueMessages} (+${r.queue.redeliveries} reentregas) |
| Tempo de enfileiramento | ${fmt(r.queue.enqueueSeconds, 2)} s |
| Throughput do consumidor | **${fmt(r.queue.throughputMessagesPerSecond)} msg/s** |
| Latência ponta a ponta (envio → commit) | p50 ${fmt(r.queue.endToEndLatencyMs.p50)} · p95 ${fmt(r.queue.endToEndLatencyMs.p95)} · p99 ${fmt(r.queue.endToEndLatencyMs.p99)} · máx ${fmt(r.queue.endToEndLatencyMs.max)} ms |
| Linhas na inbox | ${r.queue.inboxRows} (reentregas deduplicadas) |

## Outbox

| Métrica | Valor |
|---|---|
| Eventos publicados | ${r.outbox.events} |
| Lag de publicação (ocorrência → publicação) | p50 ${fmt(r.outbox.publishLagMs.p50)} · p95 ${fmt(r.outbox.publishLagMs.p95)} · p99 ${fmt(r.outbox.publishLagMs.p99)} · máx ${fmt(r.outbox.publishLagMs.max)} ms |
| Lag amostrado durante a carga HTTP (idade do mais antigo pendente) | máx ${fmt(r.http.outboxLagSampledSeconds.max, 3)} s · médio ${fmt(r.http.outboxLagSampledSeconds.mean, 3)} s |
| Drenagem após o fim da carga | ${fmt(r.outbox.drainAfterLoadSeconds, 2)} s |

## Concorrência

| Métrica | Valor |
|---|---|
| Conflitos de concorrência (métrica, 3 instâncias) | ${r.conflicts.concurrencyConflicts} ${
    Object.keys(r.conflicts.concurrencyConflictsByReason).length
      ? `(${Object.entries(r.conflicts.concurrencyConflictsByReason)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')})`
      : ''
  } |
| Duplicatas detectadas (replay + inbox) | ${r.conflicts.duplicatesDetected} |
| Retentativas (SQS + outbox) | ${r.conflicts.sqsRetries} |
| Mensagens na DLQ | ${r.conflicts.deadLetters} |

## Correção após a carga

| Verificação | Resultado |
|---|---|
| Wallets verificadas | ${r.correctness.wallets} |
| Saldo ≠ ledger | ${r.correctness.divergentWallets} |
| Lacunas na sequência do ledger | ${r.correctness.versionGaps} |
| Saldos negativos | ${r.correctness.negativeBalances} |
| Contrapartida em moeda ≠ da wallet | ${r.correctness.counterCurrencyMismatch} |
| Balancete (Σ wallets materializado + Σ contas de sistema) | ${r.correctness.trialBalance} |
| Transações (processadas / rejeitadas / pendentes) | ${r.correctness.transactions} (${r.correctness.processed} / ${r.correctness.rejected} / ${r.correctness.pendingReference}) |
| **Consistente** | **${r.correctness.consistent ? 'sim' : 'NÃO'}** |
`;
}

void main();
