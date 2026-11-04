import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdk from 'aws-cdk-lib';
import s3 from 'aws-cdk-lib/aws-s3';
import s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import cloudfront from 'aws-cdk-lib/aws-cloudfront';
import origins from 'aws-cdk-lib/aws-cloudfront-origins';
import lambda from 'aws-cdk-lib/aws-lambda';
import lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import logs from 'aws-cdk-lib/aws-logs';
import iam from 'aws-cdk-lib/aws-iam';
import bedrock from 'aws-cdk-lib/aws-bedrock';
import budgets from 'aws-cdk-lib/aws-budgets';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 構成（すべて従量課金・常時起動サーバーなし）
 *   CloudFront ─┬─ /*      → S3（静的フロントエンド, OAC）
 *               └─ /api/*  → Lambda Function URL（OAC）
 *   Lambda → Vonage Video API / Amazon Bedrock / Transcribe(署名URL発行) / SSM Parameter Store
 *   EventBridge Scheduler → Lambda（会議時間の終了時に全員を強制退出）
 *   AWS Budgets（Project タグ + Transcribe の月額アラート）
 */
export class VonageVideoSampleStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    if (!props.vonageApplicationId) {
      throw new Error('VONAGE_APPLICATION_ID を .env に設定してください');
    }
    if (!props.accessKey || props.accessKey.length < 8) {
      throw new Error('DEMO_ACCESS_KEY を .env に 8 文字以上で設定してください（例: openssl rand -hex 8）');
    }
    const roomParamPrefix = '/vonage-video-sample/rooms';
    const meetingParamPrefix = '/vonage-video-sample/meetings';
    // このタグでプロジェクトの費用を集計する（Billing でコスト配分タグとして有効化が必要）
    cdk.Tags.of(this).add('Project', props.projectTag);

    // Bedrock の費用をタグで集計できるよう、システム推論プロファイルを複製したアプリケーション推論プロファイルを使う
    const modelSourceArn = /^(jp|apac|global|us|eu|au|ca)\./.test(props.modelId)
      ? `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.modelId}`
      : `arn:aws:bedrock:${this.region}::foundation-model/${props.modelId}`;
    const inferenceProfile = new bedrock.CfnApplicationInferenceProfile(this, 'TranslateModel', {
      inferenceProfileName: `${id}-translate`,
      description: `Translation model for ${id}`,
      modelSource: { copyFrom: modelSourceArn },
      tags: [{ key: 'Project', value: props.projectTag }],
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambdaNode.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(root, 'backend/handler.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      logGroup,
      environment: {
        VONAGE_APPLICATION_ID: props.vonageApplicationId,
        VONAGE_PRIVATE_KEY_PARAM: props.privateKeyParam,
        ROOM_PARAM_PREFIX: roomParamPrefix,
        DEMO_ACCESS_KEY: props.accessKey,
        BEDROCK_MODEL_ID: inferenceProfile.attrInferenceProfileArn,
        MAX_PARTICIPANTS: String(props.maxParticipants),
        MEETING_PARAM_PREFIX: meetingParamPrefix,
        MEETING_MAX_SECONDS: String(props.meetingMaxSeconds),
        SCHEDULER_ROLE_ARN: '', // 下で設定
      },
      bundling: {
        format: lambdaNode.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: false,
        mainFields: ['module', 'main'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // AWS SDK も同梱してバージョンを固定する（ランタイム同梱版との差異を避ける）
        externalModules: [],
      },
    });

    const ssmArn = (name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`;
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [ssmArn(props.privateKeyParam)],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [ssmArn(`${roomParamPrefix}/*`), ssmArn(`${meetingParamPrefix}/*`)],
    }));

    // 会議終了時刻に Lambda 自身を起動するための EventBridge Scheduler
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    fn.grantInvoke(schedulerRole);
    fn.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule'],
      resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/vvs-*`],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [schedulerRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    // 推論プロファイルは、プロファイル自体・複製元・ルーティング先リージョンの基盤モデルすべてへの権限が必要
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        inferenceProfile.attrInferenceProfileArn,
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        'arn:aws:bedrock:*::foundation-model/*',
      ],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['transcribe:StartStreamTranscriptionWebSocket'],
      resources: ['*'],
    }));

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Vonage Video multilingual caption demo',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // 日本のエッジを含む最小構成
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
          customHeadersBehavior: {
            customHeaders: [
              { header: 'Permissions-Policy', value: 'camera=(self), microphone=(self)', override: true },
            ],
          },
          securityHeadersBehavior: {
            contentTypeOptions: { override: true },
            referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
            strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), override: true },
          },
        }),
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(root, 'frontend'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      // 毎回 ETag で更新を確認させる（デプロイ直後に新旧ファイルが混ざらないように）。未変更なら 304 で軽い
      cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
      memoryLimit: 256,
    });

    // 月額予算アラート。Transcribe Streaming はタグで集計できないため、サービス単位で合算する
    if (props.budgetEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `${id}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.budgetAmount, unit: 'USD' },
          metrics: ['UnblendedCost'],
          filterExpression: {
            or: [
              { tags: { key: 'Project', values: [props.projectTag], matchOptions: ['EQUALS'] } },
              { dimensions: { key: 'SERVICE', values: ['Amazon Transcribe'], matchOptions: ['EQUALS'] } },
            ],
          },
        },
        notificationsWithSubscribers: [
          { threshold: 80, notificationType: 'ACTUAL' },
          { threshold: 100, notificationType: 'ACTUAL' },
          { threshold: 100, notificationType: 'FORECASTED' },
        ].map((n) => ({
          notification: { ...n, comparisonOperator: 'GREATER_THAN', thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
        })),
      });
    }

    const siteUrl = `https://${distribution.distributionDomainName}/`;
    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'JoinUrl', {
      value: `${siteUrl}?${new URLSearchParams({ room: 'demo', k: props.accessKey })}`,
      description: 'QR コードにする URL',
    });
  }
}
