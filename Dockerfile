# Standalone build: Space repo root = this folder (lovable-telegram-bot).
# Matches HF log pattern: COPY package*.json, public/, extension/, *.js
FROM mcr.microsoft.com/playwright:v1.45.1-jammy

WORKDIR /app

USER root

COPY package.json package-lock.json* ./

RUN node -e "const fs=require('fs');const p=require('./package.json');p.dependencies=p.dependencies||{};p.dependencies.playwright='1.45.1';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

RUN npm install --omit=dev --no-audit --no-fund

COPY public/ ./public/
COPY extension/ ./extension/
COPY *.js ./
COPY start.sh ./
COPY .env.example ./

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp /tmp/.X11-unix \
  && chmod +x /app/start.sh \
  && npx playwright install chrome \
  && chown -R pwuser:pwuser /app

USER pwuser

ENV QT_X11_NO_MITSHM=1
ENV _X11_NO_MITSHM=1
ENV MITSHM=0
ENV DISPLAY=:99
ENV PORT=7860
# Force Node to flush logs so HF Runtime logs are not empty
ENV NODE_OPTIONS=--trace-uncaught

EXPOSE 7860

# Critical: start.sh runs Xvfb in background then exec node (binds 0.0.0.0:7860).
# Never use `xvfb-run ... node` as CMD — HF health check timed out 30m with empty logs.
CMD ["bash", "/app/start.sh"]
