import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const appRoot = join(__dirname, '..');
const publicDir = join(appRoot, 'public');
const nodeModulesDir = join(appRoot, 'node_modules');

const HEADLESS = process.env.HEADLESS === '1';

if (HEADLESS) {
  app.commandLine.appendSwitch('headless', 'new');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath;
      if (urlPath.startsWith('/node_modules/')) {
        filePath = join(nodeModulesDir, urlPath.replace('/node_modules/', ''));
      } else {
        filePath = join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
      }
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          res.setHeader('Content-Type', mime[extname(filePath)] || 'application/octet-stream');
          createReadStream(filePath).pipe(res);
          return;
        }
      } catch {}
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let mainWindow;

async function createWindow() {
  const server = await startStaticServer();
  const port = server.address().port;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !HEADLESS,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
  return mainWindow;
}

ipcMain.handle('dialog:openArw', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open RAW file',
    filters: [{ name: 'Sony RAW', extensions: ['arw', 'ARW'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const buf = await readFile(filePath);
  return { name: basename(filePath), path: filePath, data: new Uint8Array(buf) };
});

ipcMain.handle('dialog:saveImage', async (_event, dataUrl, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export image',
    defaultPath: suggestedName || 'edited.jpg',
    filters: [{ name: 'JPEG', extensions: ['jpg'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const base64 = dataUrl.split(',')[1];
  await writeFile(result.filePath, Buffer.from(base64, 'base64'));
  return result.filePath;
});

app.whenReady().then(async () => {
  const win = await createWindow();

  const testArwPath = process.env.TEST_ARW_PATH;
  if (HEADLESS && testArwPath) {
    try {
      const buf = await readFile(testArwPath);
      const base64 = buf.toString('base64');
      await win.webContents.executeJavaScript(`
        (async () => {
          const b64 = ${JSON.stringify(base64)};
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          await window.__testOpenBytes(bytes);
        })();
      `);
      const statusText = await win.webContents.executeJavaScript("document.getElementById('status').textContent");
      console.log('STATUS AFTER OPEN:', statusText);

      const baselineShot = await win.webContents.capturePage();
      await writeFile(join(appRoot, 'test_baseline.png'), baselineShot.toPNG());

      const baselineDataUrl = await win.webContents.executeJavaScript('window.__testCapture()');
      await writeFile(join(appRoot, 'test_baseline_full.jpg'), Buffer.from(baselineDataUrl.split(',')[1], 'base64'));

      await win.webContents.executeJavaScript(`
        window.__testSetSlider('exposure', 0.3);
        window.__testSetSlider('contrast', 0.15);
        window.__testSetSlider('vibrance', 0.3);
      `);
      await new Promise((r) => setTimeout(r, 300));

      const editedShot = await win.webContents.capturePage();
      await writeFile(join(appRoot, 'test_edited.png'), editedShot.toPNG());

      const editedDataUrl = await win.webContents.executeJavaScript('window.__testCapture()');
      await writeFile(join(appRoot, 'test_edited_full.jpg'), Buffer.from(editedDataUrl.split(',')[1], 'base64'));

      console.log('HEADLESS TEST OK');
    } catch (err) {
      console.error('HEADLESS TEST FAILED', err);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
