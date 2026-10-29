import { InvalidPayloadError } from './errors';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ids internos são UUID; qualquer outro formato é entrada inválida. */
export function parseUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidPayloadError(`${field} deve ser um UUID`);
  }
  return value.toLowerCase();
}
