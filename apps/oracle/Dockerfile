FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV ORACLE_PORT=8080

EXPOSE 8080

CMD ["npm", "run", "start"]

