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

/** 入室前の推定。スマホを縦に持っていればカメラ映像も縦長になる */
export const guessOrientation = () => (window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape');

/**
 * Publisher に背景を適用し、映像の向きが変わったら（スマホの回転など）画像を差し替える。
 * initPublisher の videoFilter で推定の向きの画像をかけておき、実際の映像サイズがわかったら合わせ直す。
 */
export function attachBackground(publisher, id, onError) {
  if (!usesImage(id)) return;
  let current = guessOrientation();
  const sync = async () => {
    const w = publisher.videoWidth?.();
    const h = publisher.videoHeight?.();
    if (!w || !h) return;
    const actual = h >= w ? 'portrait' : 'landscape';
    if (actual === current) return;
    current = actual;
    try {
      await publisher.applyVideoFilter(videoFilterFor(id, actual));
    } catch (err) {
      onError?.(err);
    }
  };
  publisher.on('videoElementCreated', () => setTimeout(sync, 500));
  publisher.on('videoDimensionsChanged', sync);
}
