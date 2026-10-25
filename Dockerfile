ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY app/src ./app/src
COPY app/role.private.md ./app/role.private.md
USER node
CMD ["node", "app/src/index.js", "--config", "./app/config.json"]
