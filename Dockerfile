# Playwright Docker base image — includes Chromium + all Linux dependencies
FROM mcr.microsoft.com/playwright:v1.45.1-jammy

WORKDIR /app

# The base image already has a non-root 'pwuser' pre-created.
# We set permissions of our app directory to 'pwuser'
RUN chown -R pwuser:pwuser /app

# Copy package configuration
COPY --chown=pwuser:pwuser package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --production

# Copy application files
COPY --chown=pwuser:pwuser *.js ./
COPY --chown=pwuser:pwuser .env.example ./

# Playwright config
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV QT_X11_NO_MITSHM=1
ENV _X11_NO_MITSHM=1
ENV MITSHM=0

# Switch to the pre-created non-root user
USER pwuser
EXPOSE 7860

CMD ["node", "index.js"]
