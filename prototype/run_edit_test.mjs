import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const port = 8934;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port) },
  stdio: 'inherit',
});

await new Promise((r) => setTimeout(r, 500));

async function saveCanvas(page, filename) {
  const dataUrl = await page.evaluate('window.__captureCanvas()');
  const base64 = dataUrl.split(',')[1];
  await writeFile(filename, Buffer.from(base64, 'base64'));
  console.log('wrote', filename);
}

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (msg) => console.log('[browser]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err));

  console.time('page load + decode + first render');
  await page.goto(`http://127.0.0.1:${port}/edit.html`);
  await page.waitForFunction('window.__ready === true', { timeout: 120000 });
  console.timeEnd('page load + decode + first render');

  const error = await page.evaluate('window.__error');
  if (error) {
    console.error('Failed:', error);
    process.exitCode = 1;
  } else {
    await saveCanvas(page, './edit_baseline.jpg');

    await page.evaluate("window.__setSlider('exposure', 0.8)");
    await page.evaluate("window.__setSlider('contrast', 0.3)");
    await page.evaluate("window.__setSlider('saturation', 0.4)");
    await page.evaluate("window.__setSlider('temperature', -0.2)");
    await page.evaluate("window.__setSlider('highlights', -0.4)");
    await page.evaluate("window.__setSlider('shadows', 0.3)");
    await page.evaluate("window.__setSlider('vignette', 0.5)");
    await page.waitForTimeout(200);
    await saveCanvas(page, './edit_pushed.jpg');

    await page.screenshot({ path: './edit_ui.png' });
    console.log('wrote ./edit_ui.png (full UI screenshot)');
  }

  await browser.close();
} finally {
  server.kill();
}
