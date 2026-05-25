# Inox — run the generator with no local toolchain (works from any language/ecosystem).
#   docker build -t inox .
#   docker run --rm -v "$PWD:/work" inox init --force
#   docker run --rm -v "$PWD:/work" inox generate --out sdk
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM node:22-slim
WORKDIR /work
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
ENTRYPOINT ["node", "/app/dist/src/cli.js"]
CMD ["--help"]
