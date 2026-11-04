// 会議時間・強制退出のロジックを、Vonage の HTTP API をモックにして確認する（ネットワーク不要）
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPath = path.join(mkdtempSync(path.join(tmpdir(), 'vvs-')), 'private.key');
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
process.env.VONAGE_PRIVATE_KEY_PATH = keyPath;
process.env.VONAGE_APPLICATION_ID = '00000000-0000-0000-0000-000000000000';
process.env.DEMO_ACCESS_KEY = 'secret-key';
delete process.env.ROOM_PARAM_PREFIX;
delete process.env.MEETING_PARAM_PREFIX;
delete process.env.SCHEDULER_ROLE_ARN;

// ---- Vonage API のモック
const vonage = { connections: [], deleteStatus: () => 204, deleted: [], listCalls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname.endsWith('/session/create')) return json(200, [{ session_id: 'S1' }]);
  const m = url.pathname.match(/\/connection(?:\/([^/]+))?$/);
  if (m && method === 'GET') {
    vonage.listCalls++;
    const offset = Number(url.searchParams.get('offset') || 0);
    const count = Number(url.searchParams.get('count') || 50);
    return json(200, { count: vonage.connections.length, items: vonage.connections.slice(offset, offset + count) });
  }
  if (m && m[1] && method === 'DELETE') {
    const status = vonage.deleteStatus(m[1]);
    if (status < 300) vonage.deleted.push(m[1]);
    return new Response(null, { status });
  }
  return realFetch(input, init);
};

const { handler } = await import('../backend/handler.js');
const { endMeeting } = await import('../backend/meeting.js');
const { listConnections } = await import('../backend/vonage.js');
const { config } = await import('../backend/config.js');

let now = 1_800_000_000_000;
Date.now = () => now;
let roomSeq = 0;
let room;

beforeEach(() => {
  vonage.connections = [];
  vonage.deleted = [];
  vonage.deleteStatus = () => 204;
  room = `room${++roomSeq}`; // テストごとに別ルーム（メモリ上の会議状態を分ける）
});

const join = async (name = 'a') => {
  const r = await handler({ rawPath: '/api/join', requestContext: { http: { method: 'POST' } }, body: JSON.stringify({ name, lang: 'ja', room, key: 'secret-key' }) });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const conn = (id, createdAt) => ({ connectionId: id, connectionState: 'Connected', createdAt });

test('同じ会議に途中参加した人は同じ終了時刻を受け取る', async () => {
  const first = await join('a');
  assert.equal(first.status, 200);
  vonage.connections = [conn('c1', now)];
  now += 60_000;
  const second = await join('b');
  assert.equal(second.body.meeting.endsAt, first.body.meeting.endsAt);
  assert.equal(first.body.meeting.endsAt - (now - 60_000), config.meetingMaxSeconds * 1000);
});

test('全員が退出したあとの入室は新しい会議になる', async () => {
  const first = await join('a');
  now += 30_000; // 猶予 15 秒を過ぎ、接続 0
  const second = await join('b');
  assert.ok(second.body.meeting.endsAt > first.body.meeting.endsAt);
});

test('トークンの期限は会議の終了時刻を超えない', async () => {
  const first = await join('a');
  vonage.connections = [conn('c1', now)];
  now += (config.meetingMaxSeconds - 30) * 1000; // 残り 30 秒
  const r = await join('b');
  const claims = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url'));
  assert.ok(claims.exp <= Math.floor(first.body.meeting.endsAt / 1000));
  now += 25_000; // 残り 5 秒
  assert.equal((await join('c')).body.error, 'meeting_ending');
});

test('終了処理は、終了時刻より後に始まった次の会議の接続を切らない', async () => {
  const first = await join('a');
  const { endsAt } = first.body.meeting;
  vonage.connections = [conn('old', endsAt - 100_000), conn('new', endsAt + 2_000)];
  now = endsAt + 3_000;
  // 状態上はまだ旧会議（meetingId 一致）のまま終了処理が走るケース
  const res = await endMeetingFor(room);
  assert.deepEqual(vonage.deleted, ['old']);
  assert.equal(res.disconnected, 1);
});

test('切断 API の一時エラーは例外にして再試行させる（404 は成功扱い）', async () => {
  await join('a');
  vonage.connections = [conn('gone', now), conn('busy', now)];
  now += config.meetingMaxSeconds * 1000;
  vonage.deleteStatus = (id) => (id === 'gone' ? 404 : 503);
  await assert.rejects(endMeetingFor(room), /disconnect failed for 1\/2/);
  vonage.deleteStatus = () => 204;
  const ok = await endMeetingFor(room);
  assert.equal(ok.disconnected, 2);
});

test('古い終了スケジュールは無視される', async () => {
  await join('a');
  const r = await endMeeting({ room, meetingId: 'not-current' });
  assert.equal(r.disconnected, 0);
});

test('接続一覧は全ページ取得する', async () => {
  vonage.connections = Array.from({ length: 2500 }, (_, i) => conn(`c${i}`, now));
  vonage.listCalls = 0;
  const list = await listConnections('S1');
  assert.equal(list.length, 2500);
  assert.equal(vonage.listCalls, 3);
});

// 現在の会議の meetingId で endMeeting を呼ぶ（Scheduler の Input と同じ形）
async function endMeetingFor(r) {
  const { _currentMeetingId } = await import('../backend/meeting.js');
  return endMeeting({ room: r, meetingId: await _currentMeetingId(r) });
}
