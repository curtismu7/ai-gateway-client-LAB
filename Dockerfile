FROM node:26-alpine AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# The server resolves ../package.json, ../diagrams and ../web/dist, so the image keeps the repo layout.
FROM node:26-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server/ ./
COPY package.json /app/package.json
COPY diagrams/ /app/diagrams/
COPY --from=webbuild /app/web/dist /app/web/dist

EXPOSE 6880
ENV PORT=6880
# Listen on all interfaces inside the container only; compose publishes it on 127.0.0.1.
ENV HOST=0.0.0.0
ENV MODE=mock
CMD ["node", "index.js"]
