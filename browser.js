import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Launches a headless Chromium instance and injects the session cookie.
 * #10: Adds browser disconnect handler for crash recovery.
 * @param {object} session - The user's active session state object
 */
export async function initBrowser(session) {
  if (session.browser) {
    try {
      await session.browser.close();
    } catch (e) {
      console.warn('[Browser] Close warning:', e.message);
    }
  }

  // Ensure virtual display for headed Chromium (HF start.sh sets DISPLAY=:99)
  if (!process.env.DISPLAY) {
    process.env.DISPLAY = ':99';
  }

  const extensionPath = path.join(process.cwd(), 'extension');
  const userDataDir = path.join(os.tmpdir(), `playwright-profile-${Date.now()}`);

  console.log(`[Browser] Launching Chromium with Extension loaded from: ${extensionPath}`);
  console.log(`[Browser] DISPLAY=${process.env.DISPLAY}`);
  
  try {
    const extFiles = fs.readdirSync(extensionPath);
    console.log(`[Browser Diagnostic] Extension directory files: ${extFiles.join(', ')}`);
  } catch (readdirErr) {
    console.error(`[Browser Diagnostic] Failed to read extension directory: ${readdirErr.message}`);
  }
  
  session.context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false, // Required for Chrome Extensions
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-web-security',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { longitude: -74.006, latitude: 40.7128 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  // Set browser reference to context object for matching close API signature
  session.browser = session.context;

  // #10: Browser crash recovery — auto-clean session on disconnect
  session.context.on('close', () => {
    console.error('[Browser] ⚠️ Chromium browser context closed!');
    session.browser = null;
    session.context = null;
    session.page = null;
    session.isProcessing = false;
  });

  // Inject anti-detection script to hide webdriver flag.
  // Do NOT stub chrome.runtime.sendMessage — that is not available in the page
  // world anyway; a fake empty runtime object only confuses diagnostics.
  await session.context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    } catch (_) {}
  });

  let cookieValue = process.env.LOVABLE_SESSION_COOKIE;
  if (!cookieValue || cookieValue === 'your_session_cookie_value_here') {
    throw new Error('LOVABLE_SESSION_COOKIE is not configured.');
  }

  // Clean the cookie value from any accidental whitespace/newlines from copy-pasting
  cookieValue = cookieValue.trim().replace(/[\r\n]/g, '');

  console.log(`[Browser] Injecting session cookie (length: ${cookieValue.length})`);

  // Inject cookie to both domain targets to cover host and subdomains safely
  await session.context.addCookies([
    {
      name: 'lovable-session-id-v2',
      value: cookieValue,
      domain: '.lovable.dev',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    },
    {
      name: 'lovable-session-id-v2',
      value: cookieValue,
      domain: 'lovable.dev',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }
  ]);

  // Persistent contexts automatically open a default page on start, reuse it
  const pages = session.context.pages();
  session.page = pages.length > 0 ? pages[0] : await session.context.newPage();
  
  session.consoleLogs = session.consoleLogs || [];
  session.page.on('console', msg => {
    const text = `[Browser Console] ${msg.type()}: ${msg.text()}`;
    console.log(text);
    session.consoleLogs.push(text);
    if (session.consoleLogs.length > 200) session.consoleLogs.shift();
    if (session.io) {
      session.io.emit('browser-log', { text });
    }
  });

  session.page.on('pageerror', err => {
    const text = `[Browser PageError] ${err.message}`;
    console.error(text);
    session.consoleLogs.push(text);
    if (session.consoleLogs.length > 200) session.consoleLogs.shift();
    if (session.io) {
      session.io.emit('browser-log', { text });
    }
  });

  console.log('[Browser] Ready.');

  // Check active service workers shortly after boot
  setTimeout(async () => {
    try {
      const sws = session.context.serviceWorkers();
      console.log(`[Browser Diagnostic] Active service workers: ${sws.map(s => s.url()).join(', ')}`);
    } catch (swErr) {
      console.error('[Browser Diagnostic] Error listing service workers:', swErr.message);
    }
  }, 3000);

  // Pre-seed extension storage to bypass gates and enable custom UI immediately
  try {
    const serviceWorker = session.context.serviceWorkers()[0] 
      || await session.context.waitForEvent("serviceworker", { timeout: 15000 });
      
    if (serviceWorker) {
      console.log('[Browser] Pre-seeding extension storage to activate floating UI...');
      await serviceWorker.evaluate(async () => {
        await new Promise((resolve) => {
          chrome.storage.local.set({
            ql_channel_redirected: true,
            ql_license_valid: true,
            ql_license_key: "INTERNAL",
            ql_sidebar_mode: false,
            // Suppress the WhatsApp/YouTube community popup so it never
            // blocks automation interactions in the sidepanel or floating UI.
            ql_join_popup_seen_v3: true
          }, resolve);
        });
      });
      console.log('[Browser] Extension storage pre-seeded.');
    } else {
      console.warn('[Browser] Service worker not found for pre-seeding.');
    }
  } catch (err) {
    console.warn('[Browser] Warning pre-seeding extension storage:', err.message);
  }
}

