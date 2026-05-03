FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /data

ENV PORT=8080
ENV DB_PATH=/data/market.db
ENV WORKERS=2

VOLUME ["/data"]

EXPOSE 8080

CMD ["npm", "run", "start"]