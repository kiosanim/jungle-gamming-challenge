import { describe, expect, it } from 'bun:test';
import {
  FAILURE_CODE_CATEGORY,
  FailureCategory,
  FailureCode,
} from './failure-code';
import { Money } from './money';
import {
  CreateWagerTransactionProps,
  INTERNAL_PROVIDER_ID,
  PENDING_REFERENCE_BASE_DELAY_MS,
  PENDING_REFERENCE_MAX_DELAY_MS,
  PENDING_REFERENCE_TTL_MS,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';
import { LedgerDirection } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:01:00Z');
const BALANCE = brl('100.00');

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => {
  const externalTransactionId = overrides.externalTransactionId ?? 'ext-bet-1';
  return {
    id: `id-${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: `hash-${externalTransactionId}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: T0,
    ...overrides,
  };
};

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(overrides));

/** Cria uma transação que referencia `ext-bet-1` (ou outra referência informada). */
const referencing = (
  kind: Kind,
  overrides: Partial<CreateWagerTransactionProps> = {},
) =>
  WagerTransaction.create(
    props({
      externalTransactionId: `ext-${kind.toLowerCase()}-1`,
      kind,
      referenceExternalTransactionId: 'ext-bet-1',
      ...overrides,
    }),
  );

const processed = (
  transaction: WagerTransaction,
  reference?: WagerTransaction,
) => {
  transaction.markProcessed(reference?.id, T1, BALANCE);
  return transaction;
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('nasce PENDING, sem failureCode nem processedAt', () => {
      const tx = bet();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.failureCode).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.referenceTransactionId).toBeUndefined();
    });

    it.each([
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const)('rejeita %s vazio', (field) => {
      expect(() => bet({ [field]: '' })).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita OPENING (interno, nunca via API ou fila)', () => {
      expect(() => bet({ kind: Kind.Opening })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('rejeita kind desconhecido', () => {
      expect(() => bet({ kind: 'JACKPOT' as Kind })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([Kind.Refund, Kind.Rollback])(
      '%s sem referenceExternalTransactionId é rejeitado',
      (kind) => {
        expect(() => bet({ kind })).toThrow(InvalidWagerTransactionError);
        expect(() => bet({ kind, referenceExternalTransactionId: '' })).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it('BET não aceita referência', () => {
      expect(() =>
        bet({
          externalTransactionId: 'ext-bet-2',
          referenceExternalTransactionId: 'ext-bet-1',
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it.each([Kind.Win, Kind.Loss])('%s aceita referência opcional', (kind) => {
      expect(bet({ kind }).referenceExternalTransactionId).toBeUndefined();
      expect(referencing(kind).referenceExternalTransactionId).toBe(
        'ext-bet-1',
      );
    });

    it('rejeita autorreferência', () => {
      expect(() =>
        bet({
          kind: Kind.Refund,
          externalTransactionId: 'ext-x',
          referenceExternalTransactionId: 'ext-x',
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it.each([Kind.Bet, Kind.Win])('%s de valor zero é rejeitado', (kind) => {
      expect(() => bet({ kind, money: Money.zero('BRL') })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([Kind.Refund, Kind.Rollback])(
      '%s de valor zero é rejeitado',
      (kind) => {
        expect(() => referencing(kind, { money: Money.zero('BRL') })).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it('LOSS aceita valor zero', () => {
      expect(bet({ kind: Kind.Loss, money: Money.zero('BRL') }).status).toBe(
        Status.Pending,
      );
    });

    it('rejeita valor negativo', () => {
      expect(() =>
        bet({ kind: Kind.Loss, money: brl('1.00').negate() }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('opening', () => {
    it('cria transação interna OPENING já PROCESSED', () => {
      const tx = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        at: T0,
      });

      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.processedAt).toEqual(T0);
      expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
      expect(tx.externalTransactionId).toBe('opening:wallet-1');
      expect(tx.idempotencyKey).toBe('internal:opening:wallet-1');
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('rejeita crédito de abertura não positivo', () => {
      expect(() =>
        WagerTransaction.opening({
          id: 'tx-opening',
          walletId: 'wallet-1',
          playerId: 'player-1',
          money: Money.zero('BRL'),
          at: T0,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('transições', () => {
    it('PENDING → PROCESSED registra processedAt', () => {
      const tx = processed(bet());
      expect(tx.status).toBe(Status.Processed);
      expect(tx.processedAt).toEqual(T1);
      expect(tx.isTerminal()).toBe(true);
    });

    it('PROCESSED registra o id interno da referência', () => {
      const reference = processed(bet());
      const refund = processed(referencing(Kind.Refund), reference);
      expect(refund.referenceTransactionId).toBe(reference.id);
    });

    it('markProcessed sem a referência resolvida é erro de programação', () => {
      expect(() =>
        referencing(Kind.Refund).markProcessed(undefined, T1, BALANCE),
      ).toThrow(InvalidTransactionStateError);
    });

    it('markProcessed com referência em transação sem referência é erro', () => {
      expect(() => bet().markProcessed('id-qualquer', T1, BALANCE)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('PENDING → PENDING_REFERENCE → PROCESSED', () => {
      const reference = processed(bet());
      const rollback = referencing(Kind.Rollback);
      rollback.markPendingReference(T0);
      expect(rollback.status).toBe(Status.PendingReference);
      expect(rollback.isTerminal()).toBe(false);

      rollback.markProcessed(reference.id, T1, BALANCE);
      expect(rollback.status).toBe(Status.Processed);
    });

    it('PENDING_REFERENCE → REJECTED por referência inexistente', () => {
      const refund = referencing(Kind.Refund);
      refund.markPendingReference(T0);
      refund.reject(FailureCode.ReferenceNotFound);
      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    it('markPendingReference só é permitido a partir de PENDING', () => {
      const refund = referencing(Kind.Refund);
      refund.markPendingReference(T0);
      expect(() => refund.markPendingReference(T0)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('markPendingReference exige transação com referência', () => {
      expect(() => bet().markPendingReference(T0)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('reject registra o failureCode', () => {
      const tx = bet();
      tx.reject(FailureCode.InsufficientFunds);
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.isTerminal()).toBe(true);
    });

    it('fail registra o failureCode', () => {
      const tx = bet();
      tx.fail(FailureCode.ProcessingFailed);
      expect(tx.status).toBe(Status.Failed);
      expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
      expect(tx.isTerminal()).toBe(true);
    });

    it('reject não aceita código de falha de infraestrutura', () => {
      expect(() => bet().reject(FailureCode.ProcessingFailed)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('fail não aceita código de rejeição de negócio', () => {
      expect(() => bet().fail(FailureCode.InsufficientFunds)).toThrow(
        InvalidTransactionStateError,
      );
    });

    describe('estados terminais não transicionam', () => {
      const terminals: [string, () => WagerTransaction][] = [
        ['PROCESSED', () => processed(bet())],
        [
          'REJECTED',
          () => {
            const tx = bet();
            tx.reject(FailureCode.InsufficientFunds);
            return tx;
          },
        ],
        [
          'FAILED',
          () => {
            const tx = bet();
            tx.fail(FailureCode.ProcessingFailed);
            return tx;
          },
        ],
      ];
      const transitions: [string, (tx: WagerTransaction) => void][] = [
        ['markProcessed', (tx) => tx.markProcessed(undefined, T1, BALANCE)],
        ['markPendingReference', (tx) => tx.markPendingReference(T0)],
        ['reject', (tx) => tx.reject(FailureCode.InsufficientFunds)],
        ['fail', (tx) => tx.fail(FailureCode.ProcessingFailed)],
      ];

      for (const [statusName, build] of terminals) {
        for (const [transitionName, transition] of transitions) {
          it(`${statusName} → ${transitionName} lança InvalidTransactionStateError`, () => {
            const tx = build();
            const before = { status: tx.status, failureCode: tx.failureCode };
            expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
            expect({ status: tx.status, failureCode: tx.failureCode }).toEqual(
              before,
            );
          });
        }
      }
    });
  });

  describe('consultas', () => {
    it.each([
      [Kind.Bet, true],
      [Kind.Win, true],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('affectsBalance de %s é %s', (kind, expected) => {
      const tx =
        kind === Kind.Refund || kind === Kind.Rollback
          ? referencing(kind)
          : bet({ kind });
      expect(tx.affectsBalance()).toBe(expected);
    });

    it.each([
      [Kind.Bet, false],
      [Kind.Win, false],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('requiresReference de %s é %s', (kind, expected) => {
      const tx = expected ? referencing(kind) : bet({ kind });
      expect(tx.requiresReference()).toBe(expected);
    });

    it('matchesPayload: mesma key com payload diferente não é replay', () => {
      const tx = bet({ payloadHash: 'hash-original' });
      expect(tx.matchesPayload('hash-original')).toBe(true);
      expect(tx.matchesPayload('hash-divergente')).toBe(false);
    });
  });

  describe('ledgerDirectionFor', () => {
    it('BET debita', () => {
      expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    });

    it('WIN credita', () => {
      expect(bet({ kind: Kind.Win }).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
    });

    it('REFUND credita', () => {
      expect(referencing(Kind.Refund).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
    });

    it('LOSS não gera lançamento', () => {
      expect(() => bet({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('ROLLBACK de BET credita', () => {
      const reference = processed(bet());
      expect(referencing(Kind.Rollback).ledgerDirectionFor(reference)).toBe(
        LedgerDirection.Credit,
      );
    });

    it('ROLLBACK de WIN debita', () => {
      const win = processed(
        bet({ kind: Kind.Win, externalTransactionId: 'ext-win-1' }),
      );
      const rollback = referencing(Kind.Rollback, {
        externalTransactionId: 'ext-rollback-win',
        referenceExternalTransactionId: 'ext-win-1',
      });
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });

    it('ROLLBACK de REFUND debita', () => {
      const reference = processed(bet());
      const refund = processed(referencing(Kind.Refund), reference);
      const rollback = referencing(Kind.Rollback, {
        externalTransactionId: 'ext-rollback-refund',
        referenceExternalTransactionId: refund.externalTransactionId,
      });
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    });

    it('ROLLBACK sem referência válida não define direção', () => {
      expect(() => referencing(Kind.Rollback).ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() =>
        referencing(Kind.Rollback).ledgerDirectionFor(bet()),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('checkReference', () => {
    it('REFUND de BET PROCESSED com mesmo valor é aceito', () => {
      expect(
        referencing(Kind.Refund).checkReference(processed(bet())),
      ).toBeUndefined();
    });

    it.each([
      [Kind.Refund, Kind.Win, FailureCode.ReferenceKindNotAllowed],
      [Kind.Refund, Kind.Loss, FailureCode.ReferenceKindNotAllowed],
      [Kind.Rollback, Kind.Loss, FailureCode.ReferenceKindNotAllowed],
      [Kind.Rollback, Kind.Win, undefined],
      [Kind.Rollback, Kind.Bet, undefined],
      [Kind.Win, Kind.Win, FailureCode.ReferenceKindNotAllowed],
    ])('%s referenciando %s → %s', (kind, referenceKind, expected) => {
      const reference = processed(
        bet({ kind: referenceKind, externalTransactionId: 'ext-ref' }),
      );
      const tx = referencing(kind, {
        referenceExternalTransactionId: 'ext-ref',
      });
      expect(tx.checkReference(reference)).toBe(expected);
    });

    it('ROLLBACK de REFUND é aceito; ROLLBACK de ROLLBACK não', () => {
      const original = processed(bet());
      const refund = processed(referencing(Kind.Refund), original);
      const rollbackOfRefund = referencing(Kind.Rollback, {
        externalTransactionId: 'ext-rb-1',
        referenceExternalTransactionId: refund.externalTransactionId,
      });
      expect(rollbackOfRefund.checkReference(refund)).toBeUndefined();

      processed(rollbackOfRefund, refund);
      const rollbackOfRollback = referencing(Kind.Rollback, {
        externalTransactionId: 'ext-rb-2',
        referenceExternalTransactionId: 'ext-rb-1',
      });
      expect(rollbackOfRollback.checkReference(rollbackOfRefund)).toBe(
        FailureCode.ReferenceKindNotAllowed,
      );
    });

    it.each([
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['rodada', { roundId: 'round-2' }],
      [
        'provider',
        { providerId: 'provider-b', idempotencyKey: 'provider-b:ext-bet-1' },
      ],
      ['moeda', { money: usd('25.00') }],
    ])('referência de outro(a) %s → REFERENCE_MISMATCH', (_, overrides) => {
      const reference = processed(bet(overrides));
      expect(referencing(Kind.Refund).checkReference(reference)).toBe(
        FailureCode.ReferenceMismatch,
      );
    });

    it.each([
      ['PENDING', (tx: WagerTransaction) => tx],
      [
        'REJECTED',
        (tx: WagerTransaction) => {
          tx.reject(FailureCode.InsufficientFunds);
          return tx;
        },
      ],
      [
        'FAILED',
        (tx: WagerTransaction) => {
          tx.fail(FailureCode.ProcessingFailed);
          return tx;
        },
      ],
    ])('referência %s → REFERENCE_NOT_PROCESSED', (_, toStatus) => {
      const reference = toStatus(bet());
      expect(referencing(Kind.Refund).checkReference(reference)).toBe(
        FailureCode.ReferenceNotProcessed,
      );
    });

    it.each([Kind.Refund, Kind.Rollback])(
      '%s com valor diferente da referência → REVERSAL_AMOUNT_MISMATCH',
      (kind) => {
        const reference = processed(bet({ money: brl('25.00') }));
        const reversal = referencing(kind, { money: brl('24.99') });
        expect(reversal.checkReference(reference)).toBe(
          FailureCode.ReversalAmountMismatch,
        );
      },
    );

    it('WIN pode ter valor diferente da BET referenciada', () => {
      const reference = processed(bet({ money: brl('25.00') }));
      expect(
        referencing(Kind.Win, { money: brl('100.00') }).checkReference(
          reference,
        ),
      ).toBeUndefined();
    });

    it('referência que não corresponde ao referenceExternalTransactionId é erro de programação', () => {
      const other = processed(bet({ externalTransactionId: 'ext-outra' }));
      expect(() => referencing(Kind.Refund).checkReference(other)).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });

  describe('insufficientFundsCode', () => {
    it('BET sem saldo → INSUFFICIENT_FUNDS', () => {
      expect(bet().insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    });

    it.each([Kind.Refund, Kind.Rollback])(
      '%s que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (código distinto)',
      (kind) => {
        const code = referencing(kind).insufficientFundsCode();
        expect(code).toBe(FailureCode.ReversalInsufficientFunds);
        expect(code).not.toBe(FailureCode.InsufficientFunds);
      },
    );
  });

  describe('rehydrate', () => {
    it('reconstrói estado terminal sem revalidar transições', () => {
      const tx = WagerTransaction.rehydrate({
        ...props({
          kind: Kind.Refund,
          referenceExternalTransactionId: 'ext-bet-0',
        }),
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceNotFound,
      });
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(tx.isTerminal()).toBe(true);
    });

    it('reconstrói até estados que create rejeitaria (ex.: OPENING)', () => {
      const tx = WagerTransaction.rehydrate({
        ...props({ kind: Kind.Opening }),
        status: Status.Processed,
        processedAt: T0,
      });
      expect(tx.kind).toBe(Kind.Opening);
    });
  });
});

describe('FailureCode', () => {
  it('todo código tem categoria definida', () => {
    for (const code of Object.values(FailureCode)) {
      expect(Object.values(FailureCategory)).toContain(
        FAILURE_CODE_CATEGORY[code],
      );
    }
  });

  it('os valores são estáveis e legíveis por máquina (SCREAMING_SNAKE_CASE)', () => {
    for (const code of Object.values(FailureCode)) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });
});

describe('WagerTransaction.balanceAfter', () => {
  const brlLocal = (amount: string) => Money.from({ amount, currency: 'BRL' });
  const newBet = () =>
    WagerTransaction.create({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Bet,
      money: brlLocal('80.00'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

  it('markProcessed registra o saldo resultante', () => {
    const tx = newBet();
    tx.markProcessed(undefined, new Date(), brlLocal('20.00'));
    expect(tx.balanceAfter?.equals(brlLocal('20.00'))).toBe(true);
  });

  it('reject registra o saldo observado (inalterado)', () => {
    const tx = newBet();
    tx.reject(FailureCode.InsufficientFunds, brlLocal('20.00'));
    expect(tx.balanceAfter?.equals(brlLocal('20.00'))).toBe(true);
  });

  it('reject sem saldo deixa balanceAfter indefinido', () => {
    const tx = newBet();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.balanceAfter).toBeUndefined();
  });

  it('saldo negativo é erro de programação', () => {
    expect(() =>
      newBet().markProcessed(undefined, new Date(), brlLocal('1.00').negate()),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      newBet().reject(FailureCode.InsufficientFunds, brlLocal('1.00').negate()),
    ).toThrow(InvalidTransactionStateError);
  });

  it('opening registra o próprio crédito como saldo resultante', () => {
    const tx = WagerTransaction.opening({
      id: 'tx-o',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brlLocal('1000.00'),
      at: new Date(),
    });
    expect(tx.balanceAfter?.equals(brlLocal('1000.00'))).toBe(true);
  });
});

describe('WagerTransaction: espera por referência (PENDING_REFERENCE)', () => {
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const pendingRefund = () => {
    const tx = referencing(Kind.Refund);
    tx.markPendingReference(T0);
    return tx;
  };

  it('markPendingReference agenda a primeira verificação após o atraso base', () => {
    const tx = pendingRefund();
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceCheckAt).toEqual(
      at(PENDING_REFERENCE_BASE_DELAY_MS),
    );
  });

  it('scheduleReferenceRetry aplica backoff exponencial com teto', () => {
    const tx = pendingRefund();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      tx.scheduleReferenceRetry(T0);
      delays.push(tx.nextReferenceCheckAt!.getTime() - T0.getTime());
    }
    expect(tx.referenceAttempts).toBe(8);
    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60, 60].map((s) => s * 1_000));
    expect(Math.max(...delays)).toBe(PENDING_REFERENCE_MAX_DELAY_MS);
  });

  it('scheduleReferenceRetry só vale em PENDING_REFERENCE', () => {
    expect(() => referencing(Kind.Refund).scheduleReferenceRetry(T0)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('o TTL é contado a partir da criação', () => {
    const tx = pendingRefund();
    expect(tx.isReferenceWaitExpired(at(PENDING_REFERENCE_TTL_MS - 1))).toBe(
      false,
    );
    expect(tx.isReferenceWaitExpired(at(PENDING_REFERENCE_TTL_MS))).toBe(true);
  });

  it('resolver ou rejeitar limpa o agendamento', () => {
    const processed = pendingRefund();
    processed.markProcessed('id-bet', T1, BALANCE);
    expect(processed.nextReferenceCheckAt).toBeUndefined();

    const rejected = pendingRefund();
    rejected.reject(FailureCode.ReferenceNotFound, BALANCE);
    expect(rejected.nextReferenceCheckAt).toBeUndefined();
  });
});
