import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import path from 'path';

// ==========================================
// 1. CONFIGURATION LAYER
// ==========================================
const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const EXTENSION_PATH = process.env.EXTENSION_PATH || '/var/www/my-custom-extension';

const app = express();
const server = http.createServer(app);

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date() });
});

// Serve static interface if running standard setup
app.use(express.static(path.join(process.cwd(), 'public')));

// Create the WebSocket server wrapper tied to the HTTP server
const wss = new WebSocketServer({ server });

console.log(`[SYSTEM]: Configuration active. PORT: ${PORT}`);
console.log(`[SYSTEM]: Target Chrome Binary: ${CHROME_PATH}`);
console.log(`[SYSTEM]: Custom Chrome Extension: ${EXTENSION_PATH}`);

// ==========================================
// 2. WEBSOCKET CONTROLLER & LIFECYCLE
// ==========================================
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS]: New client connection established from IP: ${clientIp}`);

  // client-specific isolated browser variables
  let clientBrowser = null;
  let clientPage = null;
  let isScreencastActive = false;

  // Utility to safely dispatch JSON messages down the socket connection
  const sendToClient = (type, payload) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  };

  const logToClient = (message) => {
    console.log(`[CLIENT-LOG]: ${message}`);
    sendToClient('log', { message });
  };

  const logErrorToClient = (message, err) => {
    const errorDetails = err ? `: ${err.message || err}` : '';
    console.error(`[CLIENT-ERR]: ${message}${errorDetails}`);
    sendToClient('log', { message: `[ERROR]: ${message}${errorDetails}`, isError: true });
    sendToClient('error', { error: `${message}${errorDetails}` });
  };

  // Safe browser cleanup method
  const cleanupBrowser = async () => {
    isScreencastActive = false;
    if (clientBrowser) {
      try {
        logToClient('[SYSTEM]: Cleaning up client browser context...');
        await clientBrowser.close();
        logToClient('[SYSTEM]: Chrome context successfully closed.');
      } catch (err) {
        console.error('[SYSTEM]: Failed to close browser context gracefully:', err.message);
      } finally {
        clientBrowser = null;
        clientPage = null;
      }
    }
  };

  // Event listener for incoming client automation payloads
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { action } = data;

      if (!action) {
        logErrorToClient('No automation action specified in payload.');
        return;
      }

      if (action === 'launch') {
        const { token, projectId, prompt } = data;
        
        if (!token) {
          logErrorToClient('Action "launch" requires a valid authentication token.');
          return;
        }
        if (!projectId) {
          logErrorToClient('Action "launch" requires a target projectId.');
          return;
        }
        if (!prompt) {
          logErrorToClient('Action "launch" requires an automation input prompt.');
          return;
        }

        // Avoid double launching browser contexts
        if (clientBrowser) {
          logToClient('[SYSTEM]: Cleaning up existing browser session before launching new context...');
          await cleanupBrowser();
        }

        logToClient('[SYSTEM]: Initiating Puppeteer launch controller...');

        // ==========================================
        // 3. PUPPETEER LOGIC BLOCK
        // ==========================================
        try {
          clientBrowser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false, // Chrome extensions are only loaded in non-headless or headless=new (modern Chrome)
            args: [
              `--disable-extensions-except=${EXTENSION_PATH}`,
              `--load-extension=${EXTENSION_PATH}`,
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--headless=new', // modern headless argument
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-software-rasterizer',
              '--disable-web-security'
            ],
            defaultViewport: {
              width: 1280,
              height: 720
            }
          });

          logToClient('[CHROME]: Browser instance spawned with unpacked extensions successfully.');

          // Open target page context
          const pages = await clientBrowser.pages();
          clientPage = pages.length > 0 ? pages[0] : await clientBrowser.newPage();

          // Catch any unexpected browser crashes
          clientBrowser.on('disconnected', () => {
            logToClient('[SYSTEM]: Remote Chrome process disconnected / closed.');
            cleanupBrowser();
          });

          // ==========================================
          // 4. CREDENTIAL INJECTION & AUTOMATION
          // ==========================================
          logToClient('[SYSTEM]: Navigating to Lovable.dev root domain to set context...');
          await clientPage.goto('https://lovable.dev', { waitUntil: 'domcontentloaded', timeout: 30000 });

          logToClient('[AUTH]: Injecting user authentication token into LocalStorage...');
          await clientPage.evaluate((authToken) => {
            localStorage.setItem('sb-auth-token', authToken);
          }, token);

          const targetUrl = `https://lovable.dev/projects/${projectId}`;
          logToClient(`[SYSTEM]: Navigating to target workspace: ${targetUrl}`);
          await clientPage.goto(targetUrl, { waitUntil: 'load', timeout: 45000 });

          // Wait for editor or workspace text input area to render
          logToClient('[AUTOMATION]: Waiting for prompt textarea input element...');
          const textSelector = 'textarea, div[contenteditable="true"]';
          await clientPage.waitForSelector(textSelector, { visible: true, timeout: 25000 });

          logToClient('[AUTOMATION]: Typing user prompt payload...');
          await clientPage.focus(textSelector);
          await clientPage.keyboard.type(prompt, { delay: 30 });

          logToClient('[AUTOMATION]: Dispatching user prompt payload to Lovable engine...');
          await clientPage.keyboard.press('Control+Enter');
          logToClient('[SYSTEM]: Prompt submission dispatched successfully.');

          // ==========================================
          // 5. GRAPHICAL SCREENCAST PIPELINE
          // ==========================================
          logToClient('[STREAM]: Starting graphical screencast captures (JPEG quality 50%)...');
          const clientDevTools = await clientPage.target().createCDPSession();
          
          await clientDevTools.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 50,
            everyNthFrame: 1
          });

          isScreencastActive = true;

          clientDevTools.on('Page.screencastFrame', async (frame) => {
            if (!isScreencastActive) return;
            
            try {
              // Dispatch base64 frame back down the WebSocket client pipeline
              sendToClient('screen', { data: frame.data });
              
              // Acknowledge the frame to prevent rendering backlog bottlenecks
              await clientDevTools.send('Page.ackScreencastFrame', {
                sessionId: frame.sessionId
              });
            } catch (frameErr) {
              console.error('[STREAM]: Error processing screencast frame:', frameErr.message);
            }
          });

        } catch (automationErr) {
          logErrorToClient('Automation sequence interrupted by exception', automationErr);
          await cleanupBrowser();
        }
      } else if (action === 'stop') {
        logToClient('[SYSTEM]: Stop automation session requested by client.');
        await cleanupBrowser();
      } else {
        logErrorToClient(`Unknown action type: "${action}"`);
      }

    } catch (parseErr) {
      logErrorToClient('Failed to parse incoming WebSocket text message', parseErr);
    }
  });

  // ==========================================
  // 6. TEARDOWN & LIFECYCLE MANAGEMENT
  // ==========================================
  ws.on('close', async () => {
    console.log(`[WS]: Client connection closed for IP: ${clientIp}`);
    await cleanupBrowser();
  });

  ws.on('error', async (socketErr) => {
    console.error(`[WS]: Error encountered for IP: ${clientIp}:`, socketErr.message);
    await cleanupBrowser();
  });
});

// Bind server to port
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Server successfully launched on port ${PORT}`);
  console.log(`🏥 Health Check endpoint: http://localhost:${PORT}/health`);
  console.log(`======================================================\n`);
});
