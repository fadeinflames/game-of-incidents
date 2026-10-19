# Web image. Build context = repository root (workspaces). Pattern ported from wom-games/Dockerfile.
FROM node:22-alpine AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/runtime/package.json packages/runtime/
COPY packages/scenario/package.json packages/scenario/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund --include=dev

FROM node:22-alpine AS builder
# robots.txt, sitemap.xml, metadataBase and the link-preview image are rendered while the image is built: the domain has to be known here
ARG WOM_DOMAIN=
ENV WOM_DOMAIN=$WOM_DOMAIN
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/db packages/db
COPY packages/runtime packages/runtime
COPY packages/scenario packages/scenario
COPY apps/web apps/web
RUN npm -w @wom/db run generate && npm -w @wom/web run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# served by GET /api/author/skill (the authoring prompt external authors download)
COPY agent-skill/wom-scenario-author/SKILL.md ./agent-skill/wom-scenario-author/SKILL.md
# Not root (infra-5). The code stays root-owned and read-only for the server. The only places the process writes are
# os.tmpdir() (/tmp: the submission and review unpacking) and Next's runtime cache under .next/cache, which is made
# writable here; docker-compose runs the production container with a read-only root and tmpfs on both.
# Nothing is fetched at run time: no next/font/google, no telemetry, no npm.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
