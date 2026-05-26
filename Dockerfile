# Stage 1: Build bb-viewer inside the same base image (matching glibc)
FROM node:22-bookworm-slim AS viewer-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    libvpx-dev libturbojpeg0-dev pkg-config gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Go 1.25+ (bookworm has older Go)
RUN curl -sL https://go.dev/dl/go1.25.1.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:$PATH"

WORKDIR /build
COPY bin/bb-viewer-src/ .
RUN GOPROXY=https://goproxy.cn,direct go build -o /bb-viewer .

# Stage 2: Runtime
FROM node:22-bookworm-slim

# Chrome + bb-viewer runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0 libdrm2 \
    libgbm1 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libpango-1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 \
    libxext6 libxfixes3 libxkbcommon0 libatspi2.0-0 \
    libvpx7 libturbojpeg0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy bb-viewer from builder (linked against same glibc + libs)
COPY --from=viewer-builder /bb-viewer /usr/local/bin/bb-viewer
RUN chmod +x /usr/local/bin/bb-viewer

# Copy built daemon and install runtime deps
COPY dist/ ./dist/
COPY web/ ./web/
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts 2>/dev/null || true

ENV NODE_ENV=production
ENV BB_BROWSER_HOME=/data

EXPOSE 19824

ENTRYPOINT ["node", "dist/daemon.js"]
