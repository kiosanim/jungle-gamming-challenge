import { InboxMessageEntity } from './inbox-message.entity';
import { LedgerAccountEntity } from './ledger-account.entity';
import { OutboxMessageEntity } from './outbox-message.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';
import { WalletEntity } from './wallet.entity';

export {
  InboxMessageEntity,
  LedgerAccountEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
};

export const ENTITIES = [
  WalletEntity,
  WagerTransactionEntity,
  WalletLedgerEntryEntity,
  LedgerAccountEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
];
