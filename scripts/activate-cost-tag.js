// コスト配分タグ Project を有効化する（予算アラートでこのプロジェクトの費用を集計するために必要）。
// タグ付きリソースを作ってから Billing にタグが現れるまで最大 24 時間かかるので、デプロイの翌日以降に実行する。
//   使い方: AWS_PROFILE=kwc-v4g npm run activate-tag
import 'dotenv/config';
import { CostExplorerClient, UpdateCostAllocationTagsStatusCommand, ListCostAllocationTagsCommand } from '@aws-sdk/client-cost-explorer';

const key = 'Project';
const ce = new CostExplorerClient({ region: 'us-east-1' });
const res = await ce.send(new UpdateCostAllocationTagsStatusCommand({
  CostAllocationTagsStatus: [{ TagKey: key, Status: 'Active' }],
}));
if (res.Errors?.length) {
  console.error(res.Errors);
  process.exit(1);
}
const { CostAllocationTags } = await ce.send(new ListCostAllocationTagsCommand({ TagKeys: [key] }));
console.log(CostAllocationTags.map((t) => `${t.TagKey}: ${t.Status}`).join('\n'));
