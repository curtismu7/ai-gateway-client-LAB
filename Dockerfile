FROM node:26-alpine AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:26-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server/ ./
COPY --from=webbuild /app/web/dist ../web/dist

EXPOSE 6880
ENV PORT=6880
# Listen on all interfaces inside the container only; compose publishes it on 127.0.0.1.
ENV HOST=0.0.0.0
ENV MODE=mock
CMD ["node", "index.js"]
