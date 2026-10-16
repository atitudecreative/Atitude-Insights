# Imagem de produção (Next.js standalone não é usado para manter o worker no mesmo artefato).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN useradd --system --uid 1001 app
COPY --from=build --chown=app /app ./
USER app
EXPOSE 3000
# Padrão: aplicação web. Para o worker, use o comando `npm run worker`.
CMD ["npx", "next", "start", "-p", "3000"]
