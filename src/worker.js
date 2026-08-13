import { TOPIC_SETS, MISSIONS } from './topics.js';

/* =========================================================================
   入口。/ws だけを部屋（Durable Object）に回し、それ以外は public/ を返す。
   ========================================================================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('websocket only', { status: 426 });
      }
      const room = normRoom(url.searchParams.get('room'));
      if (!room) return new Response('room required', { status: 400 });

      // 同じあいことば＝同じ Durable Object＝同じ部屋
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

function normRoom(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase().slice(0, 32);
}

/* =========================================================================
   ゲームの状態
   ========================================================================= */

const MIN_PLAYERS = 3;
const NAME_MAX = 12;
const ANSWER_MAX = 40;

function newGame() {
  return {
    phase: 'lobby',       // lobby | answer | review | result
    round: 0,
    cat: 'nomi',
    missions: true,
    players: [],          // { pid, name, answer, vote, mission }
    roundPlayers: [],     // このラウンドに参加している pid（途中参加者は次から）
    wolfPid: null,
    major: null,
    minor: null,
    used: {},             // ジャンルごとの出題済みindex。部屋内でお題が重複しないように
    result: null,
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

/** まだ出していないお題を1組引く。全部出し切ったら履歴をリセットする。 */
function drawTopic(g) {
  const pool = TOPIC_SETS[g.cat].topics;
  let used = g.used[g.cat] || [];
  if (used.length >= pool.length) used = [];

  const remaining = [];
  for (let i = 0; i < pool.length; i++) if (used.indexOf(i) < 0) remaining.push(i);

  const idx = pick(remaining);
  g.used[g.cat] = used.concat([idx]);

  const pair = pool[idx];
  const flip = Math.random() < 0.5;   // どちらを多数派にするかは毎回入れ替える
  return { major: flip ? pair.b : pair.a, minor: flip ? pair.a : pair.b };
}

function startRound(g) {
  if (g.players.length < MIN_PLAYERS) return false;

  const t = drawTopic(g);
  g.major = t.major;
  g.minor = t.minor;

  g.roundPlayers = g.players.map((p) => p.pid);
  g.wolfPid = pick(g.roundPlayers);

  const missions = MISSIONS.slice().sort(() => Math.random() - 0.5);
  g.players.forEach((p, i) => {
    p.answer = null;
    p.vote = null;
    p.mission = g.missions ? missions[i % missions.length] : null;
  });

  g.round++;
  g.phase = 'answer';
  g.result = null;
  return true;
}

function inRound(g) {
  return g.players.filter((p) => g.roundPlayers.indexOf(p.pid) >= 0);
}

/** 投票の集計と、少数派による殺害の判定。 */
function computeResult(g) {
  const players = inRound(g);

  const tally = {};
  players.forEach((p) => {
    if (p.vote) tally[p.vote] = (tally[p.vote] || 0) + 1;
  });

  let max = 0;
  for (const k in tally) if (tally[k] > max) max = tally[k];
  const top = Object.keys(tally).filter((k) => tally[k] === max);

  // 最多票がちょうど1人で、それが少数派のときだけ多数派の勝ち。
  // 同数で割れた場合は捕まえられなかったとみなす。
  const caught = top.length === 1 && top[0] === g.wolfPid;

  // 殺害: 少数派が選んだ相手が、その相手も少数派を選んでいた場合（相互投票）
  let killed = null;
  const wolf = players.find((p) => p.pid === g.wolfPid);
  if (wolf && wolf.vote) {
    const target = players.find((p) => p.pid === wolf.vote);
    if (target && target.vote === g.wolfPid) killed = target.pid;
  }

  return { tally, top, caught, killed, winner: caught ? 'major' : 'minor' };
}

/* =========================================================================
   部屋（Durable Object）
   ========================================================================= */

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.g = null;
  }

  async load() {
    if (!this.g) this.g = (await this.ctx.storage.get('game')) || newGame();
    return this.g;
  }

  async persist() {
    await this.ctx.storage.put('game', this.g);
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // ハイバネーション対応で受ける。誰も触っていない部屋は課金対象にならない。
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 今つながっている pid の集合。
      切断直後は閉じたソケットがまだ getWebSockets() に残るので、
      close ハンドラからは自分自身を除外して数える。 */
  connectedPids(exclude) {
    const set = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (a && a.pid) set.add(a.pid);
    }
    return set;
  }

  broadcast(exclude) {
    const connected = this.connectedPids(exclude);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.pid) continue;
      try {
        ws.send(JSON.stringify(this.viewFor(a.pid, connected)));
      } catch (e) { /* 切れた接続は close 側で片付く */ }
    }
  }

  /** 画面ごとに見せてよい情報だけを詰めて返す。
      回答フェーズでお題を全員に配ってしまうと成立しないので、ここで絞る。 */
  viewFor(pid, connected) {
    const g = this.g;
    const me = g.players.find((p) => p.pid === pid) || null;
    const roster = inRound(g);

    const view = {
      t: 'state',
      phase: g.phase,
      round: g.round,
      cat: g.cat,
      missions: g.missions,
      you: pid,
      joined: !!me,
      minPlayers: MIN_PLAYERS,
      players: g.players.map((p) => ({
        pid: p.pid,
        name: p.name,
        connected: connected.has(p.pid),
        inRound: g.roundPlayers.indexOf(p.pid) >= 0,
        answered: p.answer != null,
        voted: p.vote != null,
      })),
    };

    // このラウンドに参加していない人（途中から来た人）にはお題を渡さない。
    // 渡してしまうと多数派のお題が場外に漏れる。
    const playing = !!me && g.roundPlayers.indexOf(pid) >= 0;

    if (g.phase === 'answer' || g.phase === 'review') {
      view.yourTopic = playing ? (pid === g.wolfPid ? g.minor : g.major) : null;
      view.yourMission = playing ? me.mission : null;
      view.yourAnswer = playing ? me.answer : null;
      view.answeredCount = roster.filter((p) => p.answer != null).length;
      view.rosterCount = roster.length;
    }

    if (g.phase === 'review') {
      view.answers = roster.map((p) => ({ pid: p.pid, name: p.name, answer: p.answer }));
      view.yourVote = playing ? me.vote : null;
      view.votedCount = roster.filter((p) => p.vote != null).length;
    }

    if (g.phase === 'result') {
      view.answers = roster.map((p) => ({
        pid: p.pid, name: p.name, answer: p.answer, vote: p.vote,
      }));
      view.major = g.major;
      view.minor = g.minor;
      view.wolfPid = g.wolfPid;
      view.yourMission = me ? me.mission : null;
      view.result = g.result;
      view.youAreKilled = !!(g.result && g.result.killed === pid);
    }

    return view;
  }

  async webSocketMessage(ws, raw) {
    const g = await this.load();

    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    const att = ws.deserializeAttachment() || {};
    const pid = m.t === 'join' ? clean(m.pid, 64) : att.pid;
    if (!pid) return;

    switch (m.t) {
      case 'join': {
        ws.serializeAttachment({ pid });
        const name = clean(m.name, NAME_MAX) || '名無し';
        const existing = g.players.find((p) => p.pid === pid);
        if (existing) {
          existing.name = name;                       // 再接続。席はそのまま
        } else {
          g.players.push({ pid, name, answer: null, vote: null, mission: null });
          // ラウンド中に来た人は、今のラウンドには入れず次から参加する
        }
        break;
      }

      case 'rename': {
        const p = g.players.find((x) => x.pid === pid);
        if (p) p.name = clean(m.name, NAME_MAX) || p.name;
        break;
      }

      case 'config': {
        if (g.phase !== 'lobby') break;
        if (m.cat && TOPIC_SETS[m.cat]) g.cat = m.cat;
        if (typeof m.missions === 'boolean') g.missions = m.missions;
        break;
      }

      case 'start': {
        if (g.phase !== 'lobby') break;
        startRound(g);
        break;
      }

      case 'answer': {
        if (g.phase !== 'answer') break;
        const p = g.players.find((x) => x.pid === pid);
        if (!p || g.roundPlayers.indexOf(pid) < 0) break;
        p.answer = clean(m.text, ANSWER_MAX);
        if (!p.answer) { p.answer = null; break; }
        if (inRound(g).every((x) => x.answer != null)) g.phase = 'review';
        break;
      }

      case 'unanswer': {
        if (g.phase !== 'answer') break;
        const p = g.players.find((x) => x.pid === pid);
        if (p) p.answer = null;
        break;
      }

      case 'vote': {
        if (g.phase !== 'review') break;
        const p = g.players.find((x) => x.pid === pid);
        if (!p || g.roundPlayers.indexOf(pid) < 0) break;
        if (m.target === pid) break;                          // 自分には投票できない
        if (g.roundPlayers.indexOf(m.target) < 0) break;
        p.vote = m.target;
        if (inRound(g).every((x) => x.vote != null)) {
          g.result = computeResult(g);
          g.phase = 'result';
        }
        break;
      }

      case 'unvote': {
        if (g.phase !== 'review') break;
        const p = g.players.find((x) => x.pid === pid);
        if (p) p.vote = null;
        break;
      }

      case 'next': {
        if (g.phase !== 'result') break;
        startRound(g);
        break;
      }

      case 'lobby': {
        g.phase = 'lobby';
        g.roundPlayers = [];
        g.result = null;
        g.wolfPid = null;
        g.major = null;
        g.minor = null;
        g.players.forEach((p) => { p.answer = null; p.vote = null; p.mission = null; });
        break;
      }

      case 'leave': {
        g.players = g.players.filter((p) => p.pid !== pid);
        g.roundPlayers = g.roundPlayers.filter((x) => x !== pid);
        break;
      }

      case 'ping':
        return;                                               // 保守用。状態は変えない
    }

    await this.persist();
    this.broadcast();
  }

  async webSocketClose(ws) {
    await this.load();
    this.broadcast(ws);
  }

  async webSocketError(ws) {
    await this.load();
    this.broadcast(ws);
  }
}
