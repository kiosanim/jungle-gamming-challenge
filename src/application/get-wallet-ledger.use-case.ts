import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { InvalidPayloadError, WalletNotFoundError } from './errors';
import { isRecord } from './input-parsing';
import { UnitOfWork } from './ports/unit-of-work';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Cursor opaco da próxima página; `undefined` na última. */
  nextCursor?: string;
}

/**
 * Extrato paginado do ledger, mais recentes primeiro.
 *
 * O cursor é opaco para o cliente (base64url de `{ v: walletVersion }`) e
 * estável: a paginação é por `walletVersion` (sequência sem lacunas e
 * imutável), então lançamentos novos nunca deslocam as páginas seguintes.
 */
export class GetWalletLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  execute(
    walletId: string,
    cursor: string | undefined,
    limit = DEFAULT_LEDGER_PAGE_SIZE,
  ): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE_SIZE) {
      throw new InvalidPayloadError(
        `limit deve ser inteiro entre 1 e ${MAX_LEDGER_PAGE_SIZE}`,
      );
    }
    const beforeVersion = cursor ? decodeCursor(cursor) : undefined;

    return this.uow.run(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      // Um item a mais indica se há próxima página.
      const entries = await ctx.ledger.findPage(
        walletId,
        wallet.currency,
        beforeVersion,
        limit + 1,
      );
      const items = entries.slice(0, limit);
      const hasMore = entries.length > limit;
      return {
        items,
        ...(hasMore && {
          nextCursor: encodeCursor(items[items.length - 1].walletVersion),
        }),
      };
    });
  }
}

function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): number {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      isRecord(decoded) &&
      Number.isInteger(decoded.v) &&
      (decoded.v as number) >= 1
    ) {
      return decoded.v as number;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidPayloadError('cursor inválido');
}
