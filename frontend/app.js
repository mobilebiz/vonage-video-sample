// 多言語字幕つきビデオ会議（Vonage Video API）
//
// 字幕の流れ:
//   1. 話者の端末で自分の音声を文字起こし（Amazon Transcribe Streaming / 既定）
//   2. 認識途中・確定の原文を Vonage の signal で全員に配信
//   3. 確定したら、話者の端末が「自分と違う言語の参加者がいる場合だけ」Bedrock で翻訳し、訳文を signal で配信
//      → 1 発話あたりの翻訳呼び出しは最大 1 回（言語が 2 種類のため）。同じ言語どうしなら翻訳しない
//   4. 受信側は自分の言語と同じなら原文、違えば訳文を字幕として表示
import { t } from './i18n.js';
import { TranscribeStt } from './stt-transcribe.js';
import { WebSpeechStt } from './stt-webspeech.js';
import { poweredByHref, BACKGROUNDS } from './config.js';
import * as vbg from './background.js';

const params = new URLSearchParams(location.search);
const ROOM = params.get('room') || 'demo';
const ACCESS_KEY = params.get('k') || '';
const STT_MODE = params.get('stt') === 'webspeech' ? 'webspeech' : 'transcribe';
const CAPTION_TTL_MS = 9000;
const MAX_CAPTIONS = 3;
const PARTIAL_SIGNAL_INTERVAL_MS = 600;

const $ = (sel) => document.querySelector(sel);
const state = {
  lang: 'ja',
  name: '',
  background: 'none',
  session: null,
  publisher: null,
  join: null, // /api/join のレスポンス
  audioContext: null,
  stt: null,
  micOn: true,
  camOn: true,
  participants: new Map(), // connectionId -> { name, lang, creationTime, isMe }
  history: [], // 翻訳の文脈用（確定した発言の原文）
  leaving: false,
  meetingEndsAt: 0, // この端末の時計での会議終了時刻 (ms)
  timer: null,
};

// ---------------------------------------------------------------- 共通

function applyI18n(lang) {
  if (document.querySelector('#timer .label')) $('#timer .label').textContent = t(lang, 'timeLeft');
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(lang, el.dataset.i18n); });
  $('#name').placeholder = t(lang, 'namePh');
  updateControls();
}

function showView(id) {
  ['#login-view', '#room-view'].forEach((v) => { $(v).hidden = v !== id; });
}

let toastTimer;
function toast(msg) {
  const el = $('#room-error');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function api(path, body) {
  const payload = JSON.stringify(body);
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // CloudFront → Lambda Function URL (OAC) では POST 本文のハッシュが必要
      'x-amz-content-sha256': await sha256Hex(payload),
    },
    body: payload,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

const parseConnData = (conn) => { try { return JSON.parse(conn.data || '{}'); } catch { return {}; } };

// ---------------------------------------------------------------- ログイン

function initLogin() {
  $('#room-label').textContent = ROOM;
  $('#powered-by').href = poweredByHref();
  const saved = JSON.parse(localStorage.getItem('vvs-profile') || '{}');
  initBackgroundPicker(saved.background);
  if (saved.name) $('#name').value = saved.name;
  const initialLang = saved.lang || (navigator.language?.startsWith('ja') ? 'ja' : 'en');
  document.querySelector(`input[name=lang][value=${initialLang}]`).checked = true;
  state.lang = initialLang;
  applyI18n(state.lang);

  document.querySelectorAll('input[name=lang]').forEach((r) => r.addEventListener('change', (e) => {
    state.lang = e.target.value;
    applyI18n(state.lang);
  }));

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    login();
  });
  $('#mic-btn').addEventListener('click', toggleMic);
  $('#cam-btn').addEventListener('click', toggleCam);
  $('#leave-btn').addEventListener('click', () => leave('left'));
}

function initBackgroundPicker(savedId) {
  if (!vbg.isSupported()) return; // 非対応の端末では選択欄ごと出さない
  const initial = vbg.findBackground(savedId).id;
  const box = $('#bg-options');
  for (const bg of BACKGROUNDS) {
    const label = document.createElement('label');
    label.className = `bg-option bg-${bg.type}`;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bg';
    input.value = bg.id;
    input.checked = bg.id === initial;
    const face = document.createElement('span');
    face.className = 'face';
    if (bg.thumb) face.style.backgroundImage = `url("${bg.thumb}")`;
    const text = document.createElement('span');
    text.className = 'text';
    text.dataset.i18n = bg.label;
    text.textContent = t(state.lang, bg.label);
    label.append(input, face, text);
    box.append(label);
  }
  $('#bg-field').hidden = false;
}

