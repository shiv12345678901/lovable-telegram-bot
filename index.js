// Immediate stdout so HF Runtime logs are never blank while modules load
console.log('[boot]', new Date().toISOString(), 'loading modules...');

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { setupBot } from './bot.js';
import sessionManager from './state.js';
import {
  scrapeProjects,
  openProjectWorkspace,
  submitPrompt,
  observeBuild,
  clickOptionButton,
  takeBrowserScreenshot
} from './browser.js';

console.log('[boot]', new Date().toISOString(), 'modules loaded');

// Load local .env when present (HF injects Secrets as real env vars — no .env file)
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const PORT = Number(process.env.PORT || 7860) || 7860;
const WEBHOOK_URL = String(process.env.WEBHOOK_URL || '').trim();
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .map((id) => parseInt(id, 10))
      .filter((n) => !Number.isNaN(n))
  : [];

const hasValidToken = Boolean(TOKEN && TOKEN !== 'your_telegram_bot_token_here');
const hasValidCookie = Boolean(
  process.env.LOVABLE_SESSION_COOKIE &&
    process.env.LOVABLE_SESSION_COOKIE !== 'your_session_cookie_value_here'
);

runDiagnostics();

// ── HTTP first (HF Space health requires 0.0.0.0:app_port ASAP) ──────────────
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: hasValidToken ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    mode: WEBHOOK_URL ? 'webhook' : 'polling',
    telegramConfigured: hasValidToken,
    lovableCookieConfigured: hasValidCookie,
    port: PORT
  });
});

app.get('/ready', (_req, res) => {
  if (!hasValidToken) {
    return res.status(503).json({
      ready: false,
      error: 'TELEGRAM_BOT_TOKEN secret is missing. Add it in Space Settings → Secrets.'
    });
  }
  res.json({ ready: true });
});

// Config / status page when secrets are missing (keeps Space "Running")
app.get('/status', (_req, res) => {
  res.type('html').send(buildStatusHtml());
});

