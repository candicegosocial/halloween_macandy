FROM node:26-alpine
WORKDIR /app
COPY server.js index.html favicon.svg og.png config.example.json ./
# config.json is mounted/baked at runtime; DATABASE lives on the /data volume
ENV PORT=3000 DB_PATH=/data/rsvp.db
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