function loginError(msg) {
  const el = $('#login-error');
  el.textContent = msg;
  el.hidden = !msg;
  showView('#login-view');
}

async function login() {
  const name = $('#name').value.trim();
  state.lang = document.querySelector('input[name=lang]:checked').value;
  if (!name || [...name].length > 20) { loginError(t(state.lang, 'errName')); return; }
  if (OT.checkSystemRequirements() !== 1) { loginError(t(state.lang, 'errUnsupported')); return; }
  state.name = name;
  state.background = vbg.isSupported() ? (document.querySelector('input[name=bg]:checked')?.value || 'none') : 'none';
  localStorage.setItem('vvs-profile', JSON.stringify({ name, lang: state.lang, background: state.background }));

  // iOS Safari ではユーザー操作の中で AudioContext を作らないと音声処理が始まらない
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  state.audioContext.resume().catch(() => {});

  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = t(state.lang, 'joining');
  loginError('');
  try {
    state.join = await api('/api/join', { name, lang: state.lang, room: ROOM, key: ACCESS_KEY });
    // 端末の時計のずれは API 応答の受信時点で補正する（接続待ちの時間を残り時間に含めないため）
    state.meetingEndsAt = state.join.meeting.endsAt + (Date.now() - state.join.meeting.serverNow);
    await enterRoom();
  } catch (err) {
    console.error(err);
    const map = { room_full: t(state.lang, 'errRoomFull', { n: state.join?.maxParticipants || 4 }), bad_key: t(state.lang, 'errKey'), bad_name: t(state.lang, 'errName'), meeting_ending: t(state.lang, 'errEnding') };
    loginError(map[err.code] || t(state.lang, 'errConnect', { msg: err.message }));
  } finally {
    btn.disabled = false;
    btn.textContent = t(state.lang, 'login');
  }
}

// ---------------------------------------------------------------- 会議室

function enterRoom() {
  const { applicationId, sessionId, token } = state.join;
  state.leaving = false;
  state.micOn = true;
  state.camOn = true;
  state.participants.clear();
  state.history = [];
  $('#grid').innerHTML = '';
  $('#captions').innerHTML = '';

  const session = OT.initSession(applicationId, sessionId);
  state.session = session;

  session.on({
    connectionCreated: (e) => addParticipant(e.connection),
    connectionDestroyed: (e) => removeParticipant(e.connection.connectionId),
    streamCreated: (e) => subscribe(e.stream),
    streamPropertyChanged: (e) => {
      const tile = getTile(e.stream.connection.connectionId);
      if (!tile) return;
      if (e.changedProperty === 'hasAudio') tile.classList.toggle('audio-off', !e.newValue);
      if (e.changedProperty === 'hasVideo') tile.classList.toggle('video-off', !e.newValue);
    },
    'signal:caption': (e) => onCaptionSignal(e),
    'signal:caption-tr': (e) => onTranslationSignal(e),
    sessionDisconnected: () => {
      // 終了時刻ちょうどにサーバー側から切断された場合は「時間切れ」として扱う
      if (!state.leaving) leave(remainingMs() <= 5000 ? 'timeup' : 'disconnected');
    },
  });

  return new Promise((resolve, reject) => {
    session.connect(token, (err) => {
      if (err) { reject(err); return; }
      showView('#room-view');
      startTimer();
      addParticipant(session.connection);
      startPublishing();
      // 定員チェック（サーバー側でも確認しているが、同時入室の競合に備えて接続順で判定する）
      setTimeout(checkCapacity, 1500);
      resolve();
    });
  });
}

// ---------------------------------------------------------------- 会議時間

// 会議は「誰かが入室してから全員が退出するまで」。終了時刻はサーバーが決め、全員で共有する
function startTimer() {
  clearInterval(state.timer);
  const tick = () => {
    const ms = remainingMs();
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const text = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const el = $('#timer');
    el.querySelector('.value').textContent = text;
    el.classList.toggle('warn', sec <= 30);
    if (ms <= 0) leave('timeup');
  };
  tick();
  state.timer = setInterval(tick, 250);
}

const remainingMs = () => state.meetingEndsAt - Date.now();

function formatDuration(sec) {
  return sec % 60 === 0 ? t(state.lang, 'minutes', { n: sec / 60 }) : t(state.lang, 'seconds', { n: sec });
}

