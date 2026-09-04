import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const parentRoot = fileURLToPath(new URL('..', import.meta.url));

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.arw': 'application/octet-stream',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath;
  if (urlPath.startsWith('/arwfile/')) {
    filePath = join(parentRoot, normalize(urlPath.replace('/arwfile/', '')));
  } else {
    filePath = join(root, normalize(urlPath));
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

const port = process.env.PORT || 8934;
server.listen(port, '127.0.0.1', () => {
  console.log(`serving on http://127.0.0.1:${port}`);
});
