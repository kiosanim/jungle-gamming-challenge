export interface IdGenerator {
  /** Novo identificador único (UUID). */
  newId(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
