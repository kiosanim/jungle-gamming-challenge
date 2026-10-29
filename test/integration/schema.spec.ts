import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../../src/infrastructure/persistence/entities';
import { initTestOrm, sql } from '../support/database';

/**
 * Garantias de unicidade, imutabilidade e não negatividade aplicadas pelo
 * próprio schema do PostgreSQL, sem depender do código da aplicação.
 */

let orm: MikroORM;

beforeAll(async () => {
  orm = await initTestOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

const run = (query: string, params: unknown[] = []) => sql(orm, query, params);

/** Espera que o banco rejeite a operação citando a constraint/trigger. */
const expectViolation = (promise: Promise<unknown>, fragment: string) =>
  expect(promise).rejects.toThrow(fragment);

// ---- fixtures em SQL bruto (sem passar pelo domínio, de propósito)

async function insertWallet(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: randomUUID(),
    player_id: `player-${randomUUID()}`,
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    ...overrides,
  };
  await run(
    `insert into wallet (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [row.id, row.player_id, row.currency, row.balance, row.version],
  );
  return row;
}

async function insertTransaction(
  walletId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const external = `ext-${randomUUID()}`;
  const row = {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: 'hash',
    player_id: 'player-1',
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PENDING',
    failure_code: null,
    processed_at: null,
    balance_after: null,
    next_reference_check_at: null,
    ...overrides,
  };
  await run(
    `insert into wager_transaction
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, reference_transaction_id, status,
        failure_code, created_at, processed_at, balance_after, next_reference_check_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?, ?, ?)`,
    [
      row.id,
      row.provider_id,
      row.external_transaction_id,
      row.idempotency_key,
      row.payload_hash,
      walletId,
      row.player_id,
      row.round_id,
      row.game_id,
      row.kind,
      row.amount,
      row.currency,
      row.reference_external_transaction_id,
      row.reference_transaction_id,
      row.status,
      row.failure_code,
      row.processed_at,
      row.balance_after,
      row.next_reference_check_at,
    ],
  );
  return row;
}

const processedBet = (
  walletId: string,
  overrides: Record<string, unknown> = {},
) =>
  insertTransaction(walletId, {
    status: 'PROCESSED',
    processed_at: new Date(),
    balance_after: '100.00',
    ...overrides,
  });

/** Versões únicas por padrão; testes de sequência passam a sua. */
let nextWalletVersion = 1;

/**
 * Lançamento do extrato da wallet. A contrapartida (conta do provedor) é
 * criada no mesmo comando, como faz o repositório.
 */
async function insertLedgerEntry(
  walletId: string,
  transactionId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const row = {
    id: randomUUID(),
    direction: 'DEBIT',
    amount: '10.00',
    balance_before: '100.00',
    balance_after: '90.00',
    wallet_version: nextWalletVersion++,
    counter_account_id: 'provider:provider-a:BRL',
    ...overrides,
  };
  await run(
    `with counter_account as (
       insert into ledger_account (id, type, currency, provider_id, created_at)
       values ('provider:provider-a:BRL', 'PROVIDER', 'BRL', 'provider-a', now())
       on conflict (id) do nothing)
     insert into wallet_ledger_entry
       (id, wallet_id, transaction_id, direction, counter_account_id, amount,
        balance_before, balance_after, wallet_version, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      row.id,
      walletId,
      transactionId,
      row.direction,
      row.counter_account_id,
      row.amount,
      row.balance_before,
      row.balance_after,
      row.wallet_version,
    ],
  );
  return row;
}