/**
 * Closes leaked tabs, keeping only session.page alive.
 */
async function closeLeakedTabs(session) {
  if (!session.context) return;
  try {
    const pages = session.context.pages();
    for (const p of pages) {
      if (p !== session.page) await p.close();
    }
  } catch (err) {
    console.warn('[Browser] Tab cleanup warning:', err.message);
  }
}

/**
 * #6: Smart wait — waits for actual project links instead of a blind 4s timeout.
 * Navigates to the dashboard and scrapes project list.
 */
export async function scrapeProjects(session) {
  if (session.isNavigating) {
    console.log('[Browser] Navigation/Scrape already in progress. Rejecting concurrent call.');
    return session.projects || [];
  }
  session.isNavigating = true;
  try {
    if (!session.page) await initBrowser(session);
    await closeLeakedTabs(session);

    console.log('[Browser] Navigating to projects list...');
    await session.page.goto('https://lovable.dev/dashboard/projects', { waitUntil: 'load', timeout: 45000 });

    const currentUrl = session.page.url();
    console.log(`[Browser] URL: ${currentUrl}`);

    if (currentUrl.includes('/sign-in') || currentUrl.includes('/login')) {
      throw new Error('Session cookie expired. Please update LOVABLE_SESSION_COOKIE.');
    }

    // #6: Smart wait — wait for actual project links to render, fallback to 4s
    try {
      await session.page.waitForSelector('a[href*="/projects/"]', { timeout: 12000 });
    } catch {
      await session.page.waitForTimeout(4000);
    }

    const rawProjects = await session.page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .map(a => ({
          name: (a.innerText || '').replace(/\s+/g, ' ').trim(),
          href: (a.getAttribute('href') || '').trim()
        }))
        .filter(item => item.href.includes('/projects/') || item.href.includes('/workspace/'));
    });

    console.log(`[Browser] Scraped ${rawProjects.length} raw links.`);

    const uniqueProjects = [];
    const seenUrls = new Set();

    for (const item of rawProjects) {
      let url = item.href;
      if (!url.startsWith('http')) {
        url = 'https://lovable.dev' + (url.startsWith('/') ? '' : '/') + url;
      }

      const skip = url.endsWith('/projects') || url.endsWith('/projects/') ||
        url.endsWith('/new') || url.includes('/new-project') || url.includes('/create') ||
        url.includes('/settings') || url.includes('/members') ||
        item.name.length < 2 || /create project|new project/i.test(item.name);

      if (!skip && !seenUrls.has(url)) {
        seenUrls.add(url);
        uniqueProjects.push({ name: item.name, url });
      }
    }

    if (uniqueProjects.length === 0) {
      const diagnostics = await session.page.evaluate(() => {
        return {
          title: document.title,
          bodyLen: (document.body?.innerText || '').length,
          htmlSnippet: (document.body?.innerHTML || '').slice(0, 500),
          anchorsCount: document.querySelectorAll('a').length
        };
      });
      console.warn('[Browser] ⚠️ 0 projects matched filters. Diagnostics:', diagnostics);
    }

    console.log(`[Browser] Scraped and filtered ${uniqueProjects.length} unique projects.`);
    session.projects = uniqueProjects;
    return uniqueProjects;
  } finally {
    session.isNavigating = false;
  }
}

