// Vonage Video API: ルーム(セッション)の取得/作成、トークン発行、在室人数の確認
import { Auth } from '@vonage/auth';
import { Video, MediaMode } from '@vonage/video';
import { tokenGenerate } from '@vonage/jwt';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { config, ssm, getPrivateKey } from './config.js';

const VIDEO_HOST = 'https://video.api.vonage.com';
let videoClient;
const memoryRooms = new Map();

async function client() {
  if (!videoClient) {
    videoClient = new Video(new Auth({ applicationId: config.applicationId, privateKey: await getPrivateKey() }));
  }
  return videoClient;
}

// ルーム名 → sessionId の対応を保存する（Lambda では SSM、ローカルではメモリ）
async function loadSessionId(room) {
  if (!config.roomParamPrefix) return memoryRooms.get(room);
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${config.roomParamPrefix}/${room}` }));
    return res.Parameter.Value;
  } catch (e) {
    if (e.name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

async function saveSessionId(room, sessionId) {
  if (!config.roomParamPrefix) {
    memoryRooms.set(room, sessionId);
    return sessionId;
  }
  try {
    await ssm.send(new PutParameterCommand({
      Name: `${config.roomParamPrefix}/${room}`, Value: sessionId, Type: 'String', Overwrite: false,
    }));
    return sessionId;
  } catch (e) {
    // 同時に作成された場合は先に保存された方を使う
    if (e.name === 'ParameterAlreadyExists') return loadSessionId(room);
    throw e;
  }
}

export async function getOrCreateSession(room) {
  const existing = await loadSessionId(room);
  if (existing) return existing;
  const session = await (await client()).createSession({ mediaMode: MediaMode.ROUTED });
  return saveSessionId(room, session.sessionId);
}

/**
 * @param {number} expireTime トークンの有効期限（UNIX 秒）。Vonage は接続時にだけ検証するので、
 *   「発行から短時間」かつ「会議の終了時刻まで」に収めて、終了後に接続できないようにする
 */
export async function generateToken(sessionId, { name, lang }, expireTime) {
  return (await client()).generateClientToken(sessionId, {
    role: 'publisher',
    data: JSON.stringify({ name, lang }),
    expireTime,
  });
}

// 現在の接続（Connected + Connecting）。SDK にメソッドが無いので REST を直接呼ぶ。
// 強制切断で取りこぼさないよう、全ページを取得する
export async function listConnections(sessionId) {
  const jwt = tokenGenerate(config.applicationId, await getPrivateKey());
  const base = `${VIDEO_HOST}/v2/project/${config.applicationId}/session/${encodeURIComponent(sessionId)}/connection`;
  const PAGE = 1000; // API の上限
  const all = [];
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const res = await fetch(`${base}?offset=${offset}&count=${PAGE}`, { headers: { Authorization: `Bearer ${jwt}` } });
    if (res.status === 404) return all;
    if (!res.ok) throw new Error(`list connections failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const items = body.items || [];
    all.push(...items);
    if (items.length < PAGE || all.length >= (body.count ?? 0)) break;
  }
  return all;
}

/**
 * 接続を強制的に退出させる。すでに切断済み (404) は成功扱い。
 * それ以外の失敗は例外にして呼び出し元（Scheduler の再試行）に伝える。
 */
export async function disconnectConnections(sessionId, connections) {
  const video = await client();
  const results = await Promise.allSettled(connections.map((c) => video.disconnectClient(sessionId, c.connectionId)));
  const failed = results.filter((r) => r.status === 'rejected' && r.reason?.response?.status !== 404);
  if (failed.length) {
    throw new Error(`disconnect failed for ${failed.length}/${connections.length} connections: ${failed[0].reason}`);
  }
  return connections.length;
}
