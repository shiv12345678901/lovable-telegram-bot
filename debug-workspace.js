import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

async function runDebug() {
  console.log('Starting Lovable workspace page diagnosis...');
  const cookieValue = process.env.LOVABLE_SESSION_COOKIE;
  const workspaceUrl = 'https://lovable.dev/projects/900f228d-d0c3-492e-ad6e-ce1a52f546e6';
  
  if (!cookieValue || cookieValue === 'your_session_cookie_value_here') {
    console.error('Error: LOVABLE_SESSION_COOKIE is not set inside the .env file!');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });

  // Inject Cookie
  await context.addCookies([
    {
      name: 'lovable-session-id-v2',
      value: cookieValue,
      domain: '.lovable.dev',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }
  ]);

  const page = await context.newPage();
  console.log(`Navigating to workspace: ${workspaceUrl}...`);
  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wait 10 seconds for the workspace SPA to fully load
  console.log('Waiting 10 seconds for workspace loading...');
  await page.waitForTimeout(10000);

  const url = page.url();
  console.log(`Current Page URL: ${url}`);

  // Take screenshot
  await page.screenshot({ path: 'workspace-debug.png', fullPage: true });
  console.log('Screenshot saved to workspace-debug.png');

  // Dump HTML
  const html = await page.content();
  fs.writeFileSync('workspace-debug.html', html);
  console.log('HTML content saved to workspace-debug.html');

  // Find all textareas, inputs, and editable divs
  const inputs = await page.evaluate(() => {
    const textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({
      tagName: 'TEXTAREA',
      id: t.id,
      className: t.className,
      placeholder: t.getAttribute('placeholder'),
      value: t.value
    }));

    const editableDivs = Array.from(document.querySelectorAll('[contenteditable="true"]')).map(d => ({
      tagName: 'DIV[contenteditable]',
      id: d.id,
      className: d.className,
      text: d.innerText.substring(0, 100)
    }));

    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
      tagName: 'INPUT',
      id: i.id,
      type: i.type,
      className: i.className,
      placeholder: i.getAttribute('placeholder')
    }));

    return [...textareas, ...editableDivs, ...inputs];
  });

  console.log('Found Input elements in workspace:', inputs);

  await browser.close();
  console.log('Diagnosis complete.');
}

runDebug().catch(console.error);
