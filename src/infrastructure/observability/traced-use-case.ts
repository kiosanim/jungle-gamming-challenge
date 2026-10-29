import type { Attributes } from '@opentelemetry/api';
import { hasActiveSpan, SpanKind, withSpan } from './tracing';

export interface TracedUseCaseOptions<T> {
  /** Métodos que abrem um span (`<Classe>.<método>`). */
  methods: (keyof T & string)[];
  /** Atributos tirados do resultado: status, replay, contagens. */
  describe?: (method: string, result: unknown) => Attributes;
}

/**
 * Envolve um use case para que cada chamada dos métodos indicados apareça no
 * trace como a camada de aplicação, entre o span de entrada (HTTP ou
 * mensagem) e a transação SQL. O use case em si não sabe de tracing; o
 * wrapper é aplicado na composição, no `CoreModule`.
 *
 * O span só é criado quando já existe um trace ativo. Assim, o polling dos
 * workers não gera um trace por ciclo.
 */
export function traceUseCase<T extends object>(
  useCase: T,
  options: TracedUseCaseOptions<T>,
): T {
  const name = useCase.constructor.name;
  const methods = new Set<string>(options.methods);
  return new Proxy(useCase, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !methods.has(property)) {
        return value;
      }
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => {
        if (!hasActiveSpan()) {
          return method.apply(target, args);
        }
        return withSpan(
          `${name}.${property}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: { 'wagering.layer': 'application' },
          },
          async (span) => {
            const result = await method.apply(target, args);
            if (options.describe) {
              span.setAttributes(options.describe(property, result));
            }
            return result;
          },
        );
      };
    },
  });
}
