'use strict';

/* =========================================================================
   サーバー（Durable Object）と WebSocket でつながり、
   受け取った状態をそのまま画面に描く。画面はサーバーの状態の写し。
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CAT_LABELS = { nomi: '飲み会', kazoku: '家族' };
const ROOM_WORDS = [
  'うみがめ', 'ぺんぎん', 'さくら', 'らーめん', 'おんせん', 'かみなり',
  'たいやき', 'ひまわり', 'こたつ', 'まつり', 'たけのこ', 'きんぎょ',
  'はなび', 'みかん', 'とうふ', 'あじさい', 'かきごおり', 'ゆきだるま',
];

const me = {
  pid: null,
  name: '',
  room: '',
};

let ws = null;
let state = null;
let retry = 0;
let wantConnected = false;  // 参加中か。退出したら false にして自動再接続を止める
let killShown = -1;   // ドクロ演出を出したラウンド。同じラウンドで二度出さない
let inputRound = -1;  // 入力欄を空にしたラウンド。前の回答を持ち越さないため
let lastPhase = null; // 直前に描いたフェーズ。切り替わりを検知してカウントダウンを出す
let counting = false; // カウントダウン中は画面を描き替えない

/* ---------- 保存 ---------- */

function loadLocal() {
  try {
    me.pid = localStorage.getItem('zure.pid');
    if (!me.pid) {
      me.pid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      localStorage.setItem('zure.pid', me.pid);
    }
    me.name = localStorage.getItem('zure.name') || '';
    me.room = localStorage.getItem('zure.room') || '';
  } catch (e) {
    me.pid = String(Math.random()).slice(2) + Date.now();
  }
}

function saveLocal() {
  try {
    localStorage.setItem('zure.name', me.name);
    localStorage.setItem('zure.room', me.room);
  } catch (e) {}
}

function normRoom(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase().slice(0, 32);
}

/* ---------- 通信 ---------- */

function connect() {
  wantConnected = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws?room=' + encodeURIComponent(me.room));

  ws.onopen = () => {
    retry = 0;
    setNet(true);
    send({ t: 'join', pid: me.pid, name: me.name });
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'state') {
      state = m;
      render();
    }
  };

  ws.onclose = () => {
    setNet(false);
    // 電波が切れたときだけつなぎ直す。
    // 自分で退出した場合はつなぎ直さない（前の部屋に引き戻されるため）
    if (!wantConnected) return;
    retry++;
    setTimeout(() => { if (wantConnected) connect(); }, Math.min(500 * retry, 4000));
  };

  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setNet(ok) {
  $('netDot').classList.toggle('off', !ok);
}

/* カウントダウンの合図。iOSは vibrate が効かないので WebAudio で鳴らす。
   音が出せない環境でも進行を止めないよう、失敗は握りつぶす。 */
let audioCtx = null;
function beep(freq, ms) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.22, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + ms / 1000 + 0.02);
  } catch (e) { /* 音が出せなくても進行は止めない */ }
  try { if (navigator.vibrate) navigator.vibrate(90); } catch (e) {}
}

/* ---------- 画面切り替え ---------- */

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's' + '-' + id));
  $('topbar').hidden = (id === 'join');
}

/* 画面を消さない（回答待ちでロックされると進行が止まるため） */
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!wakeLock) keepAwake();
    // 復帰したら念のためつなぎ直す（参加中のときだけ）
    if (wantConnected && ws && ws.readyState !== WebSocket.OPEN) connect();
  }
});

/* =========================================================================
   描画
   ========================================================================= */

function render() {
  if (!state) return;

  $('barInfo').innerHTML =
    '<b>' + esc(me.room) + '</b> · ' + (CAT_LABELS[state.cat] || '') +
    (state.round > 0 ? ' · R' + state.round : '');

  if (!state.joined) { show('join'); lastPhase = null; return; }

  const prev = lastPhase;
  lastPhase = state.phase;

  // カウントダウン中に届いた状態は溜めておき、終わってからまとめて描く
  if (counting) return;

  // 回答が出そろった／全員が選び終わった瞬間だけ 3・2・1 をはさむ
  if ((prev === 'answer' && state.phase === 'review') ||
      (prev === 'review' && state.phase === 'result')) {
    runCountdown(state.phase === 'review' ? 'みんなの回答が出そろいました' : '全員が選び終わりました');
    return;
  }

  paintPhase();
}

function paintPhase() {
  switch (state.phase) {
    case 'lobby':  renderLobby();  show('lobby');  break;
    case 'answer': renderAnswer(); show('answer'); break;
    case 'review': renderReview(); show('review'); break;
    case 'result': renderResult(); show('result'); break;
  }
}