function checkCapacity() {
  if (!state.session || state.leaving) return;
  const sorted = [...state.participants.entries()]
    .sort(([idA, a], [idB, b]) => (a.creationTime - b.creationTime) || idA.localeCompare(idB));
  const myIndex = sorted.findIndex(([, p]) => p.isMe);
  if (myIndex >= state.join.maxParticipants) {
    leave('full');
  }
}

function addParticipant(connection) {
  const id = connection.connectionId;
  if (state.participants.has(id)) return;
  const isMe = id === state.session.connection?.connectionId;
  const { name = '?', lang = 'ja' } = parseConnData(connection);
  state.participants.set(id, { name, lang, creationTime: connection.creationTime, isMe });
  createTile(id, { name, lang, isMe });
}

function removeParticipant(id) {
  state.participants.delete(id);
  getTile(id)?.remove();
  updateGrid();
}

const getTile = (connectionId) => document.getElementById(`tile-${connectionId}`);

function createTile(connectionId, { name, lang, isMe }) {
  if (getTile(connectionId)) return getTile(connectionId);
  const tile = document.createElement('div');
  tile.className = 'tile video-off';
  tile.id = `tile-${connectionId}`;
  tile.innerHTML = `
    <div class="video"></div>
    <div class="avatar"><span></span></div>
    <div class="name">
      <svg class="muted-icon" viewBox="0 0 24 24"><path d="M19 11h-2c0 .74-.16 1.43-.43 2.05l1.47 1.47A6.9 6.9 0 0 0 19 11zM15 11.16V5a3 3 0 0 0-5.94-.6L15 10.34v.82zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.46 2.63l1.66 1.66A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 3.32-1.3L19.73 21 21 19.73 4.27 3z"/></svg>
      <span class="label"></span><span class="lang"></span>
    </div>`;
  tile.querySelector('.avatar span').textContent = [...name][0]?.toUpperCase() || '?';
  tile.querySelector('.name .label').textContent = isMe ? `${name} (${t(state.lang, 'you')})` : name;
  tile.querySelector('.name .lang').textContent = lang.toUpperCase();
  // 自分のタイルは常に先頭
  if (isMe) $('#grid').prepend(tile); else $('#grid').append(tile);
  updateGrid();
  return tile;
}

function updateGrid() {
  const n = $('#grid').children.length;
  $('#grid').dataset.count = String(Math.max(1, Math.min(4, n)));
  $('#waiting').hidden = n > 1;
}

const VIDEO_OPTS = {
  insertMode: 'append',
  width: '100%',
  height: '100%',
  fitMode: 'cover',
  showControls: false,
};

function startPublishing() {
  const myId = state.session.connection.connectionId;
  const tile = getTile(myId);
  const publisher = OT.initPublisher(tile.querySelector('.video'), {
    ...VIDEO_OPTS,
    resolution: '640x480',
    frameRate: 15,
    // 背景画像のときは鏡像にしない（自分の画面でロゴや文字が左右反転して見えるため）
    mirror: !vbg.usesImage(state.background),
    ...(vbg.isSupported() && state.background !== 'none'
      ? { videoFilter: vbg.videoFilterFor(state.background, vbg.guessOrientation()) }
      : {}),
    publishAudio: true,
    publishVideo: true,
  }, (err) => {
    if (err) {
      console.error(err);
      toast(t(state.lang, 'errMedia'));
    }
  });
  state.publisher = publisher;
  vbg.attachBackground(publisher, state.background, (err) => { console.warn('video filter', err); toast(t(state.lang, 'errFilter')); });
  publisher.on('accessDenied', () => toast(t(state.lang, 'errMedia')));
  publisher.on('videoElementCreated', () => tile.classList.toggle('video-off', !state.camOn));
  publisher.on('audioLevelUpdated', (e) => tile.classList.toggle('speaking', state.micOn && e.audioLevel > 0.08));

  state.session.publish(publisher, (err) => {
    if (err) { console.error(err); toast(t(state.lang, 'errConnect', { msg: err.message })); return; }
    tile.classList.toggle('video-off', !state.camOn);
    startStt();
  });
  updateControls();
}

function subscribe(stream) {
  const id = stream.connection.connectionId;
  addParticipant(stream.connection);
  const tile = getTile(id);
  tile.classList.toggle('video-off', !stream.hasVideo);
  tile.classList.toggle('audio-off', !stream.hasAudio);
  const sub = state.session.subscribe(stream, tile.querySelector('.video'), VIDEO_OPTS, (err) => {
    if (err) console.error(err);
  });
  sub.on('audioLevelUpdated', (e) => tile.classList.toggle('speaking', e.audioLevel > 0.08));
  sub.on('destroyed', () => tile.classList.remove('speaking'));
}

