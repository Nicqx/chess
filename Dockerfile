FROM node:20-bookworm
WORKDIR /app
COPY package.json ./
RUN npm install
RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish \
 && rm -rf /var/lib/apt/lists/*
COPY . .
EXPOSE 8099
CMD ["node", "index.js"]
