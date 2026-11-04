// Lambda (Function URL) のエントリポイント。CloudFront の /api/* から呼ばれる。
//   POST /api/join            入室: Vonage トークンとチケットを発行（定員チェックあり）
//   POST /api/translate       字幕翻訳 (Bedrock)
//   POST /api/transcribe-url  Transcribe Streaming の署名付き URL を発行
// EventBridge Scheduler からは { action: 'endMeeting' } で呼ばれ、時間切れの会議の全員を退出させる
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { issueTicket, verifyTicket } from './ticket.js';
import { getOrCreateSession, generateToken } from './vonage.js';
import { joinMeeting, endMeeting } from './meeting.js';
import { translate } from './translate.js';
import { presignTranscribeUrl, SAMPLE_RATE } from './transcribe.js';

const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json', 'invalid JSON'); }
}

async function requireTicket(body) {
  const t = await verifyTicket(body.ticket);
  if (!t) throw new HttpError(401, 'unauthorized', 'invalid or expired ticket');
  return t;
}

const isLang = (l) => typeof l === 'string' && config.languages.includes(l);

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function join(body, context) {
  // キー未設定のまま公開されないよう、設定がなければ誰も入室させない（フェイルクローズ）
  if (!config.accessKey) throw new HttpError(503, 'not_configured', 'DEMO_ACCESS_KEY is not configured');
  if (typeof body.key !== 'string' || !safeEqual(body.key, config.accessKey)) {
    throw new HttpError(403, 'bad_key', 'access key is invalid');
  }
  const name = String(body.name || '').trim();
  const room = String(body.room || 'demo');
  if (!name || [...name].length > 20) throw new HttpError(400, 'bad_name', 'name must be 1-20 characters');
  if (!isLang(body.lang)) throw new HttpError(400, 'bad_lang', 'lang must be ja or en');
  if (!ROOM_RE.test(room)) throw new HttpError(400, 'bad_room', 'invalid room');

  const sessionId = await getOrCreateSession(room);
  const { meeting, connections } = await joinMeeting(room, sessionId, context?.invokedFunctionArn);
  if (connections.length >= config.maxParticipants) {
    throw new HttpError(409, 'room_full', `room is full (${config.maxParticipants})`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenExpire = Math.min(nowSec + config.tokenTtlSeconds, Math.floor(meeting.endsAt / 1000));
  if (tokenExpire - nowSec < 10) {
    // 終了間際は入室させない（少し待てば全員が退出し、新しい会議として入室できる）
    throw new HttpError(409, 'meeting_ending', 'the meeting is about to end; please retry in a few seconds');
  }
  return {
    applicationId: config.applicationId,
    sessionId,
    token: await generateToken(sessionId, { name, lang: body.lang }, tokenExpire),
    // 翻訳・文字起こしに使うチケットは会議の終了時刻（+猶予 60 秒）まで有効
    ticket: await issueTicket(room, Math.ceil(meeting.endsAt / 1000) + 60),
    maxParticipants: config.maxParticipants,
    meeting: { endsAt: meeting.endsAt, maxSeconds: config.meetingMaxSeconds, serverNow: Date.now() },
  };
}

async function translateRoute(body) {
  await requireTicket(body);
  const text = String(body.text || '').slice(0, 1000);
  if (!text.trim()) return { translations: {} };
  if (!isLang(body.from) || !Array.isArray(body.to)) throw new HttpError(400, 'bad_request', 'from/to required');
  // 文字列の ja/en 以外は捨てる（配列などを混ぜて Bedrock 呼び出しを増やされないように）
  const to = [...new Set(body.to.filter(isLang))].filter((l) => l !== body.from);
  if (!to.length) return { translations: {} };
  const context = Array.isArray(body.context)
    ? body.context.slice(-4).map((c) => ({ name: String(c.name || '').slice(0, 20), text: String(c.text || '').slice(0, 300) }))
    : [];
  return { translations: await translate({ text, from: body.from, to, context }) };
}

async function transcribeUrl(body) {
  await requireTicket(body);
  if (!isLang(body.lang)) throw new HttpError(400, 'bad_lang', 'lang must be ja or en');
  return { url: await presignTranscribeUrl(body.lang), sampleRate: SAMPLE_RATE };
}

const routes = {
  'POST /api/join': join,
  'POST /api/translate': translateRoute,
  'POST /api/transcribe-url': transcribeUrl,
};

export async function handler(event, context) {
  // Function URL 経由のリクエストには必ず requestContext がある。ない場合だけ内部呼び出し（Scheduler）として扱う
  if (!event.requestContext && event.action === 'endMeeting') {
    return endMeeting({ room: String(event.room), meetingId: String(event.meetingId) });
  }
  const method = event.requestContext?.http?.method;
  const path = event.rawPath;
  const route = routes[`${method} ${path}`];
  if (!route) return json(404, { error: 'not_found' });
  try {
    return json(200, await route(parseBody(event), context));
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
    console.error(e);
    return json(500, { error: 'internal', message: 'internal error' });
  }
}
