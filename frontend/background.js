// バーチャル背景（Vonage Video SDK 内蔵のビデオフィルター）
//   - 「なし／ぼかし／画像」をログイン画面で選び、入室時に Publisher に適用する
//   - 画像は映像の縦横に合わせて縦長版・横長版を使い分ける（SDK は画像を映像サイズに引き伸ばすため）
//   - 対応端末: Chrome / Edge / Firefox / Android Chrome、iPhone は iOS 26 以上の Safari
import { BACKGROUNDS } from './config.js';

export function isSupported() {
  return typeof OT !== 'undefined' && OT.hasMediaProcessorSupport?.('video') === true;
}

export const findBackground = (id) => BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[0];

export const usesImage = (id) => findBackground(id).type === 'image';

/** @param {'portrait'|'landscape'} orientation */
export function videoFilterFor(id, orientation) {
  const bg = findBackground(id);
  if (bg.type === 'blur') return { type: 'backgroundBlur', blurStrength: 'high' };
  if (bg.type === 'image') {
    // 同じオリジンから配信するので CORS の問題は起きない
    return { type: 'backgroundReplacement', backgroundImgUrl: new URL(bg.images[orientation], location.href).href };
  }
  return null;
}

const orientationOf = (publisher) => {
  const w = publisher.videoWidth?.();
  const h = publisher.videoHeight?.();
  if (!w || !h) return window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
  return h >= w ? 'portrait' : 'landscape';
};

const applied = new WeakMap(); // publisher -> 適用済みの画像の向き

/**
 * 選んだ背景を Publisher にかける。カメラ映像の実際の向きに合った画像を使う。
 * 失敗したら例外を投げる（呼び出し側で、素の映像を配信しないようにする）。
 */
export async function applyBackground(publisher, id) {
  if (findBackground(id).type === 'none') return;
  if (!isSupported()) throw new Error('video filters are not supported on this device');
  const orientation = orientationOf(publisher);
  await publisher.applyVideoFilter(videoFilterFor(id, orientation));
  applied.set(publisher, orientation);
}

/**
 * 映像の向きが変わったら（スマホの回転など）、背景画像をその向きのものに差し替える。
 * 適用に成功したときだけ向きを記録するので、失敗しても次のイベントで再試行される。
 */
export function watchOrientation(publisher, id, onError) {
  if (!usesImage(id)) return;
  publisher.on('videoDimensionsChanged', async () => {
    const done = applied.get(publisher);
    const actual = orientationOf(publisher);
    if (!done || actual === done) return; // 初回の適用前、または向きが同じ
    try {
      await publisher.applyVideoFilter(videoFilterFor(id, actual));
      applied.set(publisher, actual);
    } catch (err) {
      onError?.(err);
    }
  });
}
