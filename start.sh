#!/usr/bin/env bash
# Hugging Face / Docker entrypoint.
# Do NOT use `xvfb-run` as PID 1 — it can hang forever before starting Node,
# so HF never sees port 7860 and times out after 30 minutes with empty logs.
set -u

echo "[start] $(date -u +%Y-%m-%dT%H:%M:%SZ) container boot"
echo "[start] uid=$(id -u) gid=$(id -g) PORT=${PORT:-7860}"
echo "[start] pwd=$(pwd) node=$(command -v node || true)"

# Virtual display for headed Chromium + Chrome extension (Playwright)
export DISPLAY="${DISPLAY:-:99}"
DISPLAY_NUM="${DISPLAY#:}"

rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp /tmp/.X11-unix 2>/dev/null || true

if command -v Xvfb >/dev/null 2>&1; then
  echo "[start] starting Xvfb on DISPLAY=${DISPLAY}"
  # Background only — never block HTTP server startup
  Xvfb "${DISPLAY}" -screen 0 1440x900x24 -ac -nolisten tcp -noreset \
    > /tmp/xvfb.log 2>&1 &
  echo "[start] Xvfb pid=$!"

  # Brief wait for socket (non-fatal if slow)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
      echo "[start] X socket ready"
      break
    fi
    sleep 0.2
  done
else
  echo "[start] WARNING: Xvfb not found — browser features may fail"
fi

echo "[start] launching node index.js (HTTP must bind immediately for HF health)"
# exec so Node receives SIGTERM from HF
exec node index.js
