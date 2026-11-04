// Amazon Transcribe Streaming の WebSocket 用署名付き URL を発行する。
// ブラウザはこの URL に直接接続して音声を送るので、AWS 認証情報をブラウザに渡さずに済む。
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { region } from './config.js';

const LANGUAGE_CODES = { ja: 'ja-JP', en: 'en-US' };
export const SAMPLE_RATE = 16000;

const signer = new SignatureV4({ credentials: defaultProvider(), region, service: 'transcribe', sha256: Sha256 });

export async function presignTranscribeUrl(lang) {
  const hostname = `transcribestreaming.${region}.amazonaws.com`;
  const request = {
    method: 'GET',
    protocol: 'wss:',
    hostname,
    port: 8443,
    path: '/stream-transcription-websocket',
    headers: { host: `${hostname}:8443` },
    query: {
      'language-code': LANGUAGE_CODES[lang],
      'media-encoding': 'pcm',
      'sample-rate': String(SAMPLE_RATE),
      'enable-partial-results-stabilization': 'true',
      'partial-results-stability': 'medium',
    },
  };
  const signed = await signer.presign(request, { expiresIn: 300 });
  const qs = Object.entries(signed.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `wss://${hostname}:8443${signed.path}?${qs}`;
}
