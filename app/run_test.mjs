import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const port = 8935;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port) },
  stdio: 'inherit',
});

await new Promise((r) => setTimeout(r, 500));

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (msg) => console.log('[browser]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err));

  await page.goto(`http://127.0.0.1:${port}/`);

  const arwPath = '/home/leander/Documents/image_editor_simple/DSC03250.ARW';
  const buf = await readFile(arwPath);
  const base64 = buf.toString('base64');

  console.time('decode via app.js');
  await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await window.__testOpenBytes(bytes);
  }, base64);
  console.timeEnd('decode via app.js');

  const status = await page.evaluate(() => document.getElementById('status').textContent);
  console.log('status:', status);

  const baselineUrl = await page.evaluate(() => window.__testCapture());
  await writeFile('./test_baseline.jpg', Buffer.from(baselineUrl.split(',')[1], 'base64'));

  await page.evaluate(() => {
    window.__testSetSlider('exposure', 0.3);
    window.__testSetSlider('contrast', 0.15);
    window.__testSetSlider('vibrance', 0.3);
  });
  await page.waitForTimeout(200);

  const editedUrl = await page.evaluate(() => window.__testCapture());
  await writeFile('./test_edited.jpg', Buffer.from(editedUrl.split(',')[1], 'base64'));

  await page.screenshot({ path: './test_ui.png' });
  console.log('wrote test_baseline.jpg, test_edited.jpg, test_ui.png');

  await browser.close();
} finally {
  server.kill();
}
