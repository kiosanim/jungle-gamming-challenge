/**
 * Base de todos os erros de domínio. Permite que as camadas externas
 * (HTTP, consumidor SQS) distingam violação de regra de negócio de falha
 * de infraestrutura sem inspecionar mensagens de erro.
 */
export abstract class DomainError extends Error {
  abstract override readonly name: string;
}
