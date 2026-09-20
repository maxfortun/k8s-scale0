FROM node:22-alpine

WORKDIR /app

COPY app/package*.json ./
RUN npm install --omit=dev

COPY app/*.js ./

USER node

EXPOSE 8080

CMD ["node", "index.js"]