/** 3・2・1 を出してから次の画面へ。
    サーバーで待たせるとアラーム待ちで止まる事故が起きるので、
    各端末が受信直後に数える。ズレても0.5秒程度。 */
function runCountdown(caption) {
  counting = true;
  const box = $('countdown');
  const num = $('cdNum');
  $('cdCap').textContent = caption;
  box.hidden = false;

  let n = 3;
  let timer = null;
  let guard = null;

  // ここで例外が漏れると counting が立ったまま画面が固まる。
  // 実際に一度それでゲームが止まったので、二重に保険をかけてある。
  const finish = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (guard) { clearTimeout(guard); guard = null; }
    box.hidden = true;
    counting = false;
    try { paintPhase(); } catch (e) {}   // 溜まっていた最新の状態で描く
  };

  const tick = () => {
    try {
      num.textContent = n;
      num.classList.remove('tick');
      void num.offsetWidth;              // アニメーションを毎回やり直させる
      num.classList.add('tick');
      beep(n === 1 ? 990 : 660, 110);
    } catch (e) {}
  };

  tick();
  timer = setInterval(() => {
    n--;
    if (n <= 0) { finish(); return; }
    tick();
  }, 1000);

  // タイマーが動かない環境でも必ず抜ける
  guard = setTimeout(finish, 5000);
}

/* ---------- ロビー ---------- */

function renderLobby() {
  const ps = state.players;
  $('lobbyCount').textContent = ps.length + '人';

  $('lobbyRoster').innerHTML = ps.map((p) =>
    '<div class="prow' + (p.pid === state.you ? ' self' : '') + (p.connected ? '' : ' away') + '">' +
      '<span class="dot' + (p.connected ? '' : ' off') + '"></span>' +
      '<span class="nm">' + esc(p.name) + '</span>' +
      (p.connected ? '' : '<span class="st">切断中</span>') +
    '</div>'
  ).join('');

  $('catChips').innerHTML = Object.keys(CAT_LABELS).map((k) =>
    '<button type="button" class="chip' + (state.cat === k ? ' on' : '') + '" data-cat="' + k + '">' +
      CAT_LABELS[k] + '</button>'
  ).join('');

  const enough = ps.length >= state.minPlayers;
  $('startBtn').disabled = !enough;
  $('lobbyHint').textContent = enough
    ? '誰が押しても始まります'
    : 'あと' + (state.minPlayers - ps.length) + '人でスタートできます';
}

/* ---------- 回答 ---------- */

function renderAnswer() {
  // ラウンドが変わったら入力欄を空にする。
  // 残っていると前のラウンドの答えをそのまま送ってしまう
  if (inputRound !== state.round) {
    inputRound = state.round;
    $('answerInput').value = '';
    $('ansCount').textContent = '0';
    answerErr('');
  }

  const mine = state.players.find((p) => p.pid === state.you);

  // 途中から参加した人は次のラウンドを待つ
  if (mine && !mine.inRound) {
    $('myWords').innerHTML = '<div class="word">次のラウンドから参加します</div>';
    $('oddNote').hidden = true;
    $('answerForm').hidden = true;
    $('answerSend').hidden = true;
    $('answerEdit').hidden = true;
    $('answerDone').hidden = false;
    $('ansProgress').textContent = state.answeredCount + ' / ' + state.rosterCount;
    renderRoster($('answerRoster'), 'answered', '回答済み');
    paintDropButton($('dropAnswer'), 'answered');
    return;
  }

  $('myWords').innerHTML = (state.words || [])
    .map((w) => '<div class="word' +
      (w.length >= 8 ? ' longer' : w.length >= 6 ? ' long' : '') + '">' + esc(w) + '</div>').join('');
  $('oddNote').hidden = !state.youAreOdd;

  const answered = state.yourAnswer != null;
  $('answerForm').hidden = answered;
  $('answerSend').hidden = answered;
  $('answerDone').hidden = !answered;
  $('answerEdit').hidden = !answered;

  if (answered) {
    $('ansProgress').textContent = state.answeredCount + ' / ' + state.rosterCount;
    renderRoster($('answerRoster'), 'answered', '回答済み');
    paintDropButton($('dropAnswer'), 'answered');
  }
}

/** 切断したまま戻らない人のせいで進行が止まっていないか調べ、
    止まっていれば「待たずに進む」ボタンを出す。
    電池切れや誤ってタブを閉じた人がいると、放っておくと永久に進まない。 */