/**
 * #7: Smart wait — waits for editor element instead of blind 5s timeout.
 * Opens a specific project workspace.
 */
export async function openProjectWorkspace(session, projectUrl) {
  if (session.isNavigating) {
    console.log('[Browser] Navigation/Workspace load already in progress. Rejecting concurrent call.');
    return;
  }
  session.isNavigating = true;
  try {
    if (!session.page) await initBrowser(session);
    await closeLeakedTabs(session);

    console.log(`[Browser] Opening workspace: ${projectUrl}`);
    await session.page.goto(projectUrl, { waitUntil: 'load', timeout: 60000 });

    // #7: Wait for actual editor to appear instead of blind 5s wait
    try {
      await session.page.waitForSelector('div[contenteditable="true"], textarea', { timeout: 12000 });
      console.log('[Browser] Editor element detected.');
    } catch {
      console.log('[Browser] Editor not found within 12s, continuing anyway...');
      await session.page.waitForTimeout(2000);
    }
  } finally {
    session.isNavigating = false;
  }
}

/**
 * Submit a prompt into Lovable's chat UI via the extension's floating input box.
 * The sidepanel approach is skipped — security-hardening.js breaks el.closest()
 * which causes the sidepanel page to crash before sp-msg renders.
 * The floating UI injected by content.js on lovable.dev is reliable and fast.
 */
