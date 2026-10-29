import { AsyncLocalStorage } from 'node:async_hooks';

/** Identificadores propagados para todos os logs de uma requisição/mensagem. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Contexto de log por unidade de trabalho (requisição HTTP, mensagem SQS),
 * propagado pelas chamadas assíncronas sem precisar ser passado adiante.
 */
export const RequestContext = {
  run<T>(context: LogContext, fn: () => T): T {
    return storage.run({ ...context }, fn);
  },

  get(): LogContext {
    return storage.getStore() ?? {};
  },

  /** Enriquece o contexto corrente (ex.: depois que a transação é criada). */
  set(fields: LogContext): void {
    const store = storage.getStore();
    if (store) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          store[key as keyof LogContext] = value;
        }
      }
    }
  },
};
