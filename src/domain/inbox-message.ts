import { DomainError } from './domain-error';

/** Tentativa de marcar como processada uma mensagem que já foi processada. */
export class InboxMessageAlreadyProcessedError extends DomainError {
  override readonly name = 'InboxMessageAlreadyProcessedError';

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(
      `Mensagem ${messageId} já processada pelo consumidor ${consumerName}`,
    );
  }
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro de uma mensagem recebida por um consumidor. A deduplicação é por
 * `(consumerName, messageId)`, que é chave única no banco, e o registro é
 * gravado na mesma transação SQL do efeito financeiro.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  /** Reconstrói a partir da persistência, sem revalidar transições. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError(
        this.consumerName,
        this.messageId,
      );
    }
    this._processedAt = at;
  }
}
