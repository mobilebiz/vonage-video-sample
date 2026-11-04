// デプロイ済みスタックの入室 URL から QR コードを作る。
//   使い方: AWS_PROFILE=kwc-v4g npm run qr            → スタック出力の JoinUrl を使用
//           npm run qr -- "https://xxxx/?room=demo&k=..." → URL を直接指定
//   出力: ターミナルに QR を表示 + qr.png / qr.html を作成
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

let url = process.argv[2];
if (!url) {
  const cfn = new CloudFormationClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
  const stackName = process.env.STACK_NAME || 'VonageVideoSample';
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  url = Stacks[0].Outputs.find((o) => o.OutputKey === 'JoinUrl')?.OutputValue;
}
if (!url) throw new Error('URL が見つかりません');

console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
console.log(url);
await QRCode.toFile('qr.png', url, { width: 600, margin: 2 });
const dataUrl = await QRCode.toDataURL(url, { width: 600, margin: 2 });
await writeFile('qr.html', `<!doctype html><meta charset="utf-8"><title>QR</title>
<body style="font-family:sans-serif;text-align:center;padding:40px">
<h1>スマホで読み取って入室 / Scan to join</h1><img src="${dataUrl}" width="420"><p>${url.replace(/&/g, '&amp;')}</p></body>`);
console.log('wrote qr.png, qr.html');
