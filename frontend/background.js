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
 * 初回のフィルターは OT.initPublisher の videoFilter オプションで渡す。
 * そうすると SDK は「処理の準備ができるまで素の映像の代わりに空の映像を流す」モードで適用するので、
 * 背景を隠したい人の部屋が一瞬でも相手に映ることがない（後から applyVideoFilter するとこの保護がない）。
 * @param {'portrait'|'landscape'} orientation
 */
export const initialFilter = (id, orientation) => videoFilterFor(id, orientation);

/**
 * initPublisher の完了後に呼ぶ。フィルターが本当にかかったかを確かめ（SDK は失敗してもログだけで進む）、
 * かかっていなければ例外を投げる。初回の適用中に端末が回転していたら、今の向きの画像に合わせ直す。
 */
export async function confirmBackground(publisher, id, orientation) {
  if (findBackground(id).type === 'none') return;
  if (!publisher.getVideoFilter?.()) throw new Error('the initial video filter was not applied');
  const now = orientationOf(publisher);
  if (usesImage(id) && now !== orientation) {
    await publisher.applyVideoFilter(videoFilterFor(id, now)); // 同じ種類のフィルターの更新なので素の映像は流れない
  }
  applied.set(publisher, now);
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

/** カメラ映像の寸法がわかるまで待つ。カメラが止まった・時間切れの場合は失敗にする */
function waitForFirstFrame(video, track, timeoutMs) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      track.removeEventListener('ended', onEnded);
      fn(arg);
    };
    const onMeta = () => done(resolve);
    const onEnded = () => done(reject, new Error('camera track ended before the first frame'));
    const timer = setTimeout(() => done(reject, new Error('camera did not start in time')), timeoutMs);
    video.addEventListener('loadedmetadata', onMeta);
    track.addEventListener('ended', onEnded);
  });
}

/**
 * 背景フィルター用に「回転情報を持たない」カメラ映像を作る。
 *
 * スマホのカメラ映像のフレームには回転情報（縦持ちなら 90°）が付いている。SDK 内蔵の
 * 背景処理（ml-transformers）はこれを見てフレームを回転させるが、端末によってはブラウザ側でも
 * 回転済みのため二重に回り、相手には横倒しの映像が届いてしまう。
 * そこでカメラ映像を一度 canvas に描き直し（描画時に正しい向きになる）、canvas の映像を SDK に渡す。
 */
export async function createUprightCamera({ frameRate = 15 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: frameRate } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const [cameraTrack] = stream.getVideoTracks();
  const [audioTrack] = stream.getAudioTracks();

  // iOS Safari は DOM にない video 要素をデコードしないことがあるので、見えない形で置く
  const video = document.createElement('video');
  Object.assign(video, { muted: true, playsInline: true, autoplay: true });
  video.setAttribute('playsinline', '');
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  video.srcObject = new MediaStream([cameraTrack]);
  document.body.append(video);
  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    video.remove();
  };
  try {
    // 再生できないと canvas が更新されず真っ暗な映像を配信してしまうので、失敗は呼び出し元に伝える
    // フレームが来ないと play() 自体が終わらないので、最初のフレーム待ち（時間切れあり）と同時に待つ
    await Promise.all([video.play(), waitForFirstFrame(video, cameraTrack, 10000)]);
  } catch (err) {
    cleanup();
    throw err;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let stopped = false;
  const draw = () => {
    if (stopped) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h) {
      // 端末の回転で縦横が変わったら canvas も合わせる（相手の映像も縦横が切り替わる）
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
    }
  };
  draw();
  const videoTrack = canvas.captureStream(frameRate).getVideoTracks()[0];
  let timer;
  if (typeof video.requestVideoFrameCallback === 'function') {
    const loop = () => { draw(); if (!stopped) video.requestVideoFrameCallback(loop); };
    video.requestVideoFrameCallback(loop);
  } else {
    timer = setInterval(draw, 1000 / frameRate);
  }

  return {
    videoTrack,
    audioTrack,
    orientation: () => (canvas.height >= canvas.width ? 'portrait' : 'landscape'),
    stop() {
      stopped = true;
      clearInterval(timer);
      videoTrack?.stop();
      cleanup();
    },
  };
}
