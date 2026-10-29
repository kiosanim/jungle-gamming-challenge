import { IdGenerator } from '../application/ports/id-generator';

/**
 * UUIDv7: ordenável no tempo, o que mantém inserções de chaves primárias
 * próximas no índice B-tree (melhor localidade que UUIDv4).
 */
export class UuidV7Generator implements IdGenerator {
  newId(): string {
    return Bun.randomUUIDv7();
  }
}
