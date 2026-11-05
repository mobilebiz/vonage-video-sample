// 画面まわりの設定

// バーチャル背景の選択肢（画像は frontend/backgrounds/ に縦長 960x1280・横長 1280x960 の 2 種類を置く）
export const BACKGROUNDS = [
  { id: 'none', type: 'none', label: 'bgNone' },
  { id: 'blur', type: 'blur', label: 'bgBlur' },
  ...['office', 'city', 'nature'].map((id) => ({
    id,
    type: 'image',
    label: `bg_${id}`,
    thumb: `backgrounds/${id}-thumb.jpg`,
    images: { portrait: `backgrounds/${id}-portrait.jpg`, landscape: `backgrounds/${id}-landscape.jpg` },
  })),
];

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
