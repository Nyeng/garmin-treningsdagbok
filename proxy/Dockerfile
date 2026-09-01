# Cloud Run bygger denne med `gcloud run deploy --source .` (Cloud Build).
FROM node:22-slim

# npm ci trenger en lockfil; den lages ved første `npm install` i proxy/.
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Kjør som ikke-root. node:22-slim har allerede brukeren `node`.
USER node

# Cloud Run setter PORT selv; 8080 er bare standarden hvis den mangler.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
