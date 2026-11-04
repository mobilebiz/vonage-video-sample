import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, encodeMessage, decodeMessage, encodeAudioEvent } from '../frontend/eventstream.js';

test('crc32 matches known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('encode/decode roundtrip', () => {
  const payload = new TextEncoder().encode('{"hello":"world"}');
  const msg = encodeMessage({ ':message-type': 'event', ':event-type': 'TranscriptEvent' }, payload);
  const out = decodeMessage(msg);
  assert.equal(out.headers[':event-type'], 'TranscriptEvent');
  assert.deepEqual(out.json(), { hello: 'world' });
});

test('audio event has prelude crc and message crc', () => {
  const msg = encodeAudioEvent(new Uint8Array([1, 2, 3, 4]));
  const dv = new DataView(msg.buffer);
  assert.equal(dv.getUint32(0), msg.length);
  assert.equal(dv.getUint32(8), crc32(msg.subarray(0, 8)));
  assert.equal(dv.getUint32(msg.length - 4), crc32(msg.subarray(0, msg.length - 4)));
});
