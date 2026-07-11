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

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 7860;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
      .map(id => parseInt(id, 10))
  : [];

// Run environment diagnostics on startup
runDiagnostics();

if (!TOKEN || TOKEN === 'your_telegram_bot_token_here') {
  console.error('❌ ERROR: TELEGRAM_BOT_TOKEN is not configured in the environment.');
  process.exit(1);
}

// 1. Initialize Telegraf Bot
console.log('ℹ️ [Bot] Initializing Telegraf instance...');
const bot = setupBot(TOKEN, ALLOWED_USERS);

// 2. Configure Express + Socket.io Server
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// Webhook callback routing
let webhookCallback = null;
app.post('/telegraf-webhook', (req, res) => {
  if (webhookCallback) {
    webhookCallback(req, res);
  } else {
    res.status(404).send('Webhook unconfigured');
  }
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mode: WEBHOOK_URL ? 'webhook' : 'polling'
  });
});

// 3. Socket.io Event Handling
// We bind the web UI client connection to the default session context.
// In a multi-user context, we default to the first user or a shared session.
const DEFAULT_CHAT_ID = ALLOWED_USERS.length > 0 ? String(ALLOWED_USERS[0]) : 'default_web_session';

io.on('connection', (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);
  const session = sessionManager.getSession(DEFAULT_CHAT_ID);

  // Retrieve project list
  socket.on('get-projects', async () => {
    try {
      console.log('[WebSocket] Fetching projects dashboard...');
      const projects = await scrapeProjects(session);
      socket.emit('projects-list', projects);
      
      // Sync processing state on connection/refresh
      socket.emit('session-state', {
        isProcessing: session.isProcessing,
        activeProject: session.activeProject ? session.activeProject.name : null
      });
    } catch (err) {
      console.error('[WebSocket] Projects fetch failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
    }
  });

  // Select active workspace project
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

  // Submit Prompt to active project
  socket.on('submit-prompt', async (data) => {
    try {
      if (!session.activeProject) throw new Error('No project active. Select a project first.');
      if (session.isProcessing) throw new Error('Another task is currently running.');

      console.log(`[WebSocket] Deploying prompt: "${data.prompt}"`);
      session.isProcessing = true;

      // Submit prompt to Playwright
      await submitPrompt(session, data.prompt);

      // Start build observer
      observeBuild(
        session,
        // onUpdate
        async (statusText, fileOps, progressText, terminalLogs) => {
          console.log(`[WebSocket] Broadcaster build-update status: "${statusText}"`);
          io.emit('build-update', {
            status: statusText,
            files: fileOps,
            progress: progressText,
            terminalLogs: terminalLogs
          });
        },
        // onQuestion
        async (questionText, options) => {
          console.log(`[WebSocket] Broadcaster build-question: "${questionText}"`);
          io.emit('build-question', {
            question: questionText,
            options: options
          });
        },
        // onFinished
        async (previewUrl, fullResponse) => {
          console.log(`[WebSocket] Broadcaster build-finished. URL: ${previewUrl}`);
          io.emit('build-finished', {
            url: previewUrl,
            response: fullResponse
          });
          session.isProcessing = false;
        },
        // onTimeout
        async () => {
          console.log('[WebSocket] Broadcaster build-timeout.');
          io.emit('operation-failed', { error: 'Observation Timeout: Build took longer than 5 minutes.' });
          session.isProcessing = false;
        }
      );

    } catch (err) {
      console.error('[WebSocket] Prompt execution failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
      session.isProcessing = false;
    }
  });

  // Submit interactive option choice
  socket.on('submit-question-choice', async (data) => {
    try {
      console.log(`[WebSocket] Clicking option: "${data.text}"`);
      await clickOptionButton(session, data.text);
    } catch (err) {
      console.error('[WebSocket] Option selection failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
    }
  });

  // Cancel build
  socket.on('cancel-build', () => {
    console.log('[WebSocket] Cancel command received.');
    session.isProcessing = false;
    session.promptQueue = [];
  });

  // Force capture viewport snapshot
  socket.on('capture-snapshot', async () => {
    try {
      if (!session.page) throw new Error('No active page session loaded.');
      const snapshotPath = await takeBrowserScreenshot(session);
      
      // Send base64 image over websocket
      const imageBuffer = await fs.promises.readFile(snapshotPath);
      const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;
      socket.emit('snapshot-capture', { img: base64Image });
      
      // Clean up file
      await fs.promises.unlink(snapshotPath);
    } catch (err) {
      console.error('[WebSocket] Snapshot capture failed:', err.message);
      socket.emit('operation-failed', { error: err.message });
    }
  });

  // Kill Session
  socket.on('stop-session', async () => {
    console.log('[WebSocket] Termination request received.');
    await sessionManager.closeSession(DEFAULT_CHAT_ID);
  });

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
  });
});

