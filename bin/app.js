#!/usr/bin/env node
import 'dotenv/config';
import cdk from 'aws-cdk-lib';
import { VonageVideoSampleStack } from '../lib/stack.js';

const app = new cdk.App();
new VonageVideoSampleStack(app, process.env.STACK_NAME || 'VonageVideoSample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // jp. 推論プロファイルを使うため東京リージョン固定（変える場合は STACK_REGION）
    region: process.env.STACK_REGION || 'ap-northeast-1',
  },
  vonageApplicationId: process.env.VONAGE_APPLICATION_ID,
  accessKey: process.env.DEMO_ACCESS_KEY || '',
  modelId: process.env.BEDROCK_MODEL_ID || 'jp.anthropic.claude-haiku-5-5',
  privateKeyParam: process.env.VONAGE_PRIVATE_KEY_PARAM || '/vonage-video-sample/private-key',
  maxParticipants: process.env.MAX_PARTICIPANTS || '4',
  meetingMaxSeconds: process.env.MEETING_MAX_SECONDS || '180',
  projectTag: process.env.PROJECT_TAG || 'vonage-video-sample',
  budgetAmount: Number(process.env.BUDGET_AMOUNT_USD || 100),
  budgetEmail: process.env.BUDGET_ALERT_EMAIL || '',
});
