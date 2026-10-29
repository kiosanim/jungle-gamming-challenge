import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { JsonLogger } from './json-logger';
import { RequestContext } from './request-context';

describe('JsonLogger', () => {
  let lines: string[];
  let stdout: ReturnType<typeof spyOn>;
  let stderr: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lines = [];
    const capture = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    stdout = spyOn(process.stdout, 'write').mockImplementation(capture);
    stderr = spyOn(process.stderr, 'write').mockImplementation(capture);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  const parsed = () => lines.map((line) => JSON.parse(line));

  it('escreve uma linha JSON com nível, contexto do Nest e campos', () => {
    new JsonLogger().log({ event: 'teste', status: 'PROCESSED' }, 'Contexto');

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(parsed()[0]).toMatchObject({
      level: 'log',
      context: 'Contexto',
      event: 'teste',
      status: 'PROCESSED',
      time: expect.any(String),
    });
  });

  it('inclui os identificadores do contexto corrente da requisição/mensagem', () => {
    RequestContext.run({ correlationId: 'corr-1', messageId: 'msg-1' }, () => {
      RequestContext.set({
        transactionId: 'tx-1',
        walletId: 'w-1',
        providerId: 'provider-a',
      });
      new JsonLogger().log({ event: 'wager_transaction' });
    });

    expect(parsed()[0]).toMatchObject({
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'w-1',
      providerId: 'provider-a',
    });
  });

  it('mascara payloads e valores financeiros completos', () => {
    new JsonLogger().log({
      event: 'x',
      payload: { a: 1 },
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      authorization: 'Bearer abc',
      failureCode: 'INSUFFICIENT_FUNDS',
    });

    const [line] = parsed();
    expect(line.payload).toBe('[redacted]');
    expect(line.money).toBe('[redacted]');
    expect(line.balanceAfter).toBe('[redacted]');
    expect(line.authorization).toBe('[redacted]');
    expect(line.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(lines[0]).not.toContain('25.00');
  });

  it('mensagens texto viram o campo message; erros vão para stderr com stack', () => {
    const logger = new JsonLogger();
    logger.warn('atenção', 'Ctx');
    logger.error('falhou', 'Error: x\n    at y', 'Ctx');

    const [warn, error] = parsed();
    expect(warn).toMatchObject({
      level: 'warn',
      message: 'atenção',
      context: 'Ctx',
    });
    expect(error).toMatchObject({
      level: 'error',
      message: 'falhou',
      stack: expect.stringContaining('Error: x'),
    });
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it('respeita o nível mínimo', () => {
    const logger = new JsonLogger('warn');
    logger.log('ignorado');
    logger.debug('ignorado');
    logger.warn('registrado');
    expect(parsed().map((l) => l.message)).toEqual(['registrado']);
  });
});
