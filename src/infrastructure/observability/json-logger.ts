import { LoggerService, LogLevel } from '@nestjs/common';
import { RequestContext } from './request-context';
import { activeTraceIds } from './tracing';

const LEVELS: LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/**
 * Campos nunca escritos em log: payloads e valores financeiros completos,
 * credenciais. Mantém-se apenas identificadores, status e códigos.
 */
const REDACTED_KEYS = new Set([
  'payload',
  'body',
  'data',
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'authorization',
  'password',
  'secret',
  'token',
]);

/**
 * Logger estruturado: uma linha JSON por evento, com o contexto corrente
 * (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`).
 * Nível mínimo por `LOG_LEVEL` (padrão `log`).
 */
export class JsonLogger implements LoggerService {
  private readonly minLevel: number;

  constructor(level = process.env.LOG_LEVEL ?? 'log') {
    const index = LEVELS.indexOf(level as LogLevel);
    this.minLevel = index === -1 ? LEVELS.indexOf('log') : index;
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('log', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('verbose', message, rest);
  }

  private write(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (LEVELS.indexOf(level) > this.minLevel) {
      return;
    }
    // Convenção do Nest: o último argumento string é o contexto; em `error`,
    // o penúltimo pode ser o stack.
    const params = [...rest];
    const context =
      typeof params[params.length - 1] === 'string'
        ? (params.pop() as string)
        : undefined;
    const stack =
      level === 'error' && typeof params[0] === 'string'
        ? params[0]
        : undefined;

    const fields =
      typeof message === 'object' && message !== null
        ? redact(message as Record<string, unknown>)
        : { message: String(message) };

    const line = {
      time: new Date().toISOString(),
      level,
      ...(context && { context }),
      ...RequestContext.get(),
      // Correlação log ↔ trace (só quando há um span amostrado ativo).
      ...activeTraceIds(),
      ...fields,
      ...(stack && { stack }),
    };
    const output =
      level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    output.write(`${JSON.stringify(line)}\n`);
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      REDACTED_KEYS.has(key) ? '[redacted]' : value,
    ]),
  );
}
