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

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[browser]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err));

  console.time('page decode');
  await page.goto(`http://127.0.0.1:${port}/test.html`);
  await page.waitForFunction('window.__done === true', { timeout: 120000 });
  console.timeEnd('page decode');

  const error = await page.evaluate('window.__error');
  if (error) {
    console.error('Decode failed in browser:', error);
    process.exitCode = 1;
  } else {
    const meta = await page.evaluate('window.__meta');
    const imgMeta = await page.evaluate('window.__imgMeta');
    const dataUrl = await page.evaluate('window.__dataUrl');
    console.log('metadata:', meta);
    console.log('imageData meta:', imgMeta);

    const base64 = dataUrl.split(',')[1];
    await writeFile('./preview.jpg', Buffer.from(base64, 'base64'));
    console.log('wrote preview.jpg');
  }

  await browser.close();
} finally {
  server.kill();
}