export async function submitPrompt(session, promptText) {
  const { page } = session;
  if (!page) throw new Error('No active page. Select a project first.');

  const text = String(promptText || '').trim();
  if (!text) throw new Error('Prompt text is empty.');

  console.log('[Browser] Resolving Extension ID from service worker...');
  let extensionId = '';
  try {
    const serviceWorker = session.context.serviceWorkers()[0]
      || await session.context.waitForEvent("serviceworker", { timeout: 10000 });
    if (serviceWorker) {
      extensionId = serviceWorker.url().split('/')[2];
      console.log(`[Browser] Found Extension ID: ${extensionId}`);
    }
  } catch (err) {
    console.warn('[Browser] Could not resolve extension ID from service worker:', err.message);
  }

  // Use the floating UI injected by content.js on the Lovable project page.
  // The sidepanel approach is intentionally skipped: security-hardening.js breaks
  // el.closest() (Object is frozen), causing the sidepanel page to crash before
  // sp-msg renders, wasting 50+ seconds on two doomed retries.
  console.log('[Browser] Using floating UI on Lovable project page...');
  await page.bringToFront();

  async function waitForFloatingInput(timeoutMs) {
    const extInput = page.locator('textarea#ql-msg').first();
    try {
      await extInput.waitFor({ state: 'visible', timeout: timeoutMs });
      return extInput;
    } catch (_) {
      return null;
    }
  }

  let extInput = await waitForFloatingInput(15000);

  if (!extInput) {
    // The content script may not have injected yet. Reload the page and try again.
    console.log('[Browser] Floating textarea not found, reloading page and retrying...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    extInput = await waitForFloatingInput(20000);
  }

  if (!extInput) {
    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.error(`[Browser] Failed to find extension textarea on webpage. URL: ${currentUrl}, Title: ${pageTitle}`);
    try {
      const scrPath = await takeBrowserScreenshot(session);
      console.log(`[Browser] Error screenshot saved to: ${scrPath}`);
    } catch (scrErr) {
      console.error('[Browser] Failed to take error screenshot:', scrErr.message);
    }
    throw new Error(`Extension input box (textarea#ql-msg) not found. URL: ${currentUrl}. Title: ${pageTitle}. Make sure the extension is active and you are on a lovable.dev project page.`);
  }

  await extInput.click({ timeout: 10000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await extInput.fill(text);
  await page.waitForTimeout(200);

  const extSendBtn = page.locator('button#ql-send').first();
  try {
    await extSendBtn.waitFor({ state: 'visible', timeout: 10000 });
    await extSendBtn.click({ timeout: 10000 });
  } catch (err) {
    throw new Error('Extension send button (button#ql-send) not clickable: ' + err.message);
  }

  console.log('[Browser] ✅ Prompt submitted via webpage floating UI.');
  await page.waitForTimeout(1500);
}

/**
 * #8: Optimized observer — uses targeted selectors instead of scanning all DOM elements.
 * #11: Consecutive error breaker — forces isProcessing=false after 3 consecutive scan failures.
 * 
 * Observes Lovable DOM for build progress, questions, and completion.
 * @param {object} session
 * @param {function} onUpdate - (statusText, fileOps[], progressText, terminalLogs) => void
 * @param {function} onQuestion - (questionText, options[]) => void
 * @param {function} onFinished - (url, fullResponse) => void
 * @param {function} onTimeout - () => void
 */
export async function observeBuild(session, onUpdate, onQuestion, onFinished, onTimeout) {
  const { page } = session;
  if (!page) return;

  console.log('[Observer] Starting build observation...');
  let lastHash = '';
  let questionActive = false;
  let consecutiveErrors = 0; // #11: Error counter
  const MAX_OBSERVE_MS = 5 * 60 * 1000;
  const MAX_CONSECUTIVE_ERRORS = 3; // #11: Breaker threshold
  const startTime = Date.now();

  while (session.isProcessing) {
    if (Date.now() - startTime > MAX_OBSERVE_MS) {
      console.log('[Observer] 5-minute timeout reached.');
      session.isProcessing = false;
      if (onTimeout) await onTimeout();
      break;
    }

    await page.waitForTimeout(2500);
    if (!session.isProcessing) break;

    try {
      // #8: Optimized — targeted selectors, no full-page div scan
      const scanData = await page.evaluate(() => {
        // 1. Deployment URL — only scan anchor elements
        const previewAnchor = Array.from(document.querySelectorAll('a[href*=".lovable.app"]'))
          .find(a => !a.getAttribute('href').includes('lovable.dev/'));
        const finishedUrl = previewAnchor ? previewAnchor.getAttribute('href') : null;

        // Also check for completion indicators beyond just preview URL
        const bodyText = document.body.innerText || '';
        const hasCompletionSignal = /changes deployed|build succeeded|successfully deployed/i.test(bodyText);

        // 2. Question dialogs — scan only buttons
        const choiceKeywords = ['yes', 'no', 'overwrite', 'skip', 'keep', 'replace', 'accept', 'deny', 'continue', 'approve', 'allow'];
        const optionButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
          const text = (btn.innerText || '').trim().toLowerCase();
          return text && text.length <= 25 && choiceKeywords.some(kw => text.includes(kw));
        });

        let questionPanel = null;
        if (optionButtons.length > 0) {
          const parent = optionButtons[0].parentElement;
          const qText = parent ? (parent.innerText || '').split('\n')[0] : 'Lovable requires confirmation:';
          questionPanel = {
            text: qText,
            options: optionButtons.map((btn, idx) => ({
              text: (btn.innerText || '').trim(),
              index: idx
            }))
          };
        }

        // 3. Step progress
        const progressMatch = bodyText.match(/Step (\d+) of (\d+)/i) || bodyText.match(/(\d+)\/(\d+)\s+steps/i);
        const progressText = progressMatch ? progressMatch[0] : '';

        // 4. File operations — scan only code elements and specific spans
        const filePattern = /[\w.-]+\.(tsx|ts|css|json|js|jsx|html|md)/i;
        const fileOps = [];
        const seenPaths = new Set();
        for (const el of document.querySelectorAll('code, span[class], p > code')) {
          const text = (el.innerText || '').trim();
          if (text.length < 4 || text.length > 80) continue;
          const match = text.match(/([\w.-]+\/[\w.-]+\.\w+)|([\w.-]+\.\w+)/);
          if (match && filePattern.test(match[0]) && !seenPaths.has(match[0])) {
            seenPaths.add(match[0]);
            const parentText = (el.parentElement?.innerText || '').toLowerCase();
            let op = 'edit';
            if (/create|new|add|generating/.test(parentText)) op = 'create';
            else if (/delete|remove/.test(parentText)) op = 'delete';
            fileOps.push({ path: match[0], op });
          }
        }

        // 5. Status text — scan only p, li, span (not every div)
        const keywords = ['applying', 'installing', 'creating', 'editing',
          'generating', 'npm run', 'compiling', 'updating', 'building', 'processing'];
        const progressEls = Array.from(document.querySelectorAll('p, li, span'))
          .filter(el => {
            const t = (el.innerText || '').trim().toLowerCase();
            return t.length > 3 && t.length < 100 && keywords.some(kw => t.includes(kw));
          });

        let statusText = '';
        if (progressEls.length > 0) {
          let card = progressEls[progressEls.length - 1];
          for (let i = 0; i < 4; i++) {
            if (card.parentElement && card.parentElement !== document.body) card = card.parentElement;
          }
          const clone = card.cloneNode(true);
          clone.querySelectorAll('pre, code, button, svg, style, script, textarea, input').forEach(e => e.remove());
          const lines = clone.innerText.split('\n').map(l => l.trim())
            .filter(l => l.length > 3 && !/project|account|share|thinking/i.test(l));
          statusText = [...new Set(lines)].slice(-6).join('\n');
        }

        // 6. Terminal / CLI logs — targeted selectors
        const termEls = Array.from(document.querySelectorAll('pre, [class*="terminal"], [class*="console"], [class*="logs"]'));
        let terminalLogs = '';
        const cliBlocks = termEls.map(el => (el.innerText || '').trim())
          .filter(t => t.length >= 15 && t.length <= 10000 && /npm|install|vite|build|transform|error|✓|failed|dist\//i.test(t));
        if (cliBlocks.length > 0) {
          terminalLogs = cliBlocks[cliBlocks.length - 1].split('\n')
            .map(l => l.trim()).filter(l => l.length > 0).slice(-12).join('\n');
        }

        return {
          finishedUrl,
          hasCompletionSignal,
          questionPanel,
          statusText,
          fileOps: fileOps.slice(0, 15),
          progressText,
          terminalLogs
        };
      });

      // Reset error counter on successful scan
      consecutiveErrors = 0;

      // Cache scan data
      session.lastScanData = scanData;

      // Finished — either preview URL found OR completion text detected
      if (scanData.finishedUrl || scanData.hasCompletionSignal) {
        const url = scanData.finishedUrl || '';
        console.log(`[Observer] Build complete. URL: ${url || '(no preview URL)'}`);
        
        // #9: Extract full response with targeted approach
        let fullResponse = '';
        try {
          fullResponse = await page.evaluate(() => {
            // Target the last large message block — look for the assistant's response area
            // Lovable renders responses in specific containers, look for the most recent one
            const candidates = Array.from(document.querySelectorAll('[class*="message"], [class*="response"], [class*="assistant"], [class*="chat"], [role="article"]'));
            
            let bestCard = null;
            let bestLength = 0;

            // If specific class selectors didn't work, fall back to finding large text blocks
            const searchPool = candidates.length > 0 
              ? candidates 
              : Array.from(document.querySelectorAll('div')).filter(d => d.children.length < 40 && d !== document.body);

            for (const div of searchPool) {
              const text = (div.innerText || '').trim();
              if (text.length > 100 && text.length < 15000 && text.length > bestLength) {
                const hasStructure = text.includes('•') || text.includes('-') || /^\d+\./m.test(text) ||
                  text.split('\n').filter(l => l.trim().length > 20).length >= 3;
                if (hasStructure) {
                  bestLength = text.length;
                  bestCard = div;
                }
              }
            }
            
            if (!bestCard) return '';
            
            const clone = bestCard.cloneNode(true);
            clone.querySelectorAll('button, svg, style, script, textarea, input, nav').forEach(e => e.remove());
            
            const lines = [];
            const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
            let node;
            const seen = new Set();
            
            while ((node = walker.nextNode())) {
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.nodeValue.trim();
                if (text.length > 2 && !seen.has(text)) {
                  seen.add(text);
                  const parent = node.parentElement;
                  const tag = parent?.tagName?.toLowerCase() || '';
                  if (tag === 'li') lines.push(`• ${text}`);
                  else if (/^h[1-3]$/.test(tag)) lines.push(`\n📌 ${text}`);
                  else if (tag === 'code' || tag === 'pre') lines.push(`  ${text}`);
                  else lines.push(text);
                }
              }
            }
            
            const deduped = [];
            for (const line of lines) {
              if (deduped.length === 0 || deduped[deduped.length - 1] !== line) deduped.push(line);
            }
            return deduped.join('\n');
          });
        } catch (err) {
          console.warn('[Observer] Response extraction failed:', err.message);
        }
        
        session.isProcessing = false;
        await onFinished(url, fullResponse);
        break;
      }

      // Question
      if (scanData.questionPanel && !questionActive) {
        questionActive = true;
        session.activeQuestionOptions = scanData.questionPanel.options;
        await onQuestion(scanData.questionPanel.text, scanData.questionPanel.options);
      }

      // Status update
      if (!scanData.questionPanel) {
        const displayStatus = scanData.statusText || (scanData.fileOps.length > 0 ? 'Processing files...' : '');
        const hash = JSON.stringify({
          s: displayStatus,
          f: scanData.fileOps.length,
          t: scanData.terminalLogs.length,
          p: scanData.progressText
        });

        if (hash !== lastHash) {
          lastHash = hash;
          await onUpdate(displayStatus, scanData.fileOps, scanData.progressText, scanData.terminalLogs);
        }
      }

      // Reset question lock
      if (!scanData.questionPanel && questionActive) {
        questionActive = false;
        session.activeQuestionOptions = null;
      }

    } catch (err) {
      consecutiveErrors++;
      console.warn(`[Observer] Scan error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
      
      // #11: Break out after 3 consecutive failures — page is probably dead
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[Observer] Too many consecutive errors. Force-stopping observer.');
        session.isProcessing = false;
        if (onTimeout) await onTimeout();
        break;
      }
    }
  }
}

/**
 * #2: Uses Playwright's native locator.click() instead of page.evaluate(btn.click()).
 * Clicks an interactive option button by matching its text content (self-healing).
 */
export async function clickOptionButton(session, buttonText) {
  const { page } = session;
  if (!page) throw new Error('No active page.');

  console.log(`[Browser] Clicking option: "${buttonText}"...`);

  // #2: Use Playwright native locator — fires React event handlers correctly
  try {
    const btn = page.locator('button').filter({ hasText: new RegExp(buttonText, 'i') }).first();
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click();
      console.log('[Browser] Option clicked via Playwright locator.');
      return;
    }
  } catch {}

  // Fallback: try exact text match with getByRole
  try {
    await page.getByRole('button', { name: buttonText, exact: false }).first().click();
    console.log('[Browser] Option clicked via getByRole.');
    return;
  } catch {}

  throw new Error(`Button "${buttonText}" not found in DOM.`);
}

/**
 * Captures a screenshot. Saves to OS temp directory.
 */
export async function takeBrowserScreenshot(session) {
  if (!session.page) throw new Error('No active page.');
  const filePath = path.join(os.tmpdir(), `lovable-screenshot-${Date.now()}.png`);
  await session.page.screenshot({ path: filePath });
  return filePath;
}
