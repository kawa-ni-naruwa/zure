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
let killShown = -1;   // ドクロ演出を出したラウンド。同じラウンドで二度出さない

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
    // 電波が切れても勝手につなぎ直す。パーティ中に手で操作させないため
    retry++;
    setTimeout(connect, Math.min(500 * retry, 4000));
  };

  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setNet(ok) {
  $('netDot').classList.toggle('off', !ok);
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
    // 復帰したら念のためつなぎ直す
    if (ws && ws.readyState !== WebSocket.OPEN) connect();
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

  if (!state.joined) { show('join'); return; }

  switch (state.phase) {
    case 'lobby':  renderLobby();  show('lobby');  break;
    case 'answer': renderAnswer(); show('answer'); break;
    case 'review': renderReview(); show('review'); break;
    case 'result': renderResult(); show('result'); break;
  }
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

  $('missionToggle').classList.toggle('on', !!state.missions);

  const enough = ps.length >= state.minPlayers;
  $('startBtn').disabled = !enough;
  $('lobbyHint').textContent = enough
    ? '誰が押しても始まります'
    : 'あと' + (state.minPlayers - ps.length) + '人でスタートできます';
}

/* ---------- 回答 ---------- */

function renderAnswer() {
  const mine = state.players.find((p) => p.pid === state.you);

  // 途中から参加した人は次のラウンドを待つ
  if (mine && !mine.inRound) {
    $('myTopic').textContent = '次のラウンドから参加します';
    $('myMissionBox').hidden = true;
    $('answerForm').hidden = true;
    $('answerSend').hidden = true;
    $('answerEdit').hidden = true;
    $('answerDone').hidden = false;
    $('ansProgress').textContent = state.answeredCount + ' / ' + state.rosterCount;
    renderRoster($('answerRoster'), 'answered', '回答済み');
    return;
  }

  $('myTopic').textContent = state.yourTopic || '';
  $('myMissionBox').hidden = !state.yourMission;
  if (state.yourMission) $('myMission').textContent = state.yourMission;

  const answered = state.yourAnswer != null;
  $('answerForm').hidden = answered;
  $('answerSend').hidden = answered;
  $('answerDone').hidden = !answered;
  $('answerEdit').hidden = !answered;

  if (answered) {
    $('ansProgress').textContent = state.answeredCount + ' / ' + state.rosterCount;
    renderRoster($('answerRoster'), 'answered', '回答済み');
  }
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

  $('reviewHint').innerHTML = playing
    ? '話し合ってから、1人を選んでください。<br>あなたのお題は「<b style="color:var(--text)">' +
      esc(state.yourTopic) + '</b>」でした。'
    : 'あなたは次のラウンドから参加します。このラウンドは見ているだけです。';

  $('reviewList').innerHTML = state.answers.map((a) => {
    const self = a.pid === state.you;
    const picked = state.yourVote === a.pid;
    const tappable = playing && !self;
    return '<div class="ans' + (self ? ' self' : '') + (picked ? ' picked' : '') + '"' +
      (tappable ? ' data-pid="' + esc(a.pid) + '"' : ' style="cursor:default"') + '>' +
      '<div class="who">' + esc(a.name) +
        (self ? '<span class="badge">あなた</span>' : '') +
        (picked ? '<span class="badge pick">これを選択中</span>' : '') +
      '</div>' +
      '<div class="ans-text">' + esc(a.answer) + '</div>' +
    '</div>';
  }).join('');

  $('voteProgress').textContent = state.votedCount + ' / ' + state.answers.length;
}

/* ---------- 結果 ---------- */

function renderResult() {
  const r = state.result;
  const byPid = {};
  state.answers.forEach((a) => { byPid[a.pid] = a; });
  const nameOf = (pid) => (byPid[pid] ? byPid[pid].name : '?');

  const majorWon = r.winner === 'major';
  $('verdict').className = 'verdict ' + (majorWon ? 'maj' : 'min');
  $('verdictLabel').textContent = majorWon ? '少数派を当てた' : '少数派が逃げ切った';
  $('verdictBig').textContent = majorWon ? '多数派の勝ち' : '少数派の勝ち';

  $('revMaj').textContent = state.major;
  $('revMin').textContent = state.minor;

  // 殺害
  if (r.killed) {
    $('killNote').hidden = false;
    $('killNote').innerHTML =
      '<b>' + esc(nameOf(r.killed)) + ' は少数派に殺害されました。</b><br>' +
      '少数派の ' + esc(nameOf(state.wolfPid)) + ' と互いに選び合っていたためです。';
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
        (isWolf ? '<span class="badge wolf">少数派</span>' : '') +
        (isTop ? '<span class="badge top">最多 ' + n + '票</span>' :
                 '<span class="badge">' + n + '票</span>') +
        (dead ? '<span class="badge dead">💀 殺害</span>' : '') +
      '</div>' +
      '<div class="ans-text">' + esc(a.answer) + '</div>' +
      (votersOf[a.pid] ? '<div class="voted-by">選んだ人: ' + esc(votersOf[a.pid].join('、')) + '</div>' : '') +
    '</div>';
  }).join('');

  if (state.yourMission) {
    $('resultMission').hidden = false;
    $('resultMission').innerHTML =
      'あなたのミッションは <b>' + esc(state.yourMission) + '</b><br>' +
      '順番に読み上げて、達成できたか申告しましょう。';
  } else {
    $('resultMission').hidden = true;
  }

  // 殺害された本人にだけ、1ラウンドにつき1回だけ演出を出す
  if (state.youAreKilled && killShown !== state.round) {
    killShown = state.round;
    $('killBy').innerHTML =
      '少数派の <b style="color:var(--text)">' + esc(nameOf(state.wolfPid)) + '</b> と<br>' +
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
  try { ws.close(); } catch (e) {}
  ws = null;
  state = null;
  show('join');
});

/* --- ロビー --- */

$('catChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) send({ t: 'config', cat: b.dataset.cat });
});

$('missionToggle').addEventListener('click', () => {
  send({ t: 'config', missions: !state.missions });
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

$('answerSend').addEventListener('click', () => {
  const text = $('answerInput').value.trim();
  if (!text) { $('answerInput').focus(); return; }
  send({ t: 'answer', text });
});

$('answerEdit').addEventListener('click', () => {
  send({ t: 'unanswer' });
  $('answerInput').value = state.yourAnswer || '';
  $('ansCount').textContent = $('answerInput').value.length;
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

  show('join');

  // 名前もあいことばも分かっているなら、そのままつなぐ（リロード復帰）
  if (me.name && me.room && !h) {
    keepAwake();
    connect();
  }
}

window.addEventListener('hashchange', () => {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h) $('roomInput').value = normRoom(h);
});

boot();
