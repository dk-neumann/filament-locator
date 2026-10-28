FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=7920
EXPOSE 7920
CMD ["node", "server.js"]
