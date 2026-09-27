ARG NODE_IMAGE=node:24-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmjs.org/
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN --mount=type=cache,id=flashyun-vane-npm,target=/root/.npm \
    npm ci --replace-registry-host=always --registry=${NPM_REGISTRY} --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
