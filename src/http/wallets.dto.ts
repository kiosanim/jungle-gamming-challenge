import {
  DEFAULT_LEDGER_PAGE_SIZE,
  LedgerPage,
} from '../application/get-wallet-ledger.use-case';
import { ReconciliationReport } from '../application/reconcile-wallet.use-case';
import { InvalidMoneyError, Money, MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection } from '../domain/wallet-ledger-entry';
import { InvalidPayloadError } from './errors';
import { isRecord, parseUuid } from './parsing';

const MAX_ID_LENGTH = 128;

export interface OpenWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/** Valida o corpo de `POST /wallets` e converte para tipos de domínio. */
export function parseOpenWalletRequest(body: unknown): OpenWalletRequest {
  if (!isRecord(body)) {
    throw new InvalidPayloadError('corpo deve ser um objeto JSON');
  }

  const { playerId, initialBalance } = body;
  if (
    typeof playerId !== 'string' ||
    playerId.trim() === '' ||
    playerId.length > MAX_ID_LENGTH
  ) {
    throw new InvalidPayloadError(
      `playerId deve ser string não vazia com até ${MAX_ID_LENGTH} caracteres`,
    );
  }
  if (!isRecord(initialBalance)) {
    throw new InvalidPayloadError(
      'initialBalance deve ser { amount, currency }',
    );
  }

  try {
    return {
      playerId,
      initialBalance: Money.from(initialBalance as unknown as MoneyProps),
    };
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidPayloadError(`initialBalance: ${error.message}`);
    }
    throw error;
  }
}

export function parseWalletId(walletId: string): string {
  return parseUuid(walletId, 'walletId');
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  /** Contrapartida da partida dobrada; recebe a direção oposta. */
  counterAccount: string;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageResponse {
  items: LedgerEntryResponse[];
  /** `null` na última página. */
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** `?limit=` da query string; quando ausente, vale o padrão. */
export function parseLimit(limit: string | undefined): number {
  if (limit === undefined || limit === '') {
    return DEFAULT_LEDGER_PAGE_SIZE;
  }
  if (!/^\d+$/.test(limit)) {
    throw new InvalidPayloadError('limit deve ser inteiro positivo');
  }
  return Number(limit);
}

export function toLedgerPageResponse(page: LedgerPage): LedgerPageResponse {
  return {
    items: page.items.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      counterAccount: entry.counterAccount.id,
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor ?? null,
  };
}

export function toReconciliationResponse(
  report: ReconciliationReport,
): ReconciliationResponse {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
