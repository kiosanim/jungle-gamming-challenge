import { Money } from '../domain/money';
import { WalletNotFoundError } from './errors';
import { Metrics, NOOP_METRICS } from './ports/metrics';
import { UnitOfWork } from './ports/unit-of-work';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** `storedBalance − calculatedBalance` (zero quando consistente). */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger.
 *
 * É só leitura. Uma divergência **nunca** é corrigida aqui: ela é contada em
 * métrica, registrada em log (por quem chama) e sinalizada no relatório
 * (`consistent: false`) para alguém investigar.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.uow.run((ctx) =>
      ctx.ledger.reconciliationSnapshot(walletId),
    );
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }

    const calculatedBalance = snapshot.totalCredits.subtract(
      snapshot.totalDebits,
    );
    const difference = snapshot.storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    this.metrics.reconciliationChecked(consistent);

    return {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance,
      difference,
      consistent,
      checkedEntries: snapshot.entries,
    };
  }
}
