// AWS Event Stream (application/vnd.amazon.eventstream) の最小限のエンコーダ/デコーダ。
// Amazon Transcribe Streaming の WebSocket はこの形式でメッセージをやり取りする。
// ブラウザと Node.js（テスト）の両方で動くよう依存なしで実装している。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 文字列ヘッダー(type 7)のみ対応 */
export function encodeMessage(headers, payload) {
  const headerParts = Object.entries(headers).map(([name, value]) => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const buf = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    const dv = new DataView(buf.buffer);
    buf[0] = n.length;
    buf.set(n, 1);
    buf[1 + n.length] = 7;
    dv.setUint16(2 + n.length, v.length);
    buf.set(v, 4 + n.length);
    return buf;
  });
  const headersLen = headerParts.reduce((s, p) => s + p.length, 0);
  const total = 12 + headersLen + payload.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, headersLen);
  dv.setUint32(8, crc32(out.subarray(0, 8)));
  let off = 12;
  for (const p of headerParts) { out.set(p, off); off += p.length; }
  out.set(payload, off);
  dv.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

export function encodeAudioEvent(pcmBytes) {
  return encodeMessage({
    ':content-type': 'application/octet-stream',
    ':event-type': 'AudioEvent',
    ':message-type': 'event',
  }, pcmBytes);
}

export function decodeMessage(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = dv.getUint32(0);
  const headersLen = dv.getUint32(4);
  if (total !== bytes.length) throw new Error(`eventstream length mismatch ${total} != ${bytes.length}`);
  const headers = {};
  let off = 12;
  const end = 12 + headersLen;
  while (off < end) {
    const nameLen = bytes[off]; off += 1;
    const name = dec.decode(bytes.subarray(off, off + nameLen)); off += nameLen;
    const type = bytes[off]; off += 1;
    if (type === 7 || type === 6) {
      const len = dv.getUint16(off); off += 2;
      const val = bytes.subarray(off, off + len); off += len;
      headers[name] = type === 7 ? dec.decode(val) : val;
    } else {
      throw new Error(`unsupported header type ${type}`);
    }
  }
  const payload = bytes.subarray(end, total - 4);
  return { headers, payload, json: () => JSON.parse(dec.decode(payload)) };
}
