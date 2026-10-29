import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import {
  ConcurrentModificationError,
  WalletAlreadyExistsError,
} from '../../../application/errors';
import { WalletRepository } from '../../../application/ports/unit-of-work';
import { Wallet } from '../../../domain/wallet';
import { WalletEntity } from '../entities';
import { walletMapper } from '../mappers';

const INSERT_WALLET = `
  insert into wallet (id,
                      player_id,
                      currency,
                      balance,
                      version,
                      created_at,
                      updated_at)
  values (?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_WALLET_BY_ID = `
  select id,
         player_id,
         currency,
         balance,
         version,
         created_at,
         updated_at
    from wallet
   where id = ?
`;

const SELECT_WALLET_FOR_UPDATE = `${SELECT_WALLET_BY_ID} for update`;

const UPDATE_WALLET_BALANCE = `
  update wallet
     set balance = ?,
         version = ?,
         updated_at = ?
   where id = ?
     and version = ?
`;

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    const r = walletMapper.toRecord(wallet);
    try {
      await this.em.execute(INSERT_WALLET, [
        r.id,
        r.playerId,
        r.currency,
        r.balance,
        r.version,
        r.createdAt,
        r.updatedAt,
      ]);
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        (error as { constraint?: string }).constraint ===
          'wallet_player_currency_uq'
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  findById(id: string): Promise<Wallet | undefined> {
    return this.selectOne(SELECT_WALLET_BY_ID, id);
  }

  lockById(id: string): Promise<Wallet | undefined> {
    return this.selectOne(SELECT_WALLET_FOR_UPDATE, id);
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const r = walletMapper.toRecord(wallet);
    const { affectedRows } = await this.em.execute<{ affectedRows: number }>(
      UPDATE_WALLET_BALANCE,
      [r.balance, r.version, r.updatedAt, r.id, expectedVersion],
      'run',
    );
    if (affectedRows !== 1) {
      throw new ConcurrentModificationError(
        `Wallet ${wallet.id} mudou (version esperada ${expectedVersion})`,
      );
    }
  }

  private async selectOne(
    query: string,
    id: string,
  ): Promise<Wallet | undefined> {
    const [row] = await this.em.execute(query, [id]);
    return row
      ? walletMapper.toDomain(this.em.map(WalletEntity, row))
      : undefined;
  }
}