// ---------------------------------------------------------------- マイク・カメラ・退出

function updateControls() {
  const lang = state.lang;
  const mic = $('#mic-btn');
  const cam = $('#cam-btn');
  mic.classList.toggle('is-off', !state.micOn);
  cam.classList.toggle('is-off', !state.camOn);
  mic.querySelector('.label').textContent = t(lang, state.micOn ? 'mute' : 'unmute');
  cam.querySelector('.label').textContent = t(lang, state.camOn ? 'videoOff' : 'videoOn');
}

function toggleMic() {
  state.micOn = !state.micOn;
  state.publisher?.publishAudio(state.micOn);
  const tile = getTile(state.session?.connection?.connectionId);
  tile?.classList.toggle('audio-off', !state.micOn);
  if (!state.micOn) tile?.classList.remove('speaking');
  // ミュート中は文字起こしも止める（Transcribe の課金も止まる）
  if (state.micOn) startStt(); else stopStt();
  updateControls();
}

function toggleCam() {
  state.camOn = !state.camOn;
  state.publisher?.publishVideo(state.camOn);
  getTile(state.session?.connection?.connectionId)?.classList.toggle('video-off', !state.camOn);
  updateControls();
}

function leave(reason) {
  if (state.leaving) return;
  state.leaving = true;
  clearInterval(state.timer);
  stopStt();
  try {
    if (state.publisher) state.session?.unpublish(state.publisher);
    state.publisher?.destroy();
  } catch { /* noop */ }
  state.session?.disconnect();
  state.session = null;
  state.publisher = null;
  clearTimeout(partialTimer);
  $('#grid').innerHTML = '';
  $('#captions').innerHTML = '';
  backToLogin(reason);
}

// 退出後はログイン画面に戻る。直前に入力したユーザー名・言語はそのまま残す
function backToLogin(reason) {
  $('#name').value = state.name;
  document.querySelector(`input[name=lang][value=${state.lang}]`).checked = true;
  const bgInput = document.querySelector(`input[name=bg][value="${state.background}"]`);
  if (bgInput) bgInput.checked = true;
  applyI18n(state.lang);
  const messages = {
    full: t(state.lang, 'errRoomFull', { n: state.join?.maxParticipants || 4 }),
    disconnected: t(state.lang, 'disconnected'),
    timeup: t(state.lang, 'timeup', { d: formatDuration(state.join?.meeting?.maxSeconds || 180) }),
  };
  loginError(messages[reason] || '');
}

// ---------------------------------------------------------------- 文字起こし

async function startStt() {
  if (!state.micOn || state.stt || !state.publisher || state.leaving) return;
  const handlers = {
    onPartial: (id, text) => onMyTranscript(id, text, false),
    onFinal: (id, text) => onMyTranscript(id, text, true),
    onError: (err) => { console.warn('STT error', err); },
  };
  let stt;
  if (STT_MODE === 'webspeech' && WebSpeechStt.isSupported()) {
    stt = new WebSpeechStt({ lang: state.lang, ...handlers });
  } else {
    stt = new TranscribeStt({
      audioContext: state.audioContext,
      getUrl: () => api('/api/transcribe-url', { lang: state.lang, ticket: state.join.ticket }),
      ...handlers,
    });
  }
  state.stt = stt;
  try {
    const track = state.publisher.getAudioSource();
    if (!track && STT_MODE !== 'webspeech') throw new Error('no audio track');
    await stt.start(track);
  } catch (err) {
    console.error(err);
    toast(t(state.lang, 'errStt'));
    if (state.stt === stt) state.stt = null;
  }
}

function stopStt() {
  state.stt?.stop();
  state.stt = null;
}

// 認識途中の結果は送信頻度を抑える（最新のものだけ送る）
let pendingPartial = null;
let partialTimer = null;
let lastPartialSentAt = 0;

function sendSignal(type, data) {
  if (!state.session) return;
  state.session.signal({ type, data: JSON.stringify(data) }, (err) => { if (err) console.warn('signal error', err); });
}

function flushPartial() {
  partialTimer = null;
  if (!pendingPartial) return;
  sendSignal('caption', pendingPartial);
  pendingPartial = null;
  lastPartialSentAt = Date.now();
}

