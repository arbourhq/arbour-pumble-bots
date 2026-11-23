FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist/ ./dist/
COPY package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "dist/main.js"]
