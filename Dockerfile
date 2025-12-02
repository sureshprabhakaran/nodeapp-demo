FROM node:20-alpine
WORKDIR /usr/src/app
COPY app/package*.json ./
RUN npm ci --production
COPY app/ ./
EXPOSE 8080
CMD ["node", "server.js"]