function onMyTranscript(resultId, text, final) {
  const id = `${state.session?.connection?.connectionId}:${resultId}`;
  const msg = { id, text: text.slice(0, 1000), lang: state.lang, final };
  // 自分の字幕は原文のまま表示
  renderCaption(id, { who: state.name, main: text, partial: !final });

  if (!final) {
    pendingPartial = msg;
    if (!partialTimer) {
      const wait = Math.max(0, PARTIAL_SIGNAL_INTERVAL_MS - (Date.now() - lastPartialSentAt));
      partialTimer = setTimeout(flushPartial, wait);
    }
    return;
  }

  clearTimeout(partialTimer);
  partialTimer = null;
  pendingPartial = null;
  sendSignal('caption', msg);
  translateAndBroadcast(id, text);
}

async function translateAndBroadcast(id, text) {
  const context = state.history.slice(-4);
  state.history.push({ name: state.name, text });
  if (state.history.length > 10) state.history.shift();

  // 自分と違う言語の参加者がいるときだけ翻訳する
  const targets = [...new Set([...state.participants.values()].map((p) => p.lang))].filter((l) => l !== state.lang);
  if (!targets.length) return;
  try {
    const { translations } = await api('/api/translate', {
      text, from: state.lang, to: targets, context, ticket: state.join.ticket,
    });
    sendSignal('caption-tr', { id, translations });
  } catch (err) {
    console.warn('translate failed', err);
  }
}

// ---------------------------------------------------------------- 字幕の受信・表示

const pendingTranslations = new Map(); // 原文より先に訳文が届いた場合の保持

// 字幕 ID は「送信者の connectionId:連番」。他人の ID を名乗る signal（なりすまし字幕）は捨てる
function parseSignal(e, isValid) {
  const from = e.from?.connectionId;
  if (!from) return null;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return null; }
  if (!msg || typeof msg.id !== 'string' || !msg.id.startsWith(`${from}:`)) return null;
  return isValid(msg) ? msg : null;
}

function onCaptionSignal(e) {
  if (e.from?.connectionId === state.session?.connection?.connectionId) return; // 自分の分は表示済み
  const msg = parseSignal(e, (m) => typeof m.text === 'string' && typeof m.lang === 'string');
  if (!msg) return;
  const speaker = state.participants.get(e.from.connectionId);
  const who = speaker?.name || '?';
  if (msg.final) {
    state.history.push({ name: who, text: msg.text });
    if (state.history.length > 10) state.history.shift();
  }
  if (msg.lang === state.lang) {
    renderCaption(msg.id, { who, main: msg.text, partial: !msg.final });
    return;
  }
  // 言語が違う: 訳文が届くまでは原文を薄く表示
  const tr = pendingTranslations.get(msg.id);
  if (tr) {
    renderCaption(msg.id, { who, main: tr, orig: msg.text, partial: false });
    pendingTranslations.delete(msg.id);
  } else {
    renderCaption(msg.id, { who, main: msg.final ? t(state.lang, 'translating') : '…', orig: msg.text, partial: true });
  }
}

function onTranslationSignal(e) {
  if (e.from?.connectionId === state.session?.connection?.connectionId) return;
  const msg = parseSignal(e, (m) => m.translations && typeof m.translations === 'object');
  if (!msg) return;
  const text = msg.translations[state.lang];
  if (typeof text !== 'string' || !text) return;
  const el = document.querySelector(`.caption[data-id="${CSS.escape(msg.id)}"]`);
  if (!el) {
    pendingTranslations.set(msg.id, text);
    setTimeout(() => pendingTranslations.delete(msg.id), 30000);
    return;
  }
  const speaker = state.participants.get(e.from.connectionId);
  renderCaption(msg.id, { who: speaker?.name || '?', main: text, orig: el.dataset.orig, partial: false });
}

function renderCaption(id, { who, main, orig, partial }) {
  const box = $('#captions');
  let el = box.querySelector(`.caption[data-id="${CSS.escape(id)}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'caption';
    el.dataset.id = id;
    el.innerHTML = '<span class="who"></span><span class="main"></span><span class="orig"></span>';
    box.append(el);
    while (box.children.length > MAX_CAPTIONS) box.firstElementChild.remove();
  }
  el.querySelector('.who').textContent = who;
  const mainEl = el.querySelector('.main');
  mainEl.textContent = main;
  mainEl.classList.toggle('partial', !!partial);
  const origEl = el.querySelector('.orig');
  origEl.textContent = orig || '';
  origEl.hidden = !orig;
  if (orig) el.dataset.orig = orig;
  el.classList.remove('fade');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 450);
  }, CAPTION_TTL_MS);
}

// ---------------------------------------------------------------- 起動

window.addEventListener('pagehide', () => { if (state.session) leave('left'); });
// iOS Safari などの戻る/復帰でページがメモリから復元された場合は読み込み直す（古い画面のまま動かないように）
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
initLogin();
showView('#login-view');
