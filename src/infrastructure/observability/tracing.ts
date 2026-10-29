import {
  type Attributes,
  type Context,
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type {
  SpanAttributes,
  SpanOptions,
  SpanScope,
  Tracer,
} from '../../application/ports/tracer';

/*
 * Rastreamento distribuído com OpenTelemetry, instrumentado à mão (a
 * auto-instrumentação depende de hooks de `require` que não funcionam de
 * forma confiável no Bun). Desligado por padrão: sem `OTEL_ENABLED=true` a
 * API do OpenTelemetry é no-op e nenhum span é criado.
 *
 * Variáveis padrão do OpenTelemetry: `OTEL_SERVICE_NAME`,
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP) e `OTEL_TRACES_SAMPLER_ARG`
 * (fração de traces amostrados na raiz; os filhos seguem o pai).
 */

const TRACER_NAME = 'wagering';

let provider: NodeTracerProvider | undefined;

export interface TracingOptions {
  serviceName: string;
  /** Substitui o exporter OTLP (testes usam um processador em memória). */
  spanProcessor?: SpanProcessor;
  /** Liga mesmo sem `OTEL_ENABLED=true` (testes). */
  force?: boolean;
}

/** Registra o provider global. Chamar antes de criar a aplicação Nest. */
export function startTracing(options: TracingOptions): void {
  if (provider || (!options.force && process.env.OTEL_ENABLED !== 'true')) {
    return;
  }
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? 1);
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || options.serviceName,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 1),
    }),
    spanProcessors: [
      options.spanProcessor ?? new BatchSpanProcessor(new OTLPTraceExporter()),
    ],
  });
  // Contexto via AsyncLocalStorage e propagação W3C (`traceparent`).
  provider.register();
}

/** Exporta o que estiver pendente e desfaz o registro global. */
export async function shutdownTracing(): Promise<void> {
  const current = provider;
  provider = undefined;
  if (!current) {
    return;
  }
  await current.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
}

export const tracer = () => trace.getTracer(TRACER_NAME);

/** Há um span ativo? Spans de banco só são criados dentro de um trace. */
export function hasActiveSpan(): boolean {
  return trace.getSpan(context.active()) !== undefined;
}

/** `traceparent` W3C do contexto corrente, para gravar ou propagar. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Contexto a partir de um `traceparent` recebido (header, mensagem, outbox). */
export function contextFromTraceparent(
  traceparent: string | undefined,
  base: Context = ROOT_CONTEXT,
): Context {
  return traceparent ? propagation.extract(base, { traceparent }) : base;
}

/** Link para o span de um `traceparent` (publicação em lote da outbox). */
export function linkFromTraceparent(
  traceparent: string | undefined,
): Link | undefined {
  const spanContext = trace.getSpanContext(contextFromTraceparent(traceparent));
  return spanContext ? { context: spanContext } : undefined;
}

/**
 * Executa `work` num span ativo (filho de `parent`), registrando exceção e
 * status de erro se `work` falhar.
 */
export function withSpan<T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Attributes; links?: Link[] },
  work: (span: Span) => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  return tracer().startActiveSpan(name, options, parent, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Ids do span ativo para os logs (correlação log ↔ trace). */
export function activeTraceIds():
  { traceId: string; spanId: string } | undefined {
  const span = trace.getSpan(context.active());
  if (!span?.isRecording()) {
    return undefined;
  }
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}

/** Adaptador da porta `Tracer` dos use cases. */
export class OpenTelemetryTracer implements Tracer {
  inSpan<T>(
    name: string,
    attributes: SpanAttributes,
    work: (span: SpanScope) => Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    return withSpan(
      name,
      { kind: SpanKind.INTERNAL, attributes },
      (span) => work({ setAttributes: (values) => span.setAttributes(values) }),
      options.continueFrom
        ? contextFromTraceparent(options.continueFrom)
        : context.active(),
    );
  }
}

export { SpanKind, SpanStatusCode };
