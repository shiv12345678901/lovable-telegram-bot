import { chromium } from 'playwright';
import os from 'os';
import path from 'path';

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

  console.log('[Browser] Launching headless Chromium...');
  session.browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security'
    ]
  });

  // #10: Browser crash recovery — auto-clean session on disconnect
  session.browser.on('disconnected', () => {
    console.error('[Browser] ⚠️ Chromium process disconnected unexpectedly!');
    session.browser = null;
    session.context = null;
    session.page = null;
    session.isProcessing = false;
  });

  session.context = await session.browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { longitude: -74.006, latitude: 40.7128 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  // Inject anti-detection script to hide webdriver flag
  await session.context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
    // Overwrite Chrome window properties
    window.chrome = {
      runtime: {}
    };
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

  session.page = await session.context.newPage();
  console.log('[Browser] Ready.');
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
  if (!session.page) await initBrowser(session);
  await closeLeakedTabs(session);

  console.log('[Browser] Navigating to dashboard...');
  await session.page.goto('https://lovable.dev/dashboard', { waitUntil: 'load', timeout: 45000 });

  const currentUrl = session.page.url();
  console.log(`[Browser] URL: ${currentUrl}`);

  if (currentUrl.includes('/sign-in') || currentUrl.includes('/login')) {
    throw new Error('Session cookie expired. Please update LOVABLE_SESSION_COOKIE.');
  }

  // #6: Smart wait — wait for actual project links to render, fallback to 3s
  try {
    await session.page.waitForSelector('a[href*="/projects/"]', { timeout: 8000 });
  } catch {
    await session.page.waitForTimeout(3000);
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
}

/**
 * #7: Smart wait — waits for editor element instead of blind 5s timeout.
 * Opens a specific project workspace.
 */
export async function openProjectWorkspace(session, projectUrl) {
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
}

/**
 * #5: Chunk typing — types in word-sized chunks (5x faster than char-by-char).
 * Types prompt into editor and clicks submit.
 */
export async function submitPrompt(session, promptText) {
  const { page } = session;
  if (!page) throw new Error('No active page. Select a project first.');

  const inputSelector = 'div[contenteditable="true"], textarea';
  try {
    await page.waitForSelector(inputSelector, { visible: true, timeout: 20000 });
  } catch {
    throw new Error('Could not locate the prompt input box.');
  }

  const promptInput = page.locator(inputSelector).first();

  // Anti-bot: mouse movement
  try {
    const box = await promptInput.boundingBox();
    if (box) {
      const tx = box.x + Math.random() * box.width;
      const ty = box.y + Math.random() * box.height;
      await page.mouse.move(tx - 80 + Math.random() * 40, ty - 80 + Math.random() * 40);
      await page.waitForTimeout(80);
      await page.mouse.move(tx, ty, { steps: 5 });
      await page.waitForTimeout(80);
    }
  } catch {}

  await promptInput.focus();
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);

  // #5: Chunk typing — type in word-sized chunks with random pauses between chunks
  // ~5x faster than char-by-char while still appearing human-like
  const words = promptText.split(/(\s+)/); // Split preserving whitespace
  for (const word of words) {
    if (word.length === 0) continue;
    // Type entire word/chunk at once with slight per-key delay
    await page.keyboard.type(word, { delay: 8 });
    // Random pause between chunks (30-120ms)
    await page.waitForTimeout(30 + Math.floor(Math.random() * 90));
  }

  await page.waitForTimeout(800);

  // Click submit button using Playwright's native click
  let submitted = false;

  try {
    const submitBtn = page.locator('button[type="submit"]').first();
    if (await submitBtn.isVisible({ timeout: 2000 })) {
      await submitBtn.click();
      submitted = true;
      console.log('[Browser] Clicked button[type="submit"]');
    }
  } catch {}

  if (!submitted) {
    try {
      const sendButtons = page.locator('button:has(svg)');
      const count = await sendButtons.count();
      if (count > 0) {
        const lastBtn = sendButtons.nth(count - 1);
        if (await lastBtn.isVisible({ timeout: 1000 })) {
          await lastBtn.click();
          submitted = true;
          console.log('[Browser] Clicked last SVG button');
        }
      }
    } catch {}
  }

  if (!submitted) {
    console.log('[Browser] No submit button found. Trying Ctrl+Enter...');
    await page.keyboard.press('Control+Enter');
  }

  // Post-submit verification
  await page.waitForTimeout(2000);
  const editorCleared = await page.evaluate(() => {
    const editor = document.querySelector('div[contenteditable="true"], textarea');
    if (!editor) return true;
    const text = (editor.innerText || editor.value || '').trim();
    return text.length === 0 || text.length < 5;
  });

  if (editorCleared) {
    console.log('[Browser] ✅ Prompt accepted — editor cleared.');
  } else {
    console.log('[Browser] ⚠️ Editor still has text. Trying Ctrl+Enter fallback...');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(1000);
  }

  console.log('[Browser] Prompt submission complete.');
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