// 4. Bind HTTP server port
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`ℹ️ [HTTP Server] Listening on port ${PORT} for health check queries & Web UI.`);

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
      console.error('❌ [Bot Error] Failed to register webhook on Telegram:', err.message);
      process.exit(1);
    }
  } else {
    console.log('ℹ️ [Bot] No WEBHOOK_URL detected. Running in Polling mode...');
    const startPolling = async (retries = 0) => {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch();
        console.log('✅ [Bot] Telegraf connected successfully (Polling mode). Ready!');
      } catch (err) {
        console.error(`❌ [Bot Error] Failed to launch Telegraf Polling loop (Attempt ${retries + 1}):`, err.message);
        if (err.message.includes('Conflict')) {
          console.log('  ⚠️ Bot token conflict detected. Retrying in 10 seconds...');
          setTimeout(() => startPolling(retries + 1), 10000);
        } else {
          console.log('  ⚠️ Retrying connection in 5 seconds...');
          setTimeout(() => startPolling(retries + 1), 5000);
        }
      }
    };
    await startPolling();
  }

  // Start Session Manager idle cleanup (30-minute limit)
  sessionManager.startIdleCleanup(30 * 60 * 1000);
});

// Graceful shutdown handler
async function handleShutdown(signal) {
  console.log(`\nℹ️ [Shutdown] Received ${signal}. Terminating bot gracefully...`);
  httpServer.close(() => {
    console.log('ℹ️ [Shutdown] HTTP server closed.');
  });
  try {
    bot.stop(signal);
  } catch {}
  await sessionManager.closeAll();
  process.exit(0);
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

/**
 * Diagnostic helper to log masked environment states on startup.
 */
function runDiagnostics() {
  console.log('🔍 [Diagnostics] Running environment checks...');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'your_telegram_bot_token_here') {
    console.log('  ❌ TELEGRAM_BOT_TOKEN: Missing or default value.');
  } else {
    const masked = token.substring(0, 6) + '...' + token.substring(token.length - 4);
    console.log(`  ✅ TELEGRAM_BOT_TOKEN: Configured (${masked})`);
  }

  const cookie = process.env.LOVABLE_SESSION_COOKIE;
  if (!cookie || cookie === 'your_session_cookie_value_here') {
    console.log('  ❌ LOVABLE_SESSION_COOKIE: Missing or default value.');
  } else {
    console.log(`  ✅ LOVABLE_SESSION_COOKIE: Configured (Length: ${cookie.length})`);
  }

  if (ALLOWED_USERS.length > 0) {
    console.log(`  ✅ ALLOWED_USER_IDS: Configured (${ALLOWED_USERS.length} authorized IDs)`);
  } else {
    console.log('  ⚠️ ALLOWED_USER_IDS: Not configured (Bot is open to public!).');
  }
}

/**
 * Periodically self-pings the health endpoint to prevent the server from entering sleep modes.
 */
function startKeepAlive(rootUrl) {
  console.log(`ℹ️ [System] Starting 20-minute Keep-Alive self-pinger for: ${rootUrl}/health`);
  setInterval(() => {
    import('http').then(http => {
      http.get(`${rootUrl}/health`, (res) => {
        console.log(`[Keep-Alive] Pinged health check. Response Status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error('[Keep-Alive Error] Self-ping failed:', err.message);
      });
    });
  }, 20 * 60 * 1000);
}
