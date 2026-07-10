import http from 'http';
import dotenv from 'dotenv';
import { setupBot } from './bot.js';
import sessionManager from './state.js';

// Load environment variables
dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 7860;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
      .map(id => parseInt(id, 10))
  : [];

// 1. Run environment diagnostics on startup
runDiagnostics();

if (!TOKEN || TOKEN === 'your_telegram_bot_token_here') {
  console.error('❌ ERROR: TELEGRAM_BOT_TOKEN is not configured in the environment.');
  process.exit(1);
}

// 2. Initialize Telegraf Bot
console.log('ℹ️ [Bot] Initializing Telegraf instance...');
const bot = setupBot(TOKEN, ALLOWED_USERS);

// Webhook callback placeholder
let webhookCallback = null;

// 3. Initialize HTTP Server
const server = http.createServer((req, res) => {
  // If in Webhook mode, route POST updates from Telegram to the bot
  if (webhookCallback && req.url === '/telegraf-webhook' && req.method === 'POST') {
    webhookCallback(req, res);
  } else if (req.url === '/health' || req.url === '/') {
    // Health status endpoint
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      mode: WEBHOOK_URL ? 'webhook' : 'polling'
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Bind HTTP server port
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`ℹ️ [HTTP Server] Listening on port ${PORT} for health check queries.`);

  if (WEBHOOK_URL && WEBHOOK_URL !== 'your_public_webhook_url_here') {
    console.log('ℹ️ [Bot] WEBHOOK_URL detected. Configuring Webhook mode...');
    const cleanWebhookUrl = WEBHOOK_URL.endsWith('/') ? WEBHOOK_URL.slice(0, -1) : WEBHOOK_URL;
    const webhookPath = `${cleanWebhookUrl}/telegraf-webhook`;
    
    console.log(`ℹ️ [Bot] Registering webhook endpoint: ${webhookPath}`);
    webhookCallback = bot.webhookCallback('/telegraf-webhook');

    try {
      // Register webhook on Telegram servers and drop any update backlog
      await bot.telegram.setWebhook(webhookPath, { drop_pending_updates: true });
      console.log('✅ [Bot] Telegram Webhook registered successfully!');

      // Start Keep-Alive self-pinger to prevent Hugging Face Spaces sleep states
      startKeepAlive(cleanWebhookUrl);
    } catch (err) {
      console.error('❌ [Bot Error] Failed to register webhook on Telegram:', err.message);
      process.exit(1);
    }
  } else {
    console.log('ℹ️ [Bot] No WEBHOOK_URL detected. Running in Polling mode...');
    
    // Self-healing polling loop to survive startup conflicts
    const startPolling = async (retries = 0) => {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch();
        console.log('✅ [Bot] Telegraf connected successfully (Polling mode). Ready!');
      } catch (err) {
        console.error(`❌ [Bot Error] Failed to launch Telegraf Polling loop (Attempt ${retries + 1}):`, err.message);
        if (err.message.includes('Conflict')) {
          console.log('  ⚠️ Bot token conflict detected (another instance is currently active).');
          console.log('  ⚠️ Retrying polling connection in 10 seconds...');
          setTimeout(() => startPolling(retries + 1), 10000);
        } else {
          console.log('  ⚠️ Retrying connection in 5 seconds...');
          setTimeout(() => startPolling(retries + 1), 5000);
        }
      }
    };

    await startPolling();
  }

  // 4. Start the Session Manager idle cleanup daemon (30-minute inactivity limit)
  sessionManager.startIdleCleanup(30 * 60 * 1000);
});

// 5. Graceful shutdown handler
async function handleShutdown(signal) {
  console.log(`\nℹ️ [Shutdown] Received ${signal}. Terminating bot gracefully...`);
  
  server.close(() => {
    console.log('ℹ️ [Shutdown] HTTP server closed.');
  });

  try {
    bot.stop(signal);
    console.log('ℹ️ [Shutdown] Telegraf listener stopped.');
  } catch (err) {
    console.error('❌ [Shutdown Error] Failed to stop Telegraf:', err.message);
  }

  // Close all browser pages/contexts from the session state
  await sessionManager.closeAll();

  console.log('✅ [Shutdown] Clean shutdown completed. Exiting.');
  process.exit(0);
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Unhandled Rejection] at:', promise, 'reason:', reason);
});

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
    const valid = cookie.startsWith('eyJ') && cookie.length > 100;
    console.log(`  ✅ LOVABLE_SESSION_COOKIE: Configured (Length: ${cookie.length}, Format: ${valid ? 'JWT/Firebase Valid' : 'Invalid'})`);
  }

  if (ALLOWED_USERS.length > 0) {
    console.log(`  ✅ ALLOWED_USER_IDS: Configured (${ALLOWED_USERS.length} authorized IDs)`);
  } else {
    console.log('  ⚠️ ALLOWED_USER_IDS: Not configured (Bot is open to public!).');
  }

  if (WEBHOOK_URL) {
    console.log(`  ✅ WEBHOOK_URL: Configured (${WEBHOOK_URL})`);
  } else {
    console.log('  ℹ️ WEBHOOK_URL: Optional (Will fall back to Polling).');
  }
}

/**
 * Periodically self-pings the health endpoint to prevent the server from entering sleep modes.
 * @param {string} rootUrl - Web service public root URL
 */
function startKeepAlive(rootUrl) {
  console.log(`ℹ️ [System] Starting 20-minute Keep-Alive self-pinger for: ${rootUrl}/health`);
  setInterval(() => {
    http.get(`${rootUrl}/health`, (res) => {
      console.log(`[Keep-Alive] Pinged health check. Response Status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('[Keep-Alive Error] Self-ping handshake failed:', err.message);
    });
  }, 20 * 60 * 1000); // 20 minutes
}
