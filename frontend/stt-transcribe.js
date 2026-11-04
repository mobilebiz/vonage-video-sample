// Amazon Transcribe Streaming (WebSocket) による音声認識。
// Vonage Publisher が使っているマイクの MediaStreamTrack をそのまま流用するので、マイクの取り合いが起きない。
import { encodeAudioEvent, decodeMessage } from './eventstream.js';

const workletLoaded = new WeakSet();

export class TranscribeStt {
  /**
   * @param {object} o
   * @param {AudioContext} o.audioContext
   * @param {() => Promise<{url:string, sampleRate:number}>} o.getUrl 署名付き URL を取得する関数
   * @param {(id:string, text:string) => void} o.onPartial
   * @param {(id:string, text:string) => void} o.onFinal
   * @param {(err:Error) => void} [o.onError]
   */
  constructor(o) {
    Object.assign(this, o);
    this.running = false;
    this.ws = null;
    this.retry = 0;
  }

  async start(track) {
    if (this.running) return;
    this.running = true;
    const ctx = this.audioContext;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (!workletLoaded.has(ctx)) {
      await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      workletLoaded.add(ctx);
    }
    const { url, sampleRate } = await this.getUrl();
    if (!this.running) return;
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.node = new AudioWorkletNode(ctx, 'pcm-downsampler', { processorOptions: { targetSampleRate: sampleRate } });
    // 出力は無音。destination に繋がないと処理が走らないブラウザがあるため接続しておく
    this.source.connect(this.node);
    this.node.connect(ctx.destination);
    this.node.port.onmessage = (e) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(encodeAudioEvent(new Uint8Array(e.data)));
      }
    };
    this.openSocket(url);
  }

  openSocket(url) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (e) => this.handleMessage(e.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.running) this.reconnect();
    };
  }

  async reconnect() {
    // ネットワーク断・ストリーム上限などで切れた場合は新しい URL で張り直す
    const wait = Math.min(10000, 500 * 2 ** this.retry++);
    await new Promise((r) => setTimeout(r, wait));
    if (!this.running || this.ws) return;
    try {
      const { url } = await this.getUrl();
      if (this.running && !this.ws) this.openSocket(url);
    } catch (err) {
      this.onError?.(err);
      if (this.running) this.reconnect();
    }
  }

  handleMessage(data) {
    let msg;
    try { msg = decodeMessage(data); } catch (err) { this.onError?.(err); return; }
    const type = msg.headers[':message-type'];
    if (type === 'exception') {
      const body = (() => { try { return msg.json(); } catch { return {}; } })();
      this.onError?.(new Error(`${msg.headers[':exception-type']}: ${body.Message || ''}`));
      return;
    }
    if (msg.headers[':event-type'] !== 'TranscriptEvent') return;
    const results = msg.json().Transcript?.Results || [];
    for (const r of results) {
      const text = r.Alternatives?.[0]?.Transcript?.trim();
      if (!text) continue;
      if (r.IsPartial) this.onPartial(r.ResultId, text);
      else this.onFinal(r.ResultId, text);
    }
  }

  stop() {
    this.running = false;
    try { this.source?.disconnect(); this.node?.disconnect(); } catch { /* noop */ }
    this.source = null;
    this.node = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeAudioEvent(new Uint8Array(0))); // ストリーム終了の通知
      setTimeout(() => ws.close(), 300);
    } else if (ws) {
      ws.close();
    }
  }
}
