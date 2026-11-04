import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dir = mkdtempSync(path.join(tmpdir(), 'vvs-'));
const keyPath = path.join(dir, 'private.key');
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
process.env.VONAGE_PRIVATE_KEY_PATH = keyPath;
process.env.VONAGE_APPLICATION_ID = '00000000-0000-0000-0000-000000000000';
process.env.DEMO_ACCESS_KEY = 'secret';

const { issueTicket, verifyTicket } = await import('../backend/ticket.js');
const { handler } = await import('../backend/handler.js');

test('ticket roundtrip and tamper detection', async () => {
  const tk = await issueTicket('demo');
  assert.equal((await verifyTicket(tk)).room, 'demo');
  assert.equal(await verifyTicket(`${tk.split('.')[0]}.AAAA`), null);
  assert.equal(await verifyTicket('garbage'), null);
});

const call = (path, body) => handler({ rawPath: path, requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) });

test('join rejects wrong access key / bad input without calling Vonage', async () => {
  assert.equal((await call('/api/join', { name: 'a', lang: 'ja', key: 'x' })).statusCode, 403);
  assert.equal((await call('/api/join', { name: '', lang: 'ja', key: 'secret' })).statusCode, 400);
  assert.equal((await call('/api/join', { name: 'a', lang: 'fr', key: 'secret' })).statusCode, 400);
  assert.equal((await call('/api/join', { name: 'a', lang: 'ja', key: 'secret', room: '../x' })).statusCode, 400);
});

test('translate / transcribe-url require a ticket', async () => {
  assert.equal((await call('/api/translate', { text: 'hi', from: 'en', to: ['ja'] })).statusCode, 401);
  assert.equal((await call('/api/transcribe-url', { lang: 'ja' })).statusCode, 401);
  assert.equal((await call('/api/nope', {})).statusCode, 404);
});

test('translate ignores non-string targets (no Bedrock call for [["en"], ...])', async () => {
  const ticket = await issueTicket('demo');
  const res = await call('/api/translate', { text: 'こんにちは', from: 'ja', to: [['en'], ['en'], { 0: 'en' }], ticket });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).translations, {});
});

test('join fails closed when DEMO_ACCESS_KEY is not configured', async () => {
  const { config } = await import('../backend/config.js');
  const saved = config.accessKey;
  config.accessKey = '';
  try {
    const res = await call('/api/join', { name: 'a', lang: 'ja', key: '' });
    assert.equal(res.statusCode, 503);
  } finally {
    config.accessKey = saved;
  }
});
