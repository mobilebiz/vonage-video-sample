// 【実験的】ブラウザ内蔵の Web Speech API による音声認識（AWS 費用ゼロ）。
// URL に ?stt=webspeech を付けると使われる。端末によっては WebRTC とマイクを取り合って
// 認識が止まる・相手に声が届かなくなるなどの問題があるため、既定は Transcribe にしている。
const LANGS = { ja: 'ja-JP', en: 'en-US' };

export class WebSpeechStt {
  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor({ lang, onPartial, onFinal, onError }) {
    Object.assign(this, { lang, onPartial, onFinal, onError });
    this.running = false;
    this.seq = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Rec();
    rec.lang = LANGS[this.lang];
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        const id = `ws-${this.seq}-${i}`;
        if (r.isFinal) { this.onFinal(id, text); } else { this.onPartial(id, text); }
      }
    };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') this.onError?.(new Error(e.error)); };
    rec.onend = () => { if (this.running) { this.seq += 1; try { rec.start(); } catch { /* noop */ } } };
    this.rec = rec;
    rec.start();
  }

  stop() {
    this.running = false;
    try { this.rec?.stop(); } catch { /* noop */ }
    this.rec = null;
  }
}
