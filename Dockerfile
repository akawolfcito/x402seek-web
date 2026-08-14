# Wayfinder preview — one persistent Node container.
#
# Not serverless, and not by preference: `onnxruntime-node` is a native binding
# and the embedding model is 86 MB. Under a function runtime that combination
# means either a bundle over the limit or a cold start measured in tens of
# seconds, and the whole point of this page is that a reviewer understands it in
# thirty.
#
# The model is baked in at build time, so a container start does not depend on
# the Hugging Face CDN being reachable.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# --- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# --- model ------------------------------------------------------------------
# Fetched once here rather than on first request. `warm-model.mts` calls the
# real embedder, so a build fails loudly if the artifacts moved.
FROM deps AS model
COPY vendor ./vendor
COPY scripts/warm-model.mts ./scripts/
ENV MODELS_CACHE_DIR=/app/.models-cache
RUN pnpm exec tsx scripts/warm-model.mts

# --- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV MODELS_CACHE_DIR=/app/.models-cache
ENV PORT=8080
ENV HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY --from=model /app/.models-cache ./.models-cache
COPY package.json tsconfig.json ./
COPY vendor ./vendor
COPY src ./src
COPY web ./web
COPY data ./data

# No secrets are read, so the process needs no privileged identity.
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
