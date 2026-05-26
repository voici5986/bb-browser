# Stage 1: Build bb-viewer inside the same base image (matching glibc)
FROM node:22-bookworm-slim AS viewer-builder

# Use China mirrors for apt and Go downloads
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null; \
    true
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    libvpx-dev libturbojpeg0-dev pkg-config gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Go 1.25+ (use Go China mirror)
RUN curl -sL https://golang.google.cn/dl/go1.25.1.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:$PATH"

WORKDIR /build
COPY bin/bb-viewer-src/ .
RUN GOPROXY=https://goproxy.cn,direct go build -o /bb-viewer .

# Stage 2: Runtime
FROM node:22-bookworm-slim

# Use China mirrors for apt
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null; \
    true

# Chrome + bb-viewer + Xvfb runtime dependencies
# Xvfb provides a virtual framebuffer so Chrome runs in headed mode.
# Headed Chrome is required because --headless=new on Linux lacks full
# GUI APIs (WebGL, plugins, screen info) that anti-bot systems detect.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0 libdrm2 \
    libgbm1 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libpango-1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 \
    libxext6 libxfixes3 libxkbcommon0 libatspi2.0-0 \
    libvpx7 libturbojpeg0 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy bb-viewer from builder (linked against same glibc + libs)
COPY --from=viewer-builder /bb-viewer /usr/local/bin/bb-viewer
RUN chmod +x /usr/local/bin/bb-viewer

# Pre-install Chrome for Testing (avoids runtime download).
# Place the zip at bin/chrome-linux64.zip before building.
# Download locally: curl -L -o bin/chrome-linux64.zip \
#   "https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.22/linux64/chrome-linux64.zip"
COPY bin/chrome-linux64.zip /tmp/chrome-linux64.zip
RUN mkdir -p /data/browser && \
    unzip -q /tmp/chrome-linux64.zip -d /data/browser && \
    chmod 755 /data/browser/chrome-linux64/chrome && \
    echo "149.0.7827.22" > /data/browser/version && \
    rm /tmp/chrome-linux64.zip

# Copy built daemon and install runtime deps
COPY dist/ ./dist/
COPY web/ ./web/
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com 2>/dev/null || true

ENV NODE_ENV=production
ENV BB_BROWSER_HOME=/data
ENV DISPLAY=:99
ENV CHROME_HEADED=1

EXPOSE 19824

# Start Xvfb (virtual framebuffer), then run daemon.
# Chrome launches in headed mode on the virtual display.
# Video stream still uses CDP screencast → bb-viewer → WebRTC.
COPY <<'ENTRYPOINT' /entrypoint.sh
#!/bin/sh
Xvfb :99 -screen 0 1920x1080x24 -ac +render -noreset &
XVFB_PID=$!
# Wait for Xvfb to be ready
for i in 1 2 3 4 5 6 7 8 9 10; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.5
done
exec node dist/daemon.js "$@"
ENTRYPOINT
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