describe('migrations', () => {
  it('o schema aplicado corresponde exatamente às entities (sem drift)', async () => {
    expect(await orm.schema.getUpdateSchemaSQL()).toBe('');
  });

  it('são reversíveis: down remove tudo e up recria', async () => {
    await orm.migrator.down({ to: 0 });
    const leftovers = await run(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
       union all
       select proname from pg_proc
        where pronamespace = 'public'::regnamespace and proname like '%_trg_fn'`,
    );
    expect(leftovers).toEqual([]);

    await orm.migrator.up();
    expect(await orm.schema.getUpdateSchemaSQL()).toBe('');
  });
});

describe('wallet', () => {
  it('saldo é numeric exato e hidratado como string decimal', async () => {
    const wallet = await insertWallet({ balance: '0.10' });
    await run('update wallet set balance = balance + ? where id = ?', [
      '0.20',
      wallet.id,
    ]);

    const entity = await orm.em
      .fork()
      .findOneOrFail(WalletEntity, { id: wallet.id });
    expect(entity.balance).toBe('0.30');
    expect(typeof entity.balance).toBe('string');
  });

  it('não aceita saldo negativo', async () => {
    await expectViolation(
      insertWallet({ balance: '-0.01' }),
      'wallet_balance_non_negative_ck',
    );
  });

  it('update que tornaria o saldo negativo é rejeitado', async () => {
    const wallet = await insertWallet({ balance: '10.00' });
    await expectViolation(
      run('update wallet set balance = balance - ? where id = ?', [
        '10.01',
        wallet.id,
      ]),
      'wallet_balance_non_negative_ck',
    );
  });

  it('no máximo uma wallet por player + moeda', async () => {
    const wallet = await insertWallet();
    await expectViolation(
      insertWallet({ player_id: wallet.player_id }),
      'wallet_player_currency_uq',
    );
    await insertWallet({ player_id: wallet.player_id, currency: 'USD' });
  });

  it('moeda fora do formato ISO-4217 é rejeitada', async () => {
    await expectViolation(
      insertWallet({ currency: 'brl' }),
      'wallet_currency_format_ck',
    );
  });

  it('version começa em 1', async () => {
    await expectViolation(
      insertWallet({ version: 0 }),
      'wallet_version_positive_ck',
    );
  });

  it('não pode ser excluída enquanto houver transações', async () => {
    const wallet = await insertWallet();
    await insertTransaction(wallet.id);
    await expectViolation(
      run('delete from wallet where id = ?', [wallet.id]),
      'wager_transaction_wallet_id_foreign',
    );
  });
});

describe('wager_transaction', () => {
  describe('idempotência', () => {
    it('(provider, externalTransactionId) é único', async () => {
      const wallet = await insertWallet();
      const tx = await insertTransaction(wallet.id);
      await expectViolation(
        insertTransaction(wallet.id, {
          external_transaction_id: tx.external_transaction_id,
        }),
        'wager_transaction_provider_external_uq',
      );
    });

    it('o mesmo externalTransactionId é aceito para outro provider', async () => {
      const wallet = await insertWallet();
      const tx = await insertTransaction(wallet.id);
      await insertTransaction(wallet.id, {
        provider_id: 'provider-b',
        external_transaction_id: tx.external_transaction_id,
      });
    });

    it('(provider, idempotencyKey) é único', async () => {
      const wallet = await insertWallet();
      const tx = await insertTransaction(wallet.id);
      await expectViolation(
        insertTransaction(wallet.id, { idempotency_key: tx.idempotency_key }),
        'wager_transaction_provider_idempotency_key_uq',
      );
    });
  });

  describe('coerência de kind, valor e referência', () => {
    it('kind desconhecido é rejeitado', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, { kind: 'JACKPOT' }),
        'wager_transaction_kind_check',
      );
    });

    it.each(['REFUND', 'ROLLBACK'])(
      '%s sem referência é rejeitado',
      async (kind) => {
        const wallet = await insertWallet();
        await expectViolation(
          insertTransaction(wallet.id, { kind }),
          'wager_transaction_reference_required_ck',
        );
      },
    );

    it.each(['BET', 'OPENING'])(
      '%s com referência é rejeitado',
      async (kind) => {
        const wallet = await insertWallet();
        await expectViolation(
          insertTransaction(wallet.id, {
            kind,
            reference_external_transaction_id: 'ext-x',
          }),
          'wager_transaction_reference_forbidden_ck',
        );
      },
    );

    it('valor zero só é aceito em LOSS', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, { amount: '0.00' }),
        'wager_transaction_amount_ck',
      );
      await insertTransaction(wallet.id, { kind: 'LOSS', amount: '0.00' });
    });

    it('valor negativo é rejeitado', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, { kind: 'LOSS', amount: '-1.00' }),
        'wager_transaction_amount_ck',
      );
    });
  });

  describe('coerência de status', () => {
    it('PROCESSED exige processed_at (e vice-versa)', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, {
          status: 'PROCESSED',
          balance_after: '1.00',
        }),
        'wager_transaction_processed_at_ck',
      );
      await expectViolation(
        insertTransaction(wallet.id, { processed_at: new Date() }),
        'wager_transaction_processed_at_ck',
      );
    });

    it('PROCESSED exige balance_after (saldo devolvido nos replays)', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        processedBet(wallet.id, { balance_after: null }),
        'wager_transaction_balance_after_ck',
      );
    });

    it('PENDING_REFERENCE exige next_reference_check_at', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, {
          kind: 'REFUND',
          reference_external_transaction_id: 'ext-futura',
          status: 'PENDING_REFERENCE',
        }),
        'wager_transaction_reference_schedule_ck',
      );
    });

    it('balance_after não pode ser negativo', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, {
          status: 'REJECTED',
          failure_code: 'INSUFFICIENT_FUNDS',
          balance_after: '-0.01',
        }),
        'wager_transaction_balance_after_ck',
      );
    });

    it('REJECTED/FAILED exigem failure_code e só eles o aceitam', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, { status: 'REJECTED' }),
        'wager_transaction_failure_code_ck',
      );
      await expectViolation(
        insertTransaction(wallet.id, { failure_code: 'INSUFFICIENT_FUNDS' }),
        'wager_transaction_failure_code_ck',
      );
      await insertTransaction(wallet.id, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      });
    });

    it('failure_code fora da taxonomia é rejeitado', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        insertTransaction(wallet.id, {
          status: 'REJECTED',
          failure_code: 'OOPS',
        }),
        'wager_transaction_failure_code_check',
      );
    });

    it('PROCESSED com referência externa exige a referência resolvida', async () => {
      const wallet = await insertWallet();
      await expectViolation(
        processedBet(wallet.id, {
          kind: 'REFUND',
          reference_external_transaction_id: 'ext-x',
        }),
        'wager_transaction_processed_reference_ck',
      );
    });

    it('referência resolvida só em transação PROCESSED', async () => {
      const wallet = await insertWallet();
      const bet = await processedBet(wallet.id);
      await expectViolation(
        insertTransaction(wallet.id, {
          kind: 'REFUND',
          reference_external_transaction_id: bet.external_transaction_id,
          reference_transaction_id: bet.id,
        }),
        'wager_transaction_resolved_reference_ck',
      );
    });
  });

  describe('reversão única', () => {
    it('a mesma BET não pode ser estornada duas vezes', async () => {
      const wallet = await insertWallet();
      const bet = await processedBet(wallet.id);
      const refund = {
        kind: 'REFUND',
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      };
      await processedBet(wallet.id, refund);
      await expectViolation(
        processedBet(wallet.id, refund),
        'wager_transaction_single_reversal_uq',
      );
    });

    it('REFUND e ROLLBACK da mesma BET também não coexistem', async () => {
      const wallet = await insertWallet();
      const bet = await processedBet(wallet.id);
      const reference = {
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      };
      await processedBet(wallet.id, { kind: 'REFUND', ...reference });
      await expectViolation(
        processedBet(wallet.id, { kind: 'ROLLBACK', ...reference }),
        'wager_transaction_single_reversal_uq',
      );
    });

    it('WIN referenciando a BET não conta como reversão', async () => {
      const wallet = await insertWallet();
      const bet = await processedBet(wallet.id);
      const reference = {
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      };
      await processedBet(wallet.id, { kind: 'WIN', ...reference });
      await processedBet(wallet.id, { kind: 'REFUND', ...reference });
    });

    it('reversões pendentes da mesma referência podem coexistir até serem resolvidas', async () => {
      const wallet = await insertWallet();
      const pending = {
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-futura',
      };
      await insertTransaction(wallet.id, {
        ...pending,
        status: 'PENDING_REFERENCE',
        next_reference_check_at: new Date(),
      });
      await insertTransaction(wallet.id, {
        ...pending,
        status: 'PENDING_REFERENCE',
        next_reference_check_at: new Date(),
      });
    });
  });

  describe('imutabilidade', () => {
    it('PENDING pode transicionar para PROCESSED', async () => {
      const wallet = await insertWallet();
      const tx = await insertTransaction(wallet.id);
      await run(
        "update wager_transaction set status = 'PROCESSED', processed_at = now(), balance_after = 90 where id = ?",
        [tx.id],
      );
    });

    it.each([
      [
        'PROCESSED',
        {
          status: 'PROCESSED',
          processed_at: new Date(),
          balance_after: '1.00',
        },
      ],
      ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }],
      ['FAILED', { status: 'FAILED', failure_code: 'PROCESSING_FAILED' }],
    ])('%s é terminal: nenhum update é aceito', async (_, overrides) => {
      const wallet = await insertWallet();
      const tx = await insertTransaction(wallet.id, overrides);
      await expectViolation(
        run(
          "update wager_transaction set status = 'PENDING', processed_at = null, failure_code = null where id = ?",
          [tx.id],
        ),
        'estado terminal',
      );
    });

    it.each([
      ['amount', "amount = '999.00'"],
      ['kind', "kind = 'WIN'"],
      ['round_id', "round_id = 'outra-rodada'"],
      ['payload_hash', "payload_hash = 'outro'"],
      ['idempotency_key', "idempotency_key = 'outra'"],
    ])(
      'campo de negócio %s é imutável mesmo em PENDING',
      async (_, assignment) => {
        const wallet = await insertWallet();
        const tx = await insertTransaction(wallet.id);
        await expectViolation(
          run(`update wager_transaction set ${assignment} where id = ?`, [
            tx.id,
          ]),
          'campos de negócio são imutáveis',
        );
      },
    );

    it('delete é proibido', async () => {
      const wallet = await insertWallet();
      const tx = await insertTransaction(wallet.id);
      await expectViolation(
        run('delete from wager_transaction where id = ?', [tx.id]),
        'delete proibido',
      );
    });
  });
});

describe('wallet_ledger_entry', () => {
  it('aceita lançamentos balanceados de débito e crédito', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    const win = await processedBet(wallet.id, { kind: 'WIN' });
    await insertLedgerEntry(wallet.id, bet.id);
    await insertLedgerEntry(wallet.id, win.id, {
      direction: 'CREDIT',
      amount: '5.00',
      balance_before: '90.00',
      balance_after: '95.00',
    });
  });

  it('rejeita lançamento desbalanceado', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, { balance_after: '90.01' }),
      'wallet_ledger_entry_balanced_ck',
    );
  });

  it('rejeita direção trocada', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, { direction: 'CREDIT' }),
      'wallet_ledger_entry_balanced_ck',
    );
  });

  it('rejeita saldo resultante negativo', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, {
        amount: '80.00',
        balance_before: '60.00',
        balance_after: '-20.00',
      }),
      'wallet_ledger_entry_balances_non_negative_ck',
    );
  });

  it('rejeita valor zero', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, {
        amount: '0.00',
        balance_after: '100.00',
      }),
      'wallet_ledger_entry_amount_positive_ck',
    );
  });

  it('no máximo um lançamento por transação por wallet', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await insertLedgerEntry(wallet.id, bet.id);
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, {
        balance_before: '90.00',
        balance_after: '80.00',
      }),
      'wallet_ledger_entry_transaction_wallet_uq',
    );
  });

  it('(wallet, wallet_version) é único: a sequência do ledger não se repete', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    const win = await processedBet(wallet.id, { kind: 'WIN' });
    await insertLedgerEntry(wallet.id, bet.id, { wallet_version: 2 });
    await expectViolation(
      insertLedgerEntry(wallet.id, win.id, {
        direction: 'CREDIT',
        balance_before: '90.00',
        balance_after: '100.00',
        wallet_version: 2,
      }),
      'wallet_ledger_entry_wallet_version_uq',
    );
  });

  it('exige wallet e transação existentes', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await expectViolation(
      insertLedgerEntry(randomUUID(), bet.id),
      'wallet_ledger_entry_wallet_id_foreign',
    );
    await expectViolation(
      insertLedgerEntry(wallet.id, randomUUID()),
      'wallet_ledger_entry_transaction_id_foreign',
    );
  });

  it('exige contrapartida existente (partida dobrada)', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, { counter_account_id: null }),
      'counter_account_id',
    );
    await expectViolation(
      insertLedgerEntry(wallet.id, bet.id, {
        counter_account_id: 'provider:inexistente:BRL',
      }),
      'wallet_ledger_entry_counter_account_id_foreign',
    );
  });

  describe('append-only', () => {
    it.each([
      ['UPDATE', "update wallet_ledger_entry set amount = '1.00' where id = ?"],
      ['DELETE', 'delete from wallet_ledger_entry where id = ?'],
    ])('%s é proibido', async (operation, statement) => {
      const wallet = await insertWallet();
      const bet = await processedBet(wallet.id);
      const entry = await insertLedgerEntry(wallet.id, bet.id);
      await expectViolation(
        run(statement, [entry.id]),
        `append-only: ${operation} proibido`,
      );
    });

    it('TRUNCATE é proibido', async () => {
      await expectViolation(
        run('truncate wallet_ledger_entry'),
        'append-only: TRUNCATE proibido',
      );
    });
  });
});

describe('ledger_account (contrapartidas)', () => {
  it('conta de provedor exige provider_id; aporte não aceita', async () => {
    await expectViolation(
      run(
        `insert into ledger_account (id, type, currency, provider_id, created_at)
         values (?, 'PROVIDER', 'BRL', null, now())`,
        [`provider:${randomUUID()}:BRL`],
      ),
      'ledger_account_provider_ck',
    );
    await expectViolation(
      run(
        `insert into ledger_account (id, type, currency, provider_id, created_at)
         values (?, 'FUNDING', 'BRL', 'provider-a', now())`,
        [`funding:${randomUUID()}`],
      ),
      'ledger_account_provider_ck',
    );
  });

  it('tipo fora da taxonomia é rejeitado', async () => {
    await expectViolation(
      run(
        `insert into ledger_account (id, type, currency, provider_id, created_at)
         values (?, 'WALLET', 'BRL', null, now())`,
        [`wallet:${randomUUID()}`],
      ),
      'ledger_account_type_check',
    );
  });

  it('é imutável: UPDATE e DELETE proibidos', async () => {
    const wallet = await insertWallet();
    const bet = await processedBet(wallet.id);
    await insertLedgerEntry(wallet.id, bet.id);
    await expectViolation(
      run(
        "update ledger_account set currency = 'USD' where id = 'provider:provider-a:BRL'",
      ),
      'ledger_account é imutável: UPDATE proibido',
    );
    await expectViolation(
      run("delete from ledger_account where id = 'provider:provider-a:BRL'"),
      'ledger_account é imutável: DELETE proibido',
    );
  });
});

describe('inbox_message', () => {
  const insertInbox = (consumer: string, messageId: string) =>
    run(
      `insert into inbox_message (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, 'hash', now())`,
      [consumer, messageId],
    );

  it('(consumer, messageId) é único — deduplicação persistente', async () => {
    const messageId = `msg-${randomUUID()}`;
    await insertInbox('wager-transactions', messageId);
    await expectViolation(
      insertInbox('wager-transactions', messageId),
      'inbox_message_pkey',
    );
  });

  it('a mesma mensagem pode ser registrada por outro consumidor', async () => {
    const messageId = `msg-${randomUUID()}`;
    await insertInbox('wager-transactions', messageId);
    await insertInbox('outro-consumidor', messageId);
  });
});

describe('outbox_message', () => {
  it('attempts não pode ser negativo', async () => {
    await expectViolation(
      run(
        `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts)
         values (?, 'wallet-1', 'WalletBalanceChanged', '{}', now(), -1)`,
        [randomUUID()],
      ),
      'outbox_message_attempts_non_negative_ck',
    );
  });

  it('id (eventId) é único', async () => {
    const id = randomUUID();
    const insert = () =>
      run(
        `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts)
         values (?, 'wallet-1', 'WalletBalanceChanged', '{}', now(), 0)`,
        [id],
      );
    await insert();
    await expectViolation(insert(), 'outbox_message_pkey');
  });
});