function paintDropButton(btn, flag) {
  const stuck = state.players.filter((p) => p.inRound && !p.connected && !p[flag]);
  if (!stuck.length) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = '切断中の ' + stuck.map((p) => p.name).join('、') + ' を待たずに進む';
  btn.onclick = () => stuck.forEach((p) => send({ t: 'drop', target: p.pid }));
}

function renderRoster(host, flag, doneLabel) {
  host.innerHTML = state.players.filter((p) => p.inRound).map((p) =>
    '<div class="prow' + (p.pid === state.you ? ' self' : '') + (p.connected ? '' : ' away') + '">' +
      '<span class="dot' + (p.connected ? '' : ' off') + '"></span>' +
      '<span class="nm">' + esc(p.name) + '</span>' +
      '<span class="st' + (p[flag] ? ' done' : '') + '">' + (p[flag] ? doneLabel : '…') + '</span>' +
    '</div>'
  ).join('');
}

/* ---------- 回答一覧と投票 ---------- */

function renderReview() {
  const mine = state.players.find((p) => p.pid === state.you);
  const playing = !!mine && mine.inRound;

  // 選び方の案内は上段の .notice に出しているので、ここはお題の確認だけ
  $('reviewHint').innerHTML = playing
    ? 'あなたのお題は <span class="words-inline">' +
      (state.words || []).map(esc).join('<span class="sep">/</span>') + '</span> でした。'
    : 'あなたは次のラウンドから参加します。このラウンドは見ているだけです。';

  // 並びは回答が届いた順。この順に質問していくので番号を振る
  $('reviewList').innerHTML = state.answers.map((a, i) => {
    const self = a.pid === state.you;
    const picked = state.yourVote === a.pid;
    const tappable = playing && !self;
    return '<div class="ans' + (self ? ' self' : '') + (picked ? ' picked' : '') + '"' +
      (tappable ? ' data-pid="' + esc(a.pid) + '"' : ' style="cursor:default"') + '>' +
      '<div class="who"><span class="no">' + (i + 1) + '</span>' + esc(a.name) +
        (self ? '<span class="badge">あなた</span>' : '') +
        (picked ? '<span class="badge pick">これを選択中</span>' : '') +
      '</div>' +
      '<div class="ans-text">' + esc(a.answer) + '</div>' +
    '</div>';
  }).join('');

  $('voteProgress').textContent = state.votedCount + ' / ' + state.answers.length;
  paintDropButton($('dropReview'), 'voted');
}

/* ---------- 結果 ---------- */

function renderResult() {
  const r = state.result;
  const byPid = {};
  state.answers.forEach((a) => { byPid[a.pid] = a; });
  const nameOf = (pid) => (byPid[pid] ? byPid[pid].name : '?');

  const majorWon = r.winner === 'major';
  $('verdict').className = 'verdict ' + (majorWon ? 'maj' : 'min');
  $('verdictLabel').textContent = majorWon ? '異端を当てた' : '異端が逃げ切った';
  $('verdictBig').textContent = majorWon ? '多数派の勝ち' : '異端の勝ち';

  // 違う1語だけ色を変えて出す
  const wordRow = (words) => words
    .map((w, i) => '<span' + (i === state.oddIndex ? ' class="diff"' : '') + '>' + esc(w) + '</span>')
    .join('');
  $('revMaj').innerHTML = wordRow(state.majorWords || []);
  $('revMin').innerHTML = wordRow(state.oddWords || []);

  // 殺害
  if (r.killed) {
    $('killNote').hidden = false;
    $('killNote').innerHTML =
      '<b>' + esc(nameOf(r.killed)) + ' は異端に殺害されました。</b><br>' +
      '異端の ' + esc(nameOf(state.wolfPid)) + ' と互いに選び合っていたためです。';
  } else {
    $('killNote').hidden = true;
  }

  // 誰が誰に投票したか
  const votersOf = {};
  state.answers.forEach((a) => {
    if (!a.vote) return;
    (votersOf[a.vote] = votersOf[a.vote] || []).push(a.name);
  });

  $('resultList').innerHTML = state.answers.map((a) => {
    const n = r.tally[a.pid] || 0;
    const isWolf = a.pid === state.wolfPid;
    const isTop = r.top.indexOf(a.pid) >= 0 && n > 0;
    const dead = r.killed === a.pid;
    return '<div class="ans' + (a.pid === state.you ? ' self' : '') + '" style="cursor:default">' +
      '<div class="who">' + esc(a.name) +
        (isWolf ? '<span class="badge wolf">異端</span>' : '') +
        (isTop ? '<span class="badge top">最多 ' + n + '票</span>' :
                 '<span class="badge">' + n + '票</span>') +
        (dead ? '<span class="badge dead">💀 殺害</span>' : '') +
      '</div>' +
      '<div class="ans-text">' + esc(a.answer) + '</div>' +
      (votersOf[a.pid] ? '<div class="voted-by">選んだ人: ' + esc(votersOf[a.pid].join('、')) + '</div>' : '') +
    '</div>';
  }).join('');

  // 殺害された本人にだけ、1ラウンドにつき1回だけ演出を出す
  if (state.youAreKilled && killShown !== state.round) {
    killShown = state.round;
    $('killBy').innerHTML =
      '異端の <b style="color:var(--text)">' + esc(nameOf(state.wolfPid)) + '</b> と<br>' +
      '互いに選び合っていました。';
    $('killScreen').hidden = false;
    if (navigator.vibrate) navigator.vibrate([120, 80, 120, 80, 260]);
  }
}

