FROM node:20-alpine

WORKDIR /app
COPY . .

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server.js"]
