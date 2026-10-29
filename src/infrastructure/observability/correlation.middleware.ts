import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../../application/ports/id-generator';
import { RequestContext } from './request-context';

const HEADER = 'x-correlation-id';
const MAX_LENGTH = 128;

/**
 * Garante um `correlationId` por requisição (aceita o do cliente, senão gera),
 * devolve-o no header de resposta, abre o contexto de log e registra o
 * access log (sem corpo nem query string).
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Http');

  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const received = req.headers[HEADER];
    const correlationId =
      typeof received === 'string' &&
      received !== '' &&
      received.length <= MAX_LENGTH
        ? received
        : this.ids.newId();
    req.headers[HEADER] = correlationId;
    res.setHeader(HEADER, correlationId);

    const startedAt = process.hrtime.bigint();
    RequestContext.run({ correlationId }, () => {
      res.on('finish', () => {
        this.logger.log({
          event: 'http_request',
          method: req.method,
          path: req.baseUrl + (req.route?.path ?? req.path),
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        });
      });
      next();
    });
  }
}
