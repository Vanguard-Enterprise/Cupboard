FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN useradd --system --uid 10001 --no-create-home marketing
COPY --chown=10001:10001 package.json server.mjs ./
USER 10001
EXPOSE 3000
CMD ["node", "server.mjs"]
