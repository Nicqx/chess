FROM node:20-bookworm

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish \
 && rm -rf /var/lib/apt/lists/*

COPY . .

RUN chown -R node:node /app
USER 1000:1000

EXPOSE 8099

CMD ["node", "index.js"]
