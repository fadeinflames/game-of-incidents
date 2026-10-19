# Orchestrator image. Build context = repository root (workspaces).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# kubernetes runtime (ADR-0008): kind drives the sandbox daemon through the docker CLI (DOCKER_HOST=unix:///var/run/docker.sock)
ARG KIND_VERSION=v0.33.0
RUN apk add --no-cache docker-cli  && wget -qO /usr/local/bin/kind "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64"  && chmod 0755 /usr/local/bin/kind

COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/runtime/package.json packages/runtime/
COPY packages/scenario/package.json packages/scenario/
COPY services/orchestrator/package.json services/orchestrator/
# devDependencies are needed: tsx runs TypeScript directly (a deliberate trade-off: no build step)
RUN npm ci --no-audit --no-fund --include=dev

COPY packages/db packages/db
COPY packages/runtime packages/runtime
COPY packages/scenario packages/scenario
COPY services/orchestrator services/orchestrator
# deploy.sh runs the image pre-pull inside this container (docker CLI + workspace packages), not on the host
COPY scripts/prepull-images.ts scripts/prepull-images.ts
# scenario definitions for the seed (scripts + yaml only; images are built separately)
COPY scenarios scenarios
RUN npm -w @wom/db run generate

WORKDIR /app/services/orchestrator
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
