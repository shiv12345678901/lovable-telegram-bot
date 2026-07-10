# Playwright Docker base image — includes Chromium + all Linux dependencies
FROM mcr.microsoft.com/playwright:v1.45.1-jammy

# Hugging Face Spaces runs containers as UID 1000
RUN useradd -m -u 1000 user || true

WORKDIR /app
RUN chown -R user:user /app

# Install dependencies (skip browser download — already in base image)
COPY --chown=user:user package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --production

# Copy application code
COPY --chown=user:user *.js ./
COPY --chown=user:user .env.example ./

# Playwright config
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV QT_X11_NO_MITSHM=1
ENV _X11_NO_MITSHM=1
ENV MITSHM=0

USER user
EXPOSE 7860

CMD ["node", "index.js"]
