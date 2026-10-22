'use strict';
// 本地预览用的静态服务器：node scripts/serve.cjs [端口]
// 只监听 127.0.0.1，只提供本目录下的文件。带 CORS 头，方便开发时把脚本加载进 B 站页面调试。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return res.writeHead(400).end();
  }
  const file = path.resolve(ROOT, `.${rel.endsWith('/') ? `${rel}index.html` : rel}`);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`bili-live-ledger: http://localhost:${PORT}/`);
});
