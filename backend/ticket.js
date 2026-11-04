// /api/join で発行し、/api/translate・/api/transcribe-url の呼び出しを入室者に限定するための署名付きチケット。
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { getPrivateKey } from './config.js';

async function secret() {
  // 専用の秘密を別管理しなくて済むよう、Vonage 秘密鍵から HMAC 鍵を導出する
  return createHash('sha256').update('ticket:').update(await getPrivateKey()).digest();
}

/** @param {number} expSec 有効期限（UNIX 秒）。会議の終了時刻に合わせる */
export async function issueTicket(room, expSec = Math.floor(Date.now() / 1000) + 300) {
  const payload = Buffer.from(JSON.stringify({ room, exp: expSec })).toString('base64url');
  const sig = createHmac('sha256', await secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export async function verifyTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket.includes('.')) return null;
  const [payload, sig] = ticket.split('.');
  const expected = createHmac('sha256', await secret()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (data.exp < Date.now() / 1000) return null;
  return data;
}
