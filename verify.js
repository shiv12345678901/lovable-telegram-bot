import { chromium } from 'playwright';

async function verify() {
  console.log('Starting Playwright environment verification...');
  let browser;
  try {
    // Launch headless Chromium
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    console.log('Chromium browser launched successfully!');
    
    const context = await browser.newContext();
    const page = await context.newPage();
    
    console.log('Navigating to https://example.com...');
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    
    const title = await page.title();
    console.log(`Page title successfully retrieved: "${title}"`);
    
    // Take a screenshot to verify rendering works
    await page.screenshot({ path: 'verification-screenshot.png' });
    console.log('Screenshot saved to verification-screenshot.png');
    
    console.log('Verification completed successfully! The environment is fully functional.');
  } catch (error) {
    console.error('Playwright verification failed!');
    console.error(error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed.');
    }
  }
}

verify();
