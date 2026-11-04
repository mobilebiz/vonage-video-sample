// ローカル開発用サーバー: frontend/ を配信し、/api/* を Lambda ハンドラーに渡す。
// PC のブラウザで http://localhost:3000/ を開いて動作確認できる（localhost は HTTPS なしでもカメラ・マイクが使える）。
//   必要な環境変数: VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY_PATH, AWS_PROFILE (Bedrock/Transcribe 用)
import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
process.env.AWS_REGION ||= 'ap-northeast-1';
// ローカルではルーム情報をメモリに持つ
delete process.env.ROOM_PARAM_PREFIX;

const { handler } = await import('../backend/handler.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const out = await handler({
      rawPath: url.pathname,
      requestContext: { http: { method: req.method } },
      body: Buffer.concat(chunks).toString('utf8'),
      isBase64Encoded: false,
    });
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

http.createServer((req, res) => {
  // 不正なリクエストでプロセスが落ちないよう、処理全体で例外を捕捉する
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
// 既定はこの PC からのみ接続可能。LAN に公開したいときだけ HOST=0.0.0.0 を指定する
}).listen(port, host, () => console.log(`http://localhost:${port}/?${new URLSearchParams({ room: 'demo', k: process.env.DEMO_ACCESS_KEY || '' })}`));
