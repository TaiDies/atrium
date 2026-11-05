# --- Build the web app ---
FROM node:24-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# The instructions for AI chats are shown in the Import dialog.
COPY docs/ ../docs/
RUN npm run build

# --- Build the server ---
FROM node:24-alpine AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# --- Runtime ---
FROM node:24-alpine
# LibreOffice converts documents, spreadsheets and presentations between formats (Word, Excel,
# PowerPoint, OpenDocument, RTF, CSV, PDF) for the built-in editors and the exact-layout view.
# Liberation fonts match Arial/Times/Courier metrics so Office files keep their layout.
# ffmpeg does the quick video edits (trim, mute, rotate).
RUN apk add --no-cache libreoffice-writer libreoffice-calc libreoffice-impress ffmpeg \
      ttf-liberation font-noto font-noto-arabic font-noto-cjk fontconfig \
  && fc-cache -f
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIR=/app/web
WORKDIR /app/server
COPY --from=server /build/server/package.json ./
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/dist ./dist
COPY --from=server /build/server/migrations ./migrations
COPY --from=web /build/web/dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000 3001
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
