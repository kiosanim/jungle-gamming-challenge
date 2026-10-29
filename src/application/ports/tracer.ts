export type SpanAttributes = Record<string, string | number | boolean>;

/** O span em andamento, para registrar o resultado do trabalho. */
export interface SpanScope {
  setAttributes(attributes: SpanAttributes): void;
}

export interface SpanOptions {
  /**
   * `traceparent` de um trabalho anterior (guardado no banco, por exemplo).
   * Quando informado, o span continua aquele trace em vez de começar no
   * contexto corrente.
   */
  continueFrom?: string;
}

/**
 * Rastreamento distribuído visto pelos use cases. A implementação
 * (OpenTelemetry) fica na infraestrutura; sem ela, `NOOP_TRACER` só executa
 * o trabalho.
 */
export interface Tracer {
  /** Executa `work` dentro de um span filho do contexto corrente. */
  inSpan<T>(
    name: string,
    attributes: SpanAttributes,
    work: (span: SpanScope) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
}

export const TRACER = Symbol('Tracer');

const NOOP_SPAN: SpanScope = { setAttributes: () => undefined };

export const NOOP_TRACER: Tracer = {
  inSpan: (_name, _attributes, work) => work(NOOP_SPAN),
};
