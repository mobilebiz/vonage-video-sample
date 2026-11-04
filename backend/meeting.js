// 会議時間の管理。
// 「誰かが入室してから全員が退出するまで」を 1 回の会議とし、開始から MEETING_MAX_SECONDS（既定 180 秒）で終了させる。
//   - 開始時刻は SSM Parameter Store に保存（ローカル開発ではメモリ）
//   - 終了時刻に EventBridge Scheduler で Lambda を起動し、残っている接続を Vonage 側で強制切断する
//     （各端末も残り時間 0 で自分から退出するが、改造されたクライアントでも確実に切るためのサーバー側の保証）
import { randomBytes } from 'node:crypto';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import { config, ssm, region } from './config.js';
import { listConnections, disconnectConnections } from './vonage.js';

const scheduler = new SchedulerClient({ region });
const memoryMeetings = new Map();
// トークン発行直後でまだ Vonage に接続していない人がいる間は、接続数 0 でも同じ会議とみなす猶予
const JOIN_GRACE_MS = 15000;

async function loadMeeting(room) {
  if (!config.meetingParamPrefix) return memoryMeetings.get(room);
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${config.meetingParamPrefix}/${room}` }));
    return JSON.parse(res.Parameter.Value);
  } catch (e) {
    if (e.name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

async function saveMeeting(room, meeting) {
  if (!config.meetingParamPrefix) { memoryMeetings.set(room, meeting); return; }
  await ssm.send(new PutParameterCommand({
    Name: `${config.meetingParamPrefix}/${room}`, Value: JSON.stringify(meeting), Type: 'String', Overwrite: true,
  }));
}

async function scheduleEnd(room, meeting, functionArn) {
  if (!config.schedulerRoleArn || !functionArn) return; // ローカル開発
  const at = new Date(meeting.endsAt).toISOString().slice(0, 19); // yyyy-mm-ddThh:mm:ss (UTC)
  await scheduler.send(new CreateScheduleCommand({
    Name: `vvs-${room}-${meeting.meetingId}`,
    ScheduleExpression: `at(${at})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    ActionAfterCompletion: 'DELETE',
    Target: {
      Arn: functionArn,
      RoleArn: config.schedulerRoleArn,
      Input: JSON.stringify({ action: 'endMeeting', room, meetingId: meeting.meetingId }),
      RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 300 },
    },
  }));
}

async function startMeeting(room, sessionId, functionArn) {
  const now = Date.now();
  const meeting = {
    meetingId: randomBytes(6).toString('hex'),
    sessionId,
    startedAt: now,
    endsAt: now + config.meetingMaxSeconds * 1000,
  };
  // 先に終了スケジュールを登録してから保存する。登録に失敗したら会議は保存されず、入室も失敗する
  // （保存だけ残ると、強制退出のない会議に入室できてしまうため）
  await scheduleEnd(room, meeting, functionArn);
  await saveMeeting(room, meeting);
  console.log(JSON.stringify({ msg: 'meeting started', room, meetingId: meeting.meetingId, endsAt: new Date(meeting.endsAt).toISOString() }));
  return meeting;
}

/**
 * 入室時に呼ぶ。進行中の会議があればそれに参加し、なければ新しい会議を始める。
 * @returns {Promise<{meeting: object, connections: object[]}>}
 */
export async function joinMeeting(room, sessionId, functionArn) {
  let connections = await listConnections(sessionId);
  const current = await loadMeeting(room);
  const now = Date.now();
  const sameSession = current && current.sessionId === sessionId;

  if (sameSession && now < current.endsAt && (connections.length > 0 || now - current.startedAt < JOIN_GRACE_MS)) {
    return { meeting: current, connections };
  }
  if (sameSession && now >= current.endsAt && connections.length > 0) {
    // 時間切れなのに残っている接続（強制退出の取りこぼし）は切ってから新しい会議にする
    await disconnectConnections(sessionId, connectedBefore(connections, current.endsAt));
    connections = [];
  }
  return { meeting: await startMeeting(room, sessionId, functionArn), connections };
}

// 会議の終了時刻より前にできた接続だけを対象にする。
// 同じ Vonage セッションを使い回すため、終了処理と並行して始まった次の会議の参加者を巻き込まないようにする
const connectedBefore = (connections, endsAt) => connections.filter((c) => !(c.createdAt >= endsAt));

/** EventBridge Scheduler から終了時刻に呼ばれる。失敗したら例外を投げ、Scheduler に再試行させる */
export async function endMeeting({ room, meetingId }) {
  const current = await loadMeeting(room);
  if (!current || current.meetingId !== meetingId) {
    console.log(JSON.stringify({ msg: 'stale end schedule ignored', room, meetingId }));
    return { disconnected: 0 };
  }
  const targets = connectedBefore(await listConnections(current.sessionId), current.endsAt);
  const disconnected = await disconnectConnections(current.sessionId, targets);
  console.log(JSON.stringify({ msg: 'meeting ended', room, meetingId, disconnected }));
  return { disconnected };
}

/** テスト用: 現在の会議 ID */
export async function _currentMeetingId(room) {
  return (await loadMeeting(room))?.meetingId;
}
