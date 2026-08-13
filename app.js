'use strict';

/* =========================================================================
   決定論的な配役
   -------------------------------------------------------------------------
   サーバーを使わずに10人で同じゲームを共有するための仕組み。
   「あいことば・人数・ジャンル・ラウンド番号」の4つが同じなら、
   どのスマホで計算しても まったく同じ お題・少数派・発言順 が出る。

   注意: rng() を呼ぶ順番を変えると結果が変わる。deal() の中身をいじるときは
   呼び出し順を保つこと。
   ========================================================================= */

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** そのラウンドの中身を計算する。全端末でこの結果が一致する。 */
function deal() {
  const pool = TOPIC_SETS[S.cat].topics;

  // お題はシャッフルした「山札」から順に引く。毎回ランダムに選ぶと
  // 10ラウンド程度でも同じお題を引く確率がそこそこ高いため。
  // 山札のシードに人数を混ぜないので、途中で人が増減しても山札は続く。
  const deck = shuffled(pool, mulberry32(hash(S.code + '|' + S.cat + '|deck')));
  const pair = deck[(S.round - 1) % deck.length];

  const rng = mulberry32(hash(S.code + '|' + S.cat + '|' + S.n + '|' + S.round));
  const wolf = 1 + Math.floor(rng() * S.n);
  const flip = rng() < 0.5;               // どちらを多数派にするか毎回入れ替える
  const order = shuffled(seats(), rng);

  return {
    wolf: wolf,
    major: flip ? pair.b : pair.a,
    minor: flip ? pair.a : pair.b,
    order: order,
  };
}

/** 個人ミッション。お題とは別の乱数列を使うので、
    ミッションのON/OFFが人によって違ってもお題はズレない。 */
function myMission() {
  const rng = mulberry32(hash(S.code + '|' + S.n + '|' + S.round + '|mission'));
  const list = shuffled(MISSIONS, rng);
  return list[(S.seat - 1) % list.length];
}

/* =========================================================================
   状態
   ========================================================================= */

const STORE_KEY = 'zure.v1';

const S = {
  code: '',
  n: 10,
  cat: 'nomi',
  missions: true,
  seat: 0,
  round: 1,
};

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {}
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) Object.assign(S, JSON.parse(raw));
  } catch (e) {}
}

const COUNTS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const CODE_WORDS = [
  'うみがめ', 'ぺんぎん', 'さくら', 'らーめん', 'おんせん', 'かみなり',
  'たいやき', 'ひまわり', 'こたつ', 'まつり', 'たけのこ', 'きんぎょ',
  'はなび', 'みかん', 'とうふ', 'あじさい', 'かきごおり', 'ゆきだるま',
];

function seats() {
  const a = [];
  for (let i = 1; i <= S.n; i++) a.push(i);
  return a;
}

function normCode(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function randomCode() {
  const w = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
  return w;
}

/* =========================================================================
   小道具
   ========================================================================= */

const $ = (id) => document.getElementById(id);

/** チップ型の選択UIを作る */
function buildChips(host, items, getCurrent, onPick) {
  host.innerHTML = '';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = it.label;
    b.dataset.value = it.value;
    b.addEventListener('click', () => {
      onPick(it.value);
      syncChips(host, getCurrent());
    });
    host.appendChild(b);
  });
  syncChips(host, getCurrent());
}

function syncChips(host, current) {
  host.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('on', String(c.dataset.value) === String(current));
  });
}

function bindToggle(el, get, set) {
  const paint = () => el.classList.toggle('on', !!get());
  el.addEventListener('click', () => { set(!get()); paint(); save(); });
  paint();
}

/** ピッという合図。iOSはvibrateが効かないのでWebAudioで鳴らす。 */
let audioCtx = null;
function beep(freq, ms) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + ms / 1000 + 0.02);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(120);
}

