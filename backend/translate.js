// Amazon Bedrock (Converse API) による字幕翻訳。モデルは BEDROCK_MODEL_ID で切り替え可能。
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config, region } from './config.js';

const bedrock = new BedrockRuntimeClient({ region });
const LANG_NAMES = { ja: 'Japanese', en: 'English' };

function systemPrompt(from, to) {
  return [
    `You are a live subtitle translator for a video call.`,
    `Translate the speaker's latest utterance from ${LANG_NAMES[from]} to natural, spoken ${LANG_NAMES[to]}.`,
    `The text comes from speech recognition and may contain small recognition errors or missing punctuation; infer the intended meaning.`,
    `Use the recent conversation only as context for pronouns, omitted subjects and terminology. Do not translate the context.`,
    `Output only the translated subtitle text. No quotes, notes, or explanations.`,
  ].join('\n');
}

async function translateOne(text, from, to, context) {
  const ctx = (context || []).slice(-4).map((c) => `- ${c.name}: ${c.text}`).join('\n');
  const userText = ctx
    ? `<recent_conversation>\n${ctx}\n</recent_conversation>\n<utterance>\n${text}\n</utterance>`
    : `<utterance>\n${text}\n</utterance>`;
  const res = await bedrock.send(new ConverseCommand({
    modelId: config.modelId,
    system: [{ text: systemPrompt(from, to) }],
    messages: [{ role: 'user', content: [{ text: userText }] }],
    inferenceConfig: { maxTokens: 400 },
  }));
  const out = (res.output?.message?.content || []).map((c) => c.text || '').join('').trim();
  return { text: out, latencyMs: res.metrics?.latencyMs, usage: res.usage };
}

/**
 * @param {{text:string, from:'ja'|'en', to:string[], context?:{name:string,text:string}[]}} req
 * @returns {Promise<Record<string,string>>} 言語コード → 翻訳文
 */
export async function translate({ text, from, to, context }) {
  const targets = [...new Set(to.filter((l) => typeof l === 'string' && Object.hasOwn(LANG_NAMES, l)))].filter((l) => l !== from);
  const results = await Promise.all(targets.map((l) => translateOne(text, from, l, context)));
  const translations = {};
  targets.forEach((l, i) => { translations[l] = results[i].text; });
  console.log(JSON.stringify({ msg: 'translated', model: config.modelId, from, to: targets, chars: text.length, latencyMs: results.map((r) => r.latencyMs) }));
  return translations;
}
