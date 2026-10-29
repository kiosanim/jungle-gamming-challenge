import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { context, propagation, trace } from '@opentelemetry/api';
import { RequestContext } from './request-context';
import { SpanKind, SpanStatusCode, tracer } from './tracing';

/**
 * Probes, coleta de métricas e a documentação Swagger: chamadas frequentes ou
 * estáticas, sem valor de diagnóstico num trace.
 */
const UNTRACED_PATHS = /^\/(health|metrics|docs)(\/|-json|$)/;

/**
 * Span de servidor para cada requisição HTTP. Continua o trace do cliente
 * quando ele envia `traceparent` (W3C). Ao terminar, o span recebe a rota, o
 * status e os identificadores do contexto de log (correlação, transação,
 * wallet e provedor), os mesmos campos dos logs, para que dê para achar o
 * trace por eles. O `traceId` volta no header `x-trace-id`, e `/health/*`,
 * `/metrics` e `/docs` não são rastreados.
 */
@Injectable()
export class TracingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Caminho completo sem query string (`req.path` é relativo ao ponto de
    // montagem do middleware no Nest).
    const path = req.originalUrl.split('?', 1)[0];
    if (UNTRACED_PATHS.test(path)) {
      next();
      return;
    }
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer().startSpan(
      req.method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'wagering.layer': 'http',
          'http.request.method': req.method,
          'url.path': path,
        },
      },
      parent,
    );
    if (span.isRecording()) {
      res.setHeader('x-trace-id', span.spanContext().traceId);
    }

    res.on('finish', () => {
      const route = req.route?.path
        ? req.baseUrl + String(req.route.path)
        : undefined;
      if (route) {
        span.updateName(`${req.method} ${route}`);
        span.setAttribute('http.route', route);
      }
      span.setAttribute('http.response.status_code', res.statusCode);
      for (const [key, value] of Object.entries(RequestContext.get())) {
        if (value !== undefined) {
          span.setAttribute(`wagering.${key}`, value);
        }
      }
      if (res.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    });

    context.with(trace.setSpan(parent, span), next);
  }
}
