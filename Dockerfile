# Playwright Docker base image — aligned to version v1.45.1 to match package locks and keep build light and reliable
FROM mcr.microsoft.com/playwright:v1.45.1-jammy

WORKDIR /app

# The base image already has a non-root 'pwuser' pre-created.
# We set permissions of our app directory to 'pwuser'
RUN chown -R pwuser:pwuser /app

# Copy package configuration
COPY --chown=pwuser:pwuser package*.json ./

# Force exact version in package.json to match base image so no mismatch occurs on installation
RUN node -e "const p = require('./package.json'); p.dependencies.playwright = '1.45.1'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2))"

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --production --no-audit --no-fund

# Copy application files
COPY --chown=pwuser:pwuser public/ ./public/
COPY --chown=pwuser:pwuser extension/ ./extension/
COPY --chown=pwuser:pwuser *.js ./
COPY --chown=pwuser:pwuser .env.example ./

# Install xvfb under root to run headed Chrome with extensions in Docker
USER root
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# Switch back to the pre-created non-root user
USER pwuser

# Playwright config
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV QT_X11_NO_MITSHM=1
ENV _X11_NO_MITSHM=1
ENV MITSHM=0

EXPOSE 7860

CMD ["xvfb-run", "--server-args=-screen 0 1440x900x24", "node", "index.js"]
