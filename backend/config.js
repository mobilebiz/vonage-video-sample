// 実行環境ごとの設定と秘密情報の読み込み。
// - Lambda: 秘密鍵は SSM Parameter Store (SecureString) から取得
// - ローカル: VONAGE_PRIVATE_KEY_PATH のファイルから取得
import { readFile } from 'node:fs/promises';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

export const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-northeast-1';
export const ssm = new SSMClient({ region });

export const config = {
  applicationId: process.env.VONAGE_APPLICATION_ID,
  accessKey: process.env.DEMO_ACCESS_KEY || '',
  maxParticipants: Number(process.env.MAX_PARTICIPANTS || 4),
  modelId: process.env.BEDROCK_MODEL_ID || 'jp.anthropic.claude-haiku-5-5',
  privateKeyParam: process.env.VONAGE_PRIVATE_KEY_PARAM,
  privateKeyPath: process.env.VONAGE_PRIVATE_KEY_PATH,
  roomParamPrefix: process.env.ROOM_PARAM_PREFIX, // 未設定ならメモリに保持（ローカル開発用）
  meetingParamPrefix: process.env.MEETING_PARAM_PREFIX, // 同上
  meetingMaxSeconds: Number(process.env.MEETING_MAX_SECONDS || 180),
  schedulerRoleArn: process.env.SCHEDULER_ROLE_ARN, // 未設定なら時間切れの強制退出をスケジュールしない（ローカル開発用）
  tokenTtlSeconds: 120, // Vonage トークンは接続時にだけ検証される。ため込みを防ぐため短くする
  languages: ['ja', 'en'],
};

let privateKeyCache;
export async function getPrivateKey() {
  if (privateKeyCache) return privateKeyCache;
  if (config.privateKeyPath) {
    privateKeyCache = await readFile(config.privateKeyPath, 'utf8');
  } else if (config.privateKeyParam) {
    const res = await ssm.send(new GetParameterCommand({ Name: config.privateKeyParam, WithDecryption: true }));
    privateKeyCache = res.Parameter.Value;
  } else {
    throw new Error('VONAGE_PRIVATE_KEY_PATH か VONAGE_PRIVATE_KEY_PARAM を設定してください');
  }
  return privateKeyCache;
}
