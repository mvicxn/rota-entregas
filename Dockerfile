FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm run install:all
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4015
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/server/node_modules ./server/node_modules
COPY package.json ./
EXPOSE 4015
CMD ["npm", "start"]
