// マイク音声 (AudioContext のサンプルレート) を 16kHz / 16bit PCM に変換し、約 100ms ごとにメインスレッドへ送る。
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions?.targetSampleRate || 16000;
    this.ratio = sampleRate / this.target;
    this.chunk = new Int16Array(this.target / 10);
    this.filled = 0;
    this.pos = 0; // 入力側の小数位置
    this.acc = 0;
    this.accCount = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // 区間平均による簡易ダウンサンプリング（ローパス代わり）
      this.acc += ch[i];
      this.accCount += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.accCount));
        this.chunk[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.acc = 0;
        this.accCount = 0;
        if (this.filled === this.chunk.length) {
          this.port.postMessage(this.chunk.buffer.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
