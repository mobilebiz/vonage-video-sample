// 画面まわりの設定

// ログイン画面下の「Powered by Vonage」リンク
export const POWERED_BY = {
  url: 'https://kwcplus.kddi-web.com/service/vonage',
  // UTM パラメーターを付けるときは値を入れる（空の項目は付かない）
  utm: {
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_content: '',
  },
};

export function poweredByHref() {
  const u = new URL(POWERED_BY.url);
  Object.entries(POWERED_BY.utm).forEach(([k, v]) => { if (v) u.searchParams.set(k, v); });
  return u.toString();
}
