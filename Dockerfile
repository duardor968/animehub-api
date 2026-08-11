FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
RUN pnpm --filter @animehub/api build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
RUN corepack enable
WORKDIR /workspace

COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml ./
COPY --from=build /workspace/node_modules node_modules
COPY --from=build /workspace/apps/api apps/api
COPY --from=build /workspace/apps/web/package.json apps/web/package.json

EXPOSE 8000
CMD ["sh", "-c", "pnpm --filter @animehub/api exec prisma migrate deploy && pnpm --filter @animehub/api start:prod"]