function mmss(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/** カウントダウン。1つの画面につき1個使う。 */
function Countdown(valEl, capEl, onDone) {
  let total = 180, left = 180, timer = null;

  function paint() {
    valEl.textContent = mmss(left);
    valEl.classList.toggle('warn', left <= 10 && left > 0);
  }
  function tick() {
    left--;
    if (left <= 0) {
      left = 0; paint(); stop();
      capEl.textContent = '時間切れ';
      beep(880, 500);
      if (onDone) onDone();
      return;
    }
    paint();
  }
  function start() {
    if (timer) return;
    timer = setInterval(tick, 1000);
    capEl.textContent = 'タップで一時停止';
    beep(660, 90);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  return {
    set(sec) { total = sec; left = sec; stop(); paint(); capEl.textContent = 'タップでスタート'; },
    toggle() {
      if (timer) { stop(); capEl.textContent = 'タップで再開'; }
      else if (left <= 0) { left = total; paint(); start(); }
      else start();
    },
    reset() { stop(); left = total; paint(); capEl.textContent = 'タップでスタート'; },
    running() { return !!timer; },
  };
}

/* 画面を消さない（パーティ中にロックされるとストレスなので） */
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
});

/* =========================================================================
   画面遷移
   ========================================================================= */

const BARLESS = ['home', 'setup', 'join'];
let current = 'home';

function show(id) {
  current = id;
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('on', s.id === 's-' + id);
  });
  $('topbar').hidden = BARLESS.indexOf(id) >= 0;
  paintBar();
  window.scrollTo(0, 0);
}

function paintBar() {
  const cat = TOPIC_SETS[S.cat] ? TOPIC_SETS[S.cat].label : '';
  $('barInfo').innerHTML =
    '<b>' + S.code + '</b> · ' + S.n + '人 · ' + cat +
    (S.seat ? ' · <b>' + S.seat + '番</b>' : '');
  $('barRound').textContent = 'R' + S.round;
}

/* =========================================================================
   各画面
   ========================================================================= */

/* --- ホーム --- */
$('goSetup').addEventListener('click', () => {
  if (!S.code) S.code = randomCode();
  $('setupCode').value = S.code;
  show('setup');
  keepAwake();
});

$('goJoin').addEventListener('click', () => {
  $('joinCode').value = S.code;
  show('join');
  keepAwake();
});

/* --- 部屋をつくる --- */

const countItems = COUNTS.map((c) => ({ label: String(c), value: c }));
const catItems = Object.keys(TOPIC_SETS).map((k) => ({ label: TOPIC_SETS[k].label, value: k }));

buildChips($('setupN'), countItems, () => S.n, (v) => { S.n = Number(v); save(); });
buildChips($('setupCat'), catItems, () => S.cat, (v) => { S.cat = v; save(); });
bindToggle($('setupMission'), () => S.missions, (v) => { S.missions = v; });

$('setupCode').addEventListener('input', (e) => { S.code = normCode(e.target.value); save(); });

$('regen').addEventListener('click', () => {
  S.code = randomCode();
  $('setupCode').value = S.code;
  save();
});

function inviteURL() {
  return location.origin + location.pathname +
    '#r=' + encodeURIComponent(S.code) + '&n=' + S.n + '&c=' + S.cat + '&m=' + (S.missions ? 1 : 0);
}

