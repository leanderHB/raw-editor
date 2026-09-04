import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(appRoot, 'public');
const nodeModulesDir = join(appRoot, 'node_modules');

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

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

const port = process.env.PORT || 8935;
server.listen(port, '127.0.0.1', () => {
  console.log(`RAW editor running at http://127.0.0.1:${port}`);
});
