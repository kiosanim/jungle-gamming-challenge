import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import type { Response } from 'express';
import {
  ApplicationError,
  ConcurrentModificationError,
  IdempotencyConflictError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/errors';
import { CurrencyMismatchError, InvalidMoneyError } from '../domain/money';
import { InvalidWagerTransactionError } from '../domain/wager-transaction';
import { InvalidWalletOperationError } from '../domain/wallet';
import { METRICS, type Metrics } from '../application/ports/metrics';
import {
  IdentityProviderUnavailableError,
  InvalidTokenError,
} from '../infrastructure/auth/jwt-verifier';
import {
  ForbiddenError,
  ProviderMismatchError,
  UnauthenticatedError,
} from './auth/auth.errors';
import { InvalidPayloadError } from './errors';

interface ErrorBody {
  error: { code: string; message: string };
}

/** Erros que significam entrada inválida, independentemente da camada que os detectou. */
const INVALID_INPUT_ERRORS = [
  InvalidPayloadError,
  InvalidMoneyError,
  CurrencyMismatchError,
  InvalidWalletOperationError,
  InvalidWagerTransactionError,
];

/** Falhas de infraestrutura que o cliente pode tentar de novo. */
const TRANSIENT_ERRORS = [
  ConcurrentModificationError,
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
];

const RETRY_AFTER_SECONDS = '1';

/**
 * Mapeamento único de erros para status HTTP, usado por todos os endpoints:
 * - 400 `INVALID_PAYLOAD`: contrato violado (não adianta reenviar igual);
 * - 404: recurso inexistente;
 * - 409: conflito (wallet duplicada, `IDEMPOTENCY_CONFLICT`);
 * - 503 `SERVICE_UNAVAILABLE` + `Retry-After`: falha transitória, reenviar;
 * - 401 `UNAUTHENTICATED` / `INVALID_TOKEN` (+ `WWW-Authenticate`): sem
 *   credencial válida;
 * - 403 `FORBIDDEN` / `PROVIDER_MISMATCH`: credencial sem permissão;
 * - 503 `AUTH_UNAVAILABLE`: chaves do IdP inalcançáveis (transitório);
 * - 500 `INTERNAL_ERROR`: erro inesperado.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(exception);

    if (status === HttpStatus.UNAUTHORIZED) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="wagering"');
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
      if (
        !(exception instanceof ConnectionException) &&
        !(exception instanceof IdentityProviderUnavailableError)
      ) {
        this.metrics.concurrencyConflict((exception as Error).name);
      }
    }
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { code: body.error.code, error: (exception as Error)?.name },
        (exception as Error)?.stack,
      );
    }
    response.status(status).json(body);
  }

  private map(exception: unknown): [number, ErrorBody] {
    if (exception instanceof UnauthenticatedError) {
      return [HttpStatus.UNAUTHORIZED, body(exception.code, exception.message)];
    }
    if (exception instanceof InvalidTokenError) {
      return [
        HttpStatus.UNAUTHORIZED,
        body('INVALID_TOKEN', `token inválido: ${exception.message}`),
      ];
    }
    if (
      exception instanceof ForbiddenError ||
      exception instanceof ProviderMismatchError
    ) {
      return [HttpStatus.FORBIDDEN, body(exception.code, exception.message)];
    }
    if (exception instanceof IdentityProviderUnavailableError) {
      return [
        HttpStatus.SERVICE_UNAVAILABLE,
        body('AUTH_UNAVAILABLE', exception.message),
      ];
    }
    if (INVALID_INPUT_ERRORS.some((type) => exception instanceof type)) {
      return [
        HttpStatus.BAD_REQUEST,
        body('INVALID_PAYLOAD', (exception as Error).message),
      ];
    }
    if (
      exception instanceof WalletNotFoundError ||
      exception instanceof WagerTransactionNotFoundError
    ) {
      return [HttpStatus.NOT_FOUND, body(exception.code, exception.message)];
    }
    if (
      exception instanceof WalletAlreadyExistsError ||
      exception instanceof IdempotencyConflictError
    ) {
      return [HttpStatus.CONFLICT, body(exception.code, exception.message)];
    }
    if (exception instanceof ApplicationError) {
      return [
        HttpStatus.UNPROCESSABLE_ENTITY,
        body(exception.code, exception.message),
      ];
    }
    if (TRANSIENT_ERRORS.some((type) => exception instanceof type)) {
      return [
        HttpStatus.SERVICE_UNAVAILABLE,
        body('SERVICE_UNAVAILABLE', 'Falha transitória de infraestrutura'),
      ];
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return [
        status,
        body(HttpStatus[status] ?? 'HTTP_ERROR', exception.message),
      ];
    }
    return [
      HttpStatus.INTERNAL_SERVER_ERROR,
      body('INTERNAL_ERROR', 'Erro interno'),
    ];
  }
}

function body(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
