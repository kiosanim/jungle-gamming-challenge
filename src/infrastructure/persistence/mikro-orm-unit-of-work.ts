import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../application/ports/unit-of-work';
import { hasActiveSpan, SpanKind, withSpan } from '../observability/tracing';
import { SqlInboxRepository } from './repositories/inbox.repository';
import { SqlLedgerRepository } from './repositories/ledger.repository';
import { SqlOutboxRepository } from './repositories/outbox.repository';
import { SqlWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { SqlWalletRepository } from './repositories/wallet.repository';

/**
 * Espera máxima por um lock de linha. Se estourar, vira
 * `LockWaitTimeoutException`, tratada como falha transitória (503 ou retry),
 * em vez de deixar conexões do pool presas indefinidamente atrás de uma
 * wallet muito disputada.
 */
const LOCK_TIMEOUT = process.env.LOCK_TIMEOUT || '5s';

const DB_ATTRIBUTES = {
  'wagering.layer': 'persistence',
  'db.system.name': 'postgresql',
};
const MAX_QUERY_TEXT = 2_000;

/**
 * Nome curto do span, como `select wallet`, `insert wallet_ledger_entry` ou
 * `set`. Numa CTE (`with … insert …`), vale a instrução principal, que é a
 * última.
 */
function querySummary(query: string): string {
  const verb = query.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? 'query';
  if (verb === 'with') {
    const writes = [
      ...query.matchAll(
        /\b(insert\s+into|update|delete\s+from)\s+"?([a-z_]+)/gi,
      ),
    ];
    const main = writes.at(-1);
    if (main) {
      return `${main[1].split(/\s+/)[0].toLowerCase()} ${main[2]}`;
    }
  }
  const table = /\b(?:from|into|update)\s+"?([a-z_]+)/i.exec(query)?.[1];
  return table ? `${verb} ${table}` : verb;
}

/**
 * `em.execute` com um span por instrução, quando há um trace ativo. O texto
 * do SQL vai sem parâmetros (só placeholders `?`): valores financeiros e
 * identificadores não entram no trace.
 */
function tracedEntityManager(em: EntityManager): EntityManager {
  // Repasse literal dos argumentos: `execute` tem sobrecargas.
  const original = em.execute.bind(em) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const execute = (...args: unknown[]) => {
    const [query] = args;
    if (!hasActiveSpan() || typeof query !== 'string') {
      return original(...args);
    }
    return withSpan(
      querySummary(query),
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...DB_ATTRIBUTES,
          'db.query.text': query
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_QUERY_TEXT),
        },
      },
      () => original(...args),
    );
  };
  return new Proxy(em, {
    get(target, property) {
      if (property === 'execute') {
        return execute;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Transação SQL gerenciada pelo MikroORM (`em.transactional`, isolamento
 * READ COMMITTED). Os repositórios executam SQL bruto via `em.execute`, que
 * participa da transação corrente; leituras são hidratadas nas entities com
 * `em.map` (conversão de tipos pelos metadados dos decorators). O Unit of
 * Work / flush automático do MikroORM não é usado: toda escrita é explícita.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    if (!hasActiveSpan()) {
      return this.transaction(work);
    }
    return withSpan(
      'db.transaction',
      { kind: SpanKind.CLIENT, attributes: DB_ATTRIBUTES },
      () => this.transaction(work),
    );
  }

  private transaction<T>(
    work: (ctx: TransactionalContext) => Promise<T>,
  ): Promise<T> {
    return this.orm.em.fork().transactional(async (transactionEm) => {
      // Sempre o EntityManager rastreado: ele decide a cada instrução se há
      // trace ativo, então também pega spans abertos no meio da transação
      // (como a publicação da outbox, depois da reserva do lote).
      const em = tracedEntityManager(transactionEm);
      await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`, [], 'run');
      return work({
        wallets: new SqlWalletRepository(em),
        transactions: new SqlWagerTransactionRepository(em),
        ledger: new SqlLedgerRepository(em),
        inbox: new SqlInboxRepository(em),
        outbox: new SqlOutboxRepository(em),
      });
    });
  }
}
