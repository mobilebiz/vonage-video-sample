// 実 AWS を使う結合テスト（課金あり・数円未満）。Vonage には接続しない。
//   AWS_PROFILE=kwc-v4g node test/integration.js <ja.wav> <en.wav>
// - Bedrock 翻訳 (/api/translate)
// - Transcribe Streaming: /api/transcribe-url の署名付き URL に、ブラウザと同じエンコーダで 16kHz PCM を送る
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeAudioEvent, decodeMessage } from '../frontend/eventstream.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPath = path.join(mkdtempSync(path.join(tmpdir(), 'vvs-')), 'private.key');
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
process.env.VONAGE_PRIVATE_KEY_PATH = keyPath;
process.env.VONAGE_APPLICATION_ID = 'dummy';
process.env.AWS_REGION ||= 'ap-northeast-1';

const { handler } = await import('../backend/handler.js');
const { issueTicket } = await import('../backend/ticket.js');
const ticket = await issueTicket('demo');
const call = async (p, body) => {
  const r = await handler({ rawPath: p, requestContext: { http: { method: 'POST' } }, body: JSON.stringify({ ...body, ticket }) });
  if (r.statusCode !== 200) throw new Error(`${p} ${r.statusCode} ${r.body}`);
  return JSON.parse(r.body);
};

function wavPcm(file) {
  const b = readFileSync(file);
  let off = 12;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return new Uint8Array(b.subarray(off + 8, off + 8 + size));
    off += 8 + size;
  }
  throw new Error('no data chunk');
}

async function transcribe(lang, file) {
  const { url } = await call('/api/transcribe-url', { lang });
  const pcm = wavPcm(file);
  const finals = [];
  let partials = 0;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = async () => {
      const chunk = 3200; // 100ms
      for (let i = 0; i < pcm.length; i += chunk) {
        ws.send(encodeAudioEvent(pcm.subarray(i, i + chunk)));
        await new Promise((r) => setTimeout(r, 100));
      }
      // 無音を少し送ってから終了
      for (let i = 0; i < 10; i++) { ws.send(encodeAudioEvent(new Uint8Array(3200))); await new Promise((r) => setTimeout(r, 100)); }
      ws.send(encodeAudioEvent(new Uint8Array(0)));
    };
    ws.onmessage = (e) => {
      const m = decodeMessage(e.data);
      if (m.headers[':message-type'] === 'exception') { reject(new Error(JSON.stringify(m.json()))); return; }
      for (const r of m.json().Transcript?.Results || []) {
        if (r.IsPartial) partials++; else finals.push(r.Alternatives[0].Transcript);
      }
    };
    ws.onerror = (e) => reject(new Error(`ws error ${e.message || ''}`));
    ws.onclose = () => resolve();
  });
  return { finals, partials };
}

const t0 = Date.now();
const ja = await transcribe('ja', process.argv[2]);
console.log('[transcribe ja]', ja);
const en = await transcribe('en', process.argv[3]);
console.log('[transcribe en]', en);

let t = Date.now();
const tr1 = await call('/api/translate', { text: ja.finals.join(''), from: 'ja', to: ['en'] });
console.log('[translate ja→en]', tr1, `${Date.now() - t}ms`);
t = Date.now();
const tr2 = await call('/api/translate', {
  text: en.finals.join(' '), from: 'en', to: ['ja'],
  context: [{ name: '山田', text: ja.finals.join('') }],
});
console.log('[translate en→ja]', tr2, `${Date.now() - t}ms`);
console.log(`total ${Date.now() - t0}ms`);