// Serve dashboard; if misconfigured, still show status on /
app.use((req, res, next) => {
  if (req.path === '/' && !hasValidToken) {
    return res.type('html').send(buildStatusHtml());
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

let bot = null;
let webhookCallback = null;

app.post('/telegraf-webhook', (req, res) => {
  if (webhookCallback) {
    return webhookCallback(req, res);
  }
  res.status(503).json({ error: 'Webhook not configured (bot not started or polling mode).' });
});

const DEFAULT_CHAT_ID =
  ALLOWED_USERS.length > 0 ? String(ALLOWED_USERS[0]) : 'default_web_session';

io.on('connection', (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);
  const session = sessionManager.getSession(DEFAULT_CHAT_ID);

  socket.on('get-projects', async () => {
    try {
      if (!hasValidCookie) throw new Error('LOVABLE_SESSION_COOKIE secret is not configured.');
      console.log('[WebSocket] Fetching projects dashboard...');
      const projects = await scrapeProjects(session);
      socket.emit('projects-list', projects);
      socket.emit('session-state', {
        isProcessing: session.isProcessing,
        activeProject: session.activeProject ? session.activeProject.name : null
      });
    } catch (err) {
      console.error('[WebSocket] Projects fetch failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
    }
  });

  socket.on('select-project', async (data) => {
    try {
      const proj = session.projects[data.index];
      if (!proj) throw new Error('Invalid project index selected.');
      console.log(`[WebSocket] Activating workspace: ${proj.name}`);
      session.activeProject = proj;
      await openProjectWorkspace(session, proj.url);
      socket.emit('project-activated', { name: proj.name });
    } catch (err) {
      console.error('[WebSocket] Project activation failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
    }
  });

  socket.on('submit-prompt', async (data) => {
    try {
      if (!session.activeProject) throw new Error('No project active. Select a project first.');
      if (session.isProcessing) throw new Error('Another task is currently running.');

      console.log(`[WebSocket] Deploying prompt: "${data.prompt}"`);
      session.isProcessing = true;
      await submitPrompt(session, data.prompt);

      observeBuild(
        session,
        async (statusText, fileOps, progressText, terminalLogs) => {
          io.emit('build-update', {
            status: statusText,
            files: fileOps,
            progress: progressText,
            terminalLogs: terminalLogs
          });
        },
        async (questionText, options) => {
          io.emit('build-question', { question: questionText, options: options });
        },
        async (previewUrl, fullResponse) => {
          io.emit('build-finished', { url: previewUrl, response: fullResponse });
          session.isProcessing = false;
        },
        async () => {
          io.emit('operation-failed', {
            error: 'Observation Timeout: Build took longer than 5 minutes.'
          });
          session.isProcessing = false;
        }
      );
    } catch (err) {
      console.error('[WebSocket] Prompt execution failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
      session.isProcessing = false;
    }
  });

  socket.on('submit-question-choice', async (data) => {
    try {
      await clickOptionButton(session, data.text);
    } catch (err) {
      socket.emit('operation-failed', { error: err.message });
    }
  });

  socket.on('cancel-build', () => {
    session.isProcessing = false;
    session.promptQueue = [];
  });

  socket.on('capture-snapshot', async () => {
    try {
      if (!session.page) throw new Error('No active page session loaded.');
      const snapshotPath = await takeBrowserScreenshot(session);
      const imageBuffer = await fs.promises.readFile(snapshotPath);
      const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;
      socket.emit('snapshot-capture', { img: base64Image });
      await fs.promises.unlink(snapshotPath).catch(() => {});
    } catch (err) {
      socket.emit('operation-failed', { error: err.message });
    }
  });

  socket.on('stop-session', async () => {
    await sessionManager.closeSession(DEFAULT_CHAT_ID);
  });

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
  });
});

// Bind immediately so HF marks the Space as Running (must be < health timeout)
console.log(`[boot] binding HTTP 0.0.0.0:${PORT} ...`);
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ [HTTP Server] Listening on 0.0.0.0:${PORT}`);
  console.log(`ℹ️ [HTTP Server] Health: http://127.0.0.1:${PORT}/health`);

  if (!hasValidToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not configured.');
    console.error('   Add Space Secret TELEGRAM_BOT_TOKEN, then Factory reboot the Space.');
    console.error('   Space stays up so /health and /status work for debugging.');
    return;
  }

  if (!hasValidCookie) {
    console.warn('⚠️ LOVABLE_SESSION_COOKIE is not configured — browser features will fail until set.');
  }

  console.log('ℹ️ [Bot] Initializing Telegraf instance...');
  try {
    bot = setupBot(TOKEN, ALLOWED_USERS);
  } catch (err) {
    console.error('❌ [Bot] setupBot failed:', err.message || err);
    return;
  }

  if (WEBHOOK_URL && WEBHOOK_URL !== 'your_public_webhook_url_here') {
    console.log('ℹ️ [Bot] WEBHOOK_URL detected. Configuring Webhook mode...');
    const cleanWebhookUrl = WEBHOOK_URL.endsWith('/') ? WEBHOOK_URL.slice(0, -1) : WEBHOOK_URL;
    const webhookPath = `${cleanWebhookUrl}/telegraf-webhook`;

    console.log(`ℹ️ [Bot] Registering webhook endpoint: ${webhookPath}`);
    webhookCallback = bot.webhookCallback('/telegraf-webhook');

    try {
      await bot.telegram.setWebhook(webhookPath, { drop_pending_updates: true });
      console.log('✅ [Bot] Telegram Webhook registered successfully!');
      startKeepAlive(cleanWebhookUrl);
    } catch (err) {
      console.error('❌ [Bot Error] Failed to register webhook:', err.message);
      console.error('   Falling back to polling mode...');
      await startPollingSafe();
    }
  } else {
    console.log('ℹ️ [Bot] No WEBHOOK_URL — Polling mode...');
    await startPollingSafe();
  }

  sessionManager.startIdleCleanup(30 * 60 * 1000);
});

async function startPollingSafe() {
  const startPolling = async (retries = 0) => {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch();
      console.log('✅ [Bot] Telegraf connected (Polling). Ready!');
    } catch (err) {
      console.error(
        `❌ [Bot Error] Polling launch failed (attempt ${retries + 1}):`,
        err.message
      );
      const delay = String(err.message || '').includes('Conflict') ? 10000 : 5000;
      setTimeout(() => startPolling(retries + 1), delay);
    }
  };
  await startPolling();
}

