# Multi-stage build. The builder stage compiles better-sqlite3's native
# addon; the runtime stage carries only the result, so the final image
# has no compiler toolchain.

# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build tools required to compile better-sqlite3 from source if no prebuilt
# binary is available for the target platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Persisted uploads + SQLite DB live here; mount a volume to keep them.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 8080

# Lightweight liveness check against the static index page.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
