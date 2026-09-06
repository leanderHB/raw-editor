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

let pageErrors = [];
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (msg) => { console.log('[console]', msg.text()); });
  page.on('pageerror', (err) => { pageErrors.push(err); console.error('[pageerror]', err); });

  await page.goto(`http://127.0.0.1:${port}/`);

  const arwPath = '/home/leander/Documents/image_editor_simple/batch_samples/DSC03286.ARW';

  // Go through the real file-input flow (not __testOpenBytes) so activeEntryId/imageEntries
  // get populated — the mode-switch handler depends on activeEntryId being set, same as any
  // real "Open RAW..." usage would.
  console.log('--- default mode (sonyA6300) via real file input ---');
  console.time('decode default');
  await page.setInputFiles('#fileInput', arwPath);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('sonyA6300'), { timeout: 30000 });
  console.timeEnd('decode default');
  console.log('status:', await page.evaluate(() => document.getElementById('status').textContent));
  await writeFile('./test_sonyA6300.jpg', Buffer.from((await page.evaluate(() => window.__testCapture())).split(',')[1], 'base64'));

  // Apply an edit, then switch modes and confirm the edit is preserved (keepEdits=true path)
  await page.evaluate(() => {
    window.__testSetSlider('exposure', 0.3);
    window.__testSetSlider('vibrance', 0.3);
  });
  await page.waitForTimeout(200);
  const exposureBeforeSwitch = await page.evaluate(() => document.getElementById('exposureVal').textContent);

  for (const mode of ['original', 'sonyA6300']) {
    console.log(`--- switching to ${mode} ---`);
    console.time(`switch to ${mode}`);
    await page.evaluate((m) => {
      const sel = document.getElementById('colorScienceSelect');
      sel.value = m;
      sel.dispatchEvent(new Event('change'));
    }, mode);
    // wait for status to reflect the new mode (decode + LUT apply is async)
    await page.waitForFunction((m) => document.getElementById('status').textContent.includes(m), mode, { timeout: 30000 });
    console.timeEnd(`switch to ${mode}`);
    console.log('status:', await page.evaluate(() => document.getElementById('status').textContent));
    const exposureNow = await page.evaluate(() => document.getElementById('exposureVal').textContent);
    console.log(`  exposure slider preserved: ${exposureNow === exposureBeforeSwitch} (${exposureNow})`);
    const shot = await page.evaluate(() => window.__testCapture());
    await writeFile(`./test_mode_${mode}.jpg`, Buffer.from(shot.split(',')[1], 'base64'));
  }

  await page.screenshot({ path: './test_color_science_ui.png' });
  console.log('done, pageErrors:', pageErrors.length);
  await browser.close();
} finally {
  server.kill();
}

if (pageErrors.length > 0) process.exit(1);
