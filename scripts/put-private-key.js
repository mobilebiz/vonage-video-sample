// Vonage アプリケーションの秘密鍵を SSM Parameter Store (SecureString) に登録する。
//   使い方: AWS_PROFILE=kwc-v4g npm run put-key -- ./private.key
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run put-key -- <path/to/private.key>');
  process.exit(1);
}
const name = process.env.VONAGE_PRIVATE_KEY_PARAM || '/vonage-video-sample/private-key';
const value = await readFile(file, 'utf8');
if (!value.includes('PRIVATE KEY')) {
  console.error('秘密鍵ファイルではないようです');
  process.exit(1);
}
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }));
console.log(`saved to SSM: ${name}`);
