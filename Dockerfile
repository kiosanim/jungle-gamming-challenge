# Runtime Bun executando o TypeScript diretamente (sem etapa de build).
# Um estágio base comum e uma imagem final por papel:
#   docker build --target api|consumer|workers|setup .
FROM oven/bun:1.4.4-slim AS base

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# HTTP em todos os papéis: rotas de negócio só na API; health e métricas em todos.
EXPOSE 3000

# Execução única: migrations (CLI do MikroORM) e criação das filas SQS.
FROM base AS setup
COPY scripts ./scripts
CMD ["sh", "-c", "bun run migration:up && bun run sqs:setup"]

# Consumidor da fila FIFO de transações.
FROM base AS consumer
CMD ["bun", "src/main-consumer.ts"]

# Publisher da outbox e resolução de referências pendentes.
FROM base AS workers
CMD ["bun", "src/main-workers.ts"]

# Rotas HTTP de negócio (último estágio: alvo padrão de `docker build .`).
FROM base AS api
CMD ["bun", "src/main-api.ts"]