async function handleShutdown(signal) {
  console.log(`\nℹ️ [Shutdown] Received ${signal}.`);
  httpServer.close(() => console.log('ℹ️ [Shutdown] HTTP server closed.'));
  try {
    if (bot) bot.stop(signal);
  } catch {}
  await sessionManager.closeAll();
  process.exit(0);
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

function runDiagnostics() {
  console.log('🔍 [Diagnostics] Environment checks...');
  console.log(`  PORT: ${PORT}`);
  console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`);

  if (!hasValidToken) {
    console.log('  ❌ TELEGRAM_BOT_TOKEN: Missing or placeholder');
  } else {
    const masked = TOKEN.substring(0, 6) + '...' + TOKEN.substring(TOKEN.length - 4);
    console.log(`  ✅ TELEGRAM_BOT_TOKEN: ${masked}`);
  }

  const cookie = process.env.LOVABLE_SESSION_COOKIE;
  if (!hasValidCookie) {
    console.log('  ❌ LOVABLE_SESSION_COOKIE: Missing or placeholder');
  } else {
    console.log(`  ✅ LOVABLE_SESSION_COOKIE: length ${String(cookie).length}`);
  }

  if (ALLOWED_USERS.length > 0) {
    console.log(`  ✅ ALLOWED_USER_IDS: ${ALLOWED_USERS.length} id(s)`);
  } else {
    console.log('  ⚠️ ALLOWED_USER_IDS: empty (bot open to anyone who finds it)');
  }

  if (WEBHOOK_URL) {
    console.log(`  ✅ WEBHOOK_URL: ${WEBHOOK_URL}`);
  } else {
    console.log('  ℹ️ WEBHOOK_URL: not set (polling)');
  }
}

function startKeepAlive(rootUrl) {
  console.log(`ℹ️ [System] Keep-alive every 20m → ${rootUrl}/health`);
  setInterval(() => {
    const url = `${rootUrl}/health`;
    const lib = url.startsWith('https') ? import('https') : import('http');
    lib.then((mod) => {
      mod
        .get(url, (res) => {
          console.log(`[Keep-Alive] ${res.statusCode}`);
        })
        .on('error', (err) => {
          console.error('[Keep-Alive Error]', err.message);
        });
    });
  }, 20 * 60 * 1000);
}

function buildStatusHtml() {
  const rows = [
    ['TELEGRAM_BOT_TOKEN', hasValidToken],
    ['LOVABLE_SESSION_COOKIE', hasValidCookie],
    ['ALLOWED_USER_IDS', ALLOWED_USERS.length > 0],
    ['WEBHOOK_URL', Boolean(WEBHOOK_URL)],
    ['HTTP port', true, String(PORT)]
  ];
  const list = rows
    .map(([name, ok, extra]) => {
      const icon = ok ? '✅' : '❌';
      const detail = extra ? ` — ${extra}` : ok ? ' set' : ' missing (add Space Secret)';
      return `<li>${icon} <code>${name}</code>${detail}</li>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lovable Bot — Space Status</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;background:#0f1115;color:#e8eaed}
  code{background:#1e222a;padding:2px 6px;border-radius:4px}
  a{color:#8ab4f8}
  .box{background:#1a1d24;border:1px solid #2a2f3a;border-radius:12px;padding:20px}
  h1{font-size:1.25rem}
  li{margin:8px 0}
</style></head><body>
  <div class="box">
    <h1>🤖 Lovable Telegram Bot — HF Space</h1>
    <p>HTTP is up on port <code>${PORT}</code>. Configure secrets, then <strong>Factory reboot</strong> the Space.</p>
    <ul>${list}</ul>
    <p>Health JSON: <a href="/health">/health</a></p>
    <p>Settings → Variables and secrets → New secret</p>
  </div>
</body></html>`;
}