/* =========================================================================
   操作
   ========================================================================= */

/* --- 参加 --- */

$('nameInput').addEventListener('input', (e) => {
  $('nameCount').textContent = e.target.value.length;
});

$('joinGo').addEventListener('click', () => {
  const name = $('nameInput').value.trim();
  const room = normRoom($('roomInput').value);
  if (!name) { $('joinErr').hidden = false; $('joinErr').textContent = '名前を入れてください'; return; }
  if (!room) { $('joinErr').hidden = false; $('joinErr').textContent = 'あいことばを入れてください'; return; }
  $('joinErr').hidden = true;

  me.name = name;
  me.room = room;
  saveLocal();
  keepAwake();
  connect();
});

$('barLeave').addEventListener('click', () => {
  if (!confirm('退出しますか?')) return;
  send({ t: 'leave' });

  // 先に止めないと onclose が勝手につなぎ直して、元の部屋に戻ってしまう
  wantConnected = false;
  try { ws.close(); } catch (e) {}
  ws = null;
  state = null;
  inputRound = -1;

  // あいことばも忘れる。次に別の部屋へ入るとき邪魔になるため
  me.room = '';
  me.name = '';
  saveLocal();

  $('nameInput').value = '';
  $('nameCount').textContent = '0';
  $('roomInput').value = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  show('join');
});

/* --- ロビー --- */

$('catChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) send({ t: 'config', cat: b.dataset.cat });
});

$('startBtn').addEventListener('click', () => send({ t: 'start' }));

$('copyLink').addEventListener('click', async (e) => {
  const url = location.origin + location.pathname + '#' + encodeURIComponent(me.room);
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(url);
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'コピーしました';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1600);
});

/* --- 回答 --- */

$('answerInput').addEventListener('input', (e) => {
  $('ansCount').textContent = e.target.value.length;
});

$('answerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('answerSend').click(); }
});

function answerErr(msg) {
  const e = $('answerErr');
  e.hidden = !msg;
  e.textContent = msg || '';
}

$('answerSend').addEventListener('click', () => {
  const text = $('answerInput').value.trim();
  if (!text) { answerErr('あなたの答えを入れてください'); $('answerInput').focus(); return; }

  answerErr('');
  send({ t: 'answer', text });
});

$('answerEdit').addEventListener('click', () => {
  // サーバー側が消す前に、書いた内容を入力欄へ戻しておく
  $('answerInput').value = state.yourAnswer || '';
  $('ansCount').textContent = $('answerInput').value.length;
  answerErr('');
  send({ t: 'unanswer' });
});

/* --- 投票 --- */

$('reviewList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-pid]');
  if (!row) return;
  const pid = row.dataset.pid;
  send(state.yourVote === pid ? { t: 'unvote' } : { t: 'vote', target: pid });
});

/* --- 結果 --- */

$('killScreen').addEventListener('click', () => { $('killScreen').hidden = true; });
$('nextRound').addEventListener('click', () => send({ t: 'next' }));
$('backLobby').addEventListener('click', () => send({ t: 'lobby' }));

/* =========================================================================
   起動
   ========================================================================= */

function boot() {
  loadLocal();

  // 招待リンク（#あいことば）で来たら、あいことばを埋めておく
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h) me.room = normRoom(h);

  // 名前は入力欄に復元しない。前に使った名前が入っていると
  // 「なまえ」の例文なのか自分が入れた値なのか見分けがつかないし、
  // スマホを人に渡したときに前の人の名前が出てしまう。
  $('nameInput').value = '';
  $('nameCount').textContent = '0';
  $('roomInput').value = me.room || ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];

  // 最初の画面では自動でつながない。
  // 勝手につなぐと、別の部屋に入りたいときに前の部屋へ引き戻される
  show('join');
}

window.addEventListener('hashchange', () => {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h) $('roomInput').value = normRoom(h);
});

boot();