$('copyLink').addEventListener('click', async (e) => {
  const url = inviteURL();
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

$('setupStart').addEventListener('click', () => {
  S.code = normCode($('setupCode').value) || randomCode();
  if (!S.code) return;
  S.round = 1;
  S.seat = 0;
  save();
  openSeat();
});

/* --- 部屋に入る --- */

buildChips($('joinN'), countItems, () => S.n, (v) => { S.n = Number(v); save(); });
buildChips($('joinCat'), catItems, () => S.cat, (v) => { S.cat = v; save(); });
bindToggle($('joinMission'), () => S.missions, (v) => { S.missions = v; });

$('joinBack').addEventListener('click', () => show('home'));

$('joinGo').addEventListener('click', () => {
  const c = normCode($('joinCode').value);
  if (!c) { $('joinCode').focus(); return; }
  S.code = c;
  S.seat = 0;
  save();
  openSeat();
});

/* --- 番号えらび --- */

function openSeat() {
  buildChips(
    $('seatGrid'),
    seats().map((i) => ({ label: String(i), value: i })),
    () => S.seat,
    (v) => {
      S.seat = Number(v);
      save();
      openCard();
    }
  );
  show('seat');
}

$('seatBack').addEventListener('click', () => show('home'));

/* --- お題 --- */

let revealed = false;

function openCard() {
  revealed = false;
  paintCard();
  show('card');
}

function paintCard() {
  const face = $('cardFace');
  const btn = $('cardNext');

  if (!revealed) {
    face.className = 'hidden-state';
    face.innerHTML =
      '<div class="eye">🤫</div>' +
      '<div class="tap">タップしてお題を見る</div>' +
      '<div class="warn">まわりに画面を見られないように</div>';
    btn.disabled = true;
    return;
  }

  const d = deal();
  const mine = (S.seat === d.wolf) ? d.minor : d.major;
  let html = '<div class="warn">あなたのお題</div><div id="topicText">' + esc(mine) + '</div>';

  if (S.missions) {
    html += '<div class="mission-box"><div class="ml">MISSION</div>' +
            '<div class="mv">' + esc(myMission()) + '</div></div>';
  }
  html += '<div class="warn" style="margin-top:6px">タップで隠す</div>';

  face.className = '';
  face.innerHTML = html;
  btn.disabled = false;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('cardFace').addEventListener('click', () => {
  revealed = !revealed;
  paintCard();
});

$('cardNext').addEventListener('click', () => {
  revealed = false;
  openOrder();
});

/* --- 発言順 --- */

let speakIdx = 0;
let speakTimer = null;

function openOrder() {
  const d = deal();
  speakIdx = 0;
  paintOrder(d);
  if (!speakTimer) {
    speakTimer = Countdown($('speakVal'), $('speakCap'), () => {
      const dd = deal();
      if (speakIdx < dd.order.length - 1) {
        speakIdx++;
        paintOrder(dd);
        speakTimer.set(20);
        speakTimer.toggle();
      }
    });
  }
  speakTimer.set(20);
  show('order');
}

function paintOrder(d) {
  const list = $('orderList');
  list.innerHTML = '';
  d.order.forEach((seat, i) => {
    const chip = document.createElement('span');
    chip.className = 'ochip' +
      (seat === S.seat ? ' me' : '') +
      (i === speakIdx ? ' now' : '') +
      (i < speakIdx ? ' done' : '');
    chip.textContent = seat;
    list.appendChild(chip);
  });

  const myPos = d.order.indexOf(S.seat) + 1;
  $('youAre').innerHTML = 'あなた（' + S.seat + '番）は <b>' + myPos + '番目</b> に発言します';
  $('speakWho').textContent = 'いま ' + d.order[speakIdx] + '番';
}

$('speakBox').addEventListener('click', () => { if (speakTimer) speakTimer.toggle(); });

$('speakSkip').addEventListener('click', () => {
  const d = deal();
  if (speakIdx < d.order.length - 1) speakIdx++;
  paintOrder(d);
  speakTimer.set(20);
  speakTimer.toggle();
});

$('orderNext').addEventListener('click', () => {
  if (speakTimer) speakTimer.reset();
  openTalk();
});

/* --- 質問タイム --- */

let talkTimer = null;
let talkLen = 180;

function openTalk() {
  if (!talkTimer) talkTimer = Countdown($('talkVal'), $('talkCap'), null);
  talkTimer.set(talkLen);
  show('talk');
}

buildChips(
  $('talkPresets'),
  [{ label: '2分', value: 120 }, { label: '3分', value: 180 }, { label: '5分', value: 300 }],
  () => talkLen,
  (v) => { talkLen = Number(v); talkTimer.set(talkLen); }
);

$('talkVal').parentElement.addEventListener('click', () => talkTimer.toggle());
$('talkNext').addEventListener('click', () => { talkTimer.reset(); show('vote'); });

/* --- 投票 → 結果 --- */

$('voteBack').addEventListener('click', () => show('talk'));
$('voteReveal').addEventListener('click', () => {
  paintReveal();
  show('reveal');
});

function paintReveal() {
  const d = deal();
  const iAmWolf = (S.seat === d.wolf);

  const v = $('verdict');
  v.className = 'verdict ' + (iAmWolf ? 'min' : 'maj');
  $('verdictLabel').textContent = iAmWolf ? 'あなたは' : 'あなたは';
  $('verdictBig').textContent = iAmWolf ? '少数派でした' : '多数派でした';

  $('revWolf').textContent = d.wolf + '番';
  $('revMaj').textContent = d.major;
  $('revMin').textContent = d.minor;

  const mBox = $('revMission');
  if (S.missions) {
    mBox.hidden = false;
    mBox.innerHTML = 'あなたのミッションは <b>' + esc(myMission()) + '</b><br>' +
      '順番に読み上げて、達成できたか申告しましょう。';
  } else {
    mBox.hidden = true;
  }
  beep(iAmWolf ? 520 : 780, 220);
}

$('revBack').addEventListener('click', () => show('vote'));

$('nextRound').addEventListener('click', () => {
  S.round++;
  save();
  openCard();
});

/* --- 上部バー --- */

$('barLeave').addEventListener('click', () => {
  S.seat = 0;
  save();
  show('home');
});

$('roundDown').addEventListener('click', (e) => {
  e.stopPropagation();
  if (S.round > 1) { S.round--; save(); paintBar(); if (current === 'card') { revealed = false; paintCard(); } }
});
$('roundUp').addEventListener('click', (e) => {
  e.stopPropagation();
  S.round++; save(); paintBar(); if (current === 'card') { revealed = false; paintCard(); }
});

/* =========================================================================
   起動
   ========================================================================= */

/** 招待リンク（#r=...）を読んで設定を上書きし、番号えらびへ直行する。
    取り込めたら true。 */
function applyInvite() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;

  const p = new URLSearchParams(h);
  if (!p.get('r')) return false;

  S.code = normCode(p.get('r'));
  if (p.get('n')) S.n = Number(p.get('n'));
  if (p.get('c') && TOPIC_SETS[p.get('c')]) S.cat = p.get('c');
  if (p.get('m') !== null) S.missions = p.get('m') === '1';
  S.seat = 0;
  S.round = 1;
  save();

  // 設定画面のUIも合わせておく（あとから「設定を変える」で開いたとき用）
  syncChips($('setupN'), S.n);
  syncChips($('setupCat'), S.cat);
  syncChips($('joinN'), S.n);
  syncChips($('joinCat'), S.cat);
  $('setupMission').classList.toggle('on', S.missions);
  $('joinMission').classList.toggle('on', S.missions);
  $('setupCode').value = S.code;
  $('joinCode').value = S.code;

  history.replaceState(null, '', location.pathname);
  keepAwake();
  openSeat();
  return true;
}

// すでにこのページを開いている状態で招待リンクを踏むと、
// ブラウザは既存タブのハッシュを変えるだけでリロードしない。
window.addEventListener('hashchange', applyInvite);

function boot() {
  load();
  if (applyInvite()) return;

  // ゲームの途中で画面を閉じた／リロードしてしまった場合はそのまま復帰する
  if (S.code && S.seat) {
    $('setupCode').value = S.code;
    $('joinCode').value = S.code;
    keepAwake();
    openCard();
    return;
  }

  show('home');
}

boot();
