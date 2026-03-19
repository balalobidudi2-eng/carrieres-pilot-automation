FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci && npx playwright install chromium firefox --with-deps

COPY server.js .

CMD ["node", "server.js"]
