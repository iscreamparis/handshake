// PwaPhaser — tests du relay (server/relay.mjs).
//
// Lance TOI-MÊME une instance de relay sur un PORT DE TEST (8997) via
// child_process — on ne touche NI au relay local (8999) NI à la prod. Chaque
// cas affiche PASS/FAIL ; le process sort avec un code non-zéro si un cas échoue.
//
//   node server/relay.test.mjs
//
// Couvre : appariement + relais d'action (les deux sens), action malformée
// ignoré (le pair ne reçoit rien), 10 acts malformés → socket fermée, flood
// > 20 msg/s → fermée « rate limited », message géant (> 4 Ko) → ignoré,
// unqueue → unqueued, opp_left à la déconnexion.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = 8997;
const URL = `ws://127.0.0.1:${PORT}`;
// Fenêtre de reprise raccourcie pour le test (90 s en prod) : on veut observer
// AUSSI son expiration sans y passer la minute et demie.
const GRACE_MS = 2500;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function ok(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  -> ' + detail : ''}`);
  if (!cond) failures++;
}

/** Petit client WS avec file de messages + attentes par prédicat. */
class C {
  constructor() {
    this.ws = new WebSocket(URL);
    this.msgs = [];
    this.closed = false;
    this._waiters = [];
    this.ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { m = { _raw: d.toString() }; }
      this.msgs.push(m); this._pump();
    });
    this.ws.on('close', () => { this.closed = true; this._pump(); });
    this.ws.on('error', () => {}); // fermetures brutales attendues dans certains cas
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); } catch { /* socket fermée */ } }
  sendRaw(s) { try { this.ws.send(s); } catch { /* socket fermée */ } }
  _pump() {
    for (const w of this._waiters.slice()) {
      if (w.kind === 'close') { if (this.closed) { this._remove(w); w.resolve(); } continue; }
      const idx = this.msgs.findIndex((m, i) => i >= w.from && w.pred(m));
      if (idx >= 0) { this._remove(w); w.resolve(this.msgs[idx]); }
    }
  }
  _remove(w) {
    const i = this._waiters.indexOf(w);
    if (i >= 0) this._waiters.splice(i, 1);
    if (w.timer) clearTimeout(w.timer);
  }
  waitMsg(pred, ms = 1500, from = 0) {
    return new Promise((resolve, reject) => {
      const w = { kind: 'msg', pred, from, resolve };
      w.timer = setTimeout(() => { this._remove(w); reject(new Error('timeout')); }, ms);
      this._waiters.push(w); this._pump();
    });
  }
  waitClose(ms = 1500) {
    return new Promise((resolve, reject) => {
      const w = { kind: 'close', resolve };
      w.timer = setTimeout(() => { this._remove(w); reject(new Error('timeout')); }, ms);
      this._waiters.push(w); this._pump();
    });
  }
  /** true si AUCUN message satisfaisant `pred` n'arrive dans `ms` (à partir de `from`). */
  async expectNone(pred, ms = 400, from = 0) {
    try { await this.waitMsg(pred, ms, from); return false; } catch { return true; }
  }
  mark() { return this.msgs.length; }
}

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['relay.mjs'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT), RESUME_GRACE_MS: String(GRACE_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const to = setTimeout(() => reject(new Error('relay start timeout')), 6000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening')) { clearTimeout(to); resolve(child); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[relay-err] ' + d));
    child.on('exit', (code) => { if (code) reject(new Error('relay exited ' + code)); });
  });
}

async function run() {
  // ── 1) Appariement v2 + relais d'act valide (les deux sens) ───────────────
  const c1 = new C(); const c2 = new C();
  await Promise.all([c1.open(), c2.open()]);

  c1.send({ t: 'queue', payload: { name: 'yang' } });
  await c1.waitMsg((m) => m.t === 'queued');
  c2.send({ t: 'queue', payload: { name: 'yin' } });
  const m1 = await c1.waitMsg((m) => m.t === 'matched');
  const m2 = await c2.waitMsg((m) => m.t === 'matched');
  ok('appariement : les deux pairs reçoivent la même seed',
    m1.youAre === 0 && m2.youAre === 1 && m1.seed === m2.seed,
    JSON.stringify({ a: m1.youAre, b: m2.youAre, s1: m1.seed, s2: m2.seed }));
  ok('la charge utile de mise en file est transmise telle quelle au pair',
    m1.opp && m1.opp.name === 'yin' && m2.opp && m2.opp.name === 'yang',
    JSON.stringify({ a: m1.opp, b: m2.opp }));

  let mk = c2.mark();
  c1.send({ t: 'act', a: { k: 'move', x: 3, y: 7 } });
  const a2 = await c2.waitMsg((m) => m.t === 'act', 1500, mk).catch(() => null);
  ok('action relayée hôte -> invité', !!a2 && a2.a && a2.a.k === 'move');

  mk = c1.mark();
  c2.send({ t: 'act', a: { k: 'fire', target: 2 } });
  const a1 = await c1.waitMsg((m) => m.t === 'act', 1500, mk).catch(() => null);
  ok('action relayée invité -> hôte', !!a1 && a1.a && a1.a.k === 'fire');

  // ── 2) Act malformé ignoré (le pair ne reçoit rien) ───────────────────────
  // Le relay est agnostique au jeu : toute action OBJET bornée est acceptée.
  // Ce qui est rejeté, c'est ce qui n'est pas un objet, ou ce qui est trop
  // profond / trop large (garde-fous anti-charge utile abusive).
  mk = c2.mark();
  c1.send({ t: 'act', a: 'pas un objet' });
  const none = await c2.expectNone((m) => m.t === 'act', 400, mk);
  ok('act non-objet non relayé (pair silencieux)', none && !c1.closed);

  mk = c2.mark();
  let deep = { k: 'deep' };
  for (let i = 0; i < 12; i++) deep = { nested: deep };
  c1.send({ t: 'act', a: deep });
  const noneDeep = await c2.expectNone((m) => m.t === 'act', 400, mk);
  ok('act trop profond non relayé', noneDeep);

  // ── 5) Message géant (> 4 Ko) ignoré (le pair ne reçoit rien) ─────────────
  mk = c2.mark();
  c1.sendRaw(JSON.stringify({ t: 'act', a: { k: 'end' }, pad: 'x'.repeat(5000) }));
  const noneBig = await c2.expectNone((m) => m.t === 'act', 400, mk);
  ok('message géant (>4 Ko) ignoré', noneBig && !c1.closed);

  // ── 7) Coupure BRUTALE : sursis (opp_dropped), la partie n'est PAS finie ──
  // (Après le test 1, chaque camp a envoyé 1 act : recv = [1, 1].)
  ok('jeton de reprise fourni à l\'appariement', typeof m1.token === 'string' && typeof m2.token === 'string'
    && m1.token !== m2.token);
  const dropP = c2.waitMsg((m) => m.t === 'opp_dropped', 1500);
  c1.ws.close();                       // pas de `bye` : le tunnel saute
  const dropped = await dropP.then(() => true).catch(() => false);
  ok('coupure brutale -> opp_dropped (partie en sursis)', dropped);
  const noLeft = await c2.expectNone((m) => m.t === 'opp_left', 400);
  ok('coupure brutale -> PAS de opp_left immédiat', noLeft);

  // Le survivant continue de jouer : ses actions sont journalisées pour le
  // revenant (le relay ne les perd pas, même sans socket en face).
  c2.send({ t: 'act', a: { k: 'end' }, n: 2 });

  // ── 8) Reprise avec jeton : resumed + rejeu de ce qui a été manqué ────────
  const c1b = new C(); await c1b.open();
  const backP = c2.waitMsg((m) => m.t === 'opp_back', 1500, c2.mark());
  c1b.send({ t: 'resume', token: m1.token, have: 1 });
  const res = await c1b.waitMsg((m) => m.t === 'resumed', 1500).catch(() => null);
  ok('reprise acceptée (resumed + ack de mes actions reçues)', !!res && res.ack === 1,
    JSON.stringify(res));
  const replay = await c1b.waitMsg((m) => m.t === 'act', 1500).catch(() => null);
  ok('actions manquées rejouées au revenant', !!replay && replay.a.k === 'end' && replay.n === 2,
    JSON.stringify(replay));
  const back = await backP.then(() => true).catch(() => false);
  ok('le pair est prévenu du retour (opp_back)', back);

  // Renvoi d'une action déjà reçue par le serveur (le client rejoue son outbox
  // au-delà de `ack`) : dédoublonnée, le pair ne la voit pas deux fois.
  mk = c2.mark();
  c1b.send({ t: 'act', a: { k: 'move', x: 3, y: 7 }, n: 1 });
  const noDup = await c2.expectNone((m) => m.t === 'act', 400, mk);
  ok('action renvoyée après reprise -> dédoublonnée', noDup);

  // La partie continue normalement sur la nouvelle socket.
  mk = c2.mark();
  c1b.send({ t: 'act', a: { k: 'end' }, n: 2 });
  const after = await c2.waitMsg((m) => m.t === 'act', 1500, mk).catch(() => null);
  ok('duel relayé normalement après reprise', !!after && after.a.k === 'end');

  // ── 8a bis) Une LISTE légitime passe (regression : un deck de 30 cartes ────
  // était refusé parce que les éléments d'un tableau étaient comptés contre la
  // limite de CLÉS d'un objet.)
  mk = c2.mark();
  c1b.send({ t: 'act', a: { k: 'deck', ids: Array.from({ length: 30 }, (_, i) => i) } });
  const deck = await c2.waitMsg((m) => m.t === 'act' && m.a.k === 'deck', 1500, mk).catch(() => null);
  ok('liste de 30 entiers relayée (deck)', !!deck && deck.a.ids.length === 30);

  // …mais un tableau vraiment pathologique reste refusé.
  mk = c2.mark();
  c1b.send({ t: 'act', a: { k: 'flood', ids: Array.from({ length: 900 }, (_, i) => i) } });
  const flood = await c2.expectNone((m) => m.t === 'act' && m.a.k === 'flood', 400, mk);
  ok('tableau de 900 éléments refusé', flood);

  // ── 8b) ACQUITTEMENT de chaque action acceptée ────────────────────────────
  // Sans ack, un client dont la socket est « à moitié ouverte » émet dans le
  // vide sans jamais le savoir (le bug « il a cliqué fin de tour, je n'ai rien
  // reçu »). L'ack est ce qui lui permet de détecter le trou.
  mk = c1b.mark();
  c1b.send({ t: 'act', a: { k: 'end' }, n: 3 });
  const ack = await c1b.waitMsg((m) => m.t === 'ack', 1500, mk).catch(() => null);
  ok('action acceptée -> ack avec son n°', !!ack && ack.n === 3, JSON.stringify(ack));
  mk = c1b.mark();
  c1b.send({ t: 'act', a: { k: 'end' }, n: 3 });           // doublon
  const ackDup = await c1b.waitMsg((m) => m.t === 'ack', 1500, mk).catch(() => null);
  ok('doublon -> ré-acquitté (l\'outbox du client se vide quand même)', !!ackDup && ackDup.n === 3);

  // ── 8c) Sonde de vivacité applicative ─────────────────────────────────────
  mk = c1b.mark();
  c1b.send({ t: 'ping' });
  const pong = await c1b.waitMsg((m) => m.t === 'pong', 1500, mk).then(() => true).catch(() => false);
  ok('ping -> pong', pong);

  // ── 8d) SOCKET ZOMBIE : la reprise tue l'ancienne et ses actions en vol ne
  //        polluent plus la salle. C'est LA cause du duel bloqué : une action
  //        arrivant par la socket remplacée était attribuée au camp d'en face,
  //        ce qui gonflait le compteur de l'adversaire et faisait rejeter ses
  //        vraies actions suivantes comme doublons.
  const cz = new C(); const cz2 = new C();
  await Promise.all([cz.open(), cz2.open()]);
  cz.send({ t: 'queue', payload: { name: 'yang' } });
  await cz.waitMsg((m) => m.t === 'queued', 1500);
  cz2.send({ t: 'queue', payload: { name: 'yin' } });
  const mz1 = await cz.waitMsg((m) => m.t === 'matched', 1500);
  await cz2.waitMsg((m) => m.t === 'matched', 1500);
  // side 0 envoie une action, puis « revient » sur une NOUVELLE socket sans que
  // l'ancienne soit fermée (exactement le cas demi-ouvert).
  cz.send({ t: 'act', a: { k: 'end' }, n: 1 });
  await cz2.waitMsg((m) => m.t === 'act', 1500);
  const czNew = new C(); await czNew.open();
  czNew.send({ t: 'resume', token: mz1.token, have: 0 });
  await czNew.waitMsg((m) => m.t === 'resumed', 1500);
  const zombieKilled = await cz.waitClose(2000).then(() => true).catch(() => false);
  ok('reprise -> l\'ancienne socket est TUÉE (plus de zombie)', zombieKilled);
  // Une action en vol arrivant par la zombie ne doit rien casser : le pair ne
  // reçoit rien et son propre compteur reste intact.
  mk = cz2.mark();
  cz.send({ t: 'act', a: { k: 'end' }, n: 2 });   // socket morte : sans effet
  const zombieSilent = await cz2.expectNone((m) => m.t === 'act', 500, mk);
  ok('action venue d\'une socket zombie -> jamais relayée', zombieSilent);
  // Et le duel continue normalement pour le pair.
  mk = czNew.mark();
  cz2.send({ t: 'act', a: { k: 'end' }, n: 1 });
  const stillAlive = await czNew.waitMsg((m) => m.t === 'act', 1500, mk).catch(() => null);
  ok('le duel continue après la reprise', !!stillAlive && stillAlive.a.k === 'end');
  try { cz2.ws.close(); czNew.ws.close(); } catch { /* */ }

  // ── 9) Jeton inconnu -> reprise refusée ───────────────────────────────────
  const c9 = new C(); await c9.open();
  c9.send({ t: 'resume', token: 'a'.repeat(36), have: 0 });
  const badTok = await c9.waitMsg((m) => m.t === 'error' && m.reason === 'resume expired', 1500)
    .then(() => true).catch(() => false);
  ok('jeton inconnu -> « resume expired »', badTok);
  try { c9.ws.close(); } catch { /* */ }

  // ── 10) Départ VOLONTAIRE (bye) -> opp_left immédiat (pas de sursis) ──────
  const byeP = c2.waitMsg((m) => m.t === 'opp_left', 1500, c2.mark());
  c1b.send({ t: 'bye' });
  const byeLeft = await byeP.then(() => true).catch(() => false);
  ok('bye -> opp_left immédiat (pas de sursis)', byeLeft);
  try { c1b.ws.close(); c2.ws.close(); } catch { /* */ }

  // ── 11) Sursis expiré sans reprise -> opp_left ────────────────────────────
  const c6 = new C(); const c7 = new C();
  await Promise.all([c6.open(), c7.open()]);
  c6.send({ t: 'queue', payload: { name: 'yang' } });
  await c6.waitMsg((m) => m.t === 'queued');
  c7.send({ t: 'queue', payload: { name: 'yin' } });
  await c7.waitMsg((m) => m.t === 'matched');
  c6.ws.close();
  await c7.waitMsg((m) => m.t === 'opp_dropped', 1500);
  const expired = await c7.waitMsg((m) => m.t === 'opp_left', GRACE_MS + 1500)
    .then(() => true).catch(() => false);
  ok('fenêtre de reprise expirée -> opp_left', expired);
  try { c7.ws.close(); } catch { /* */ }

  // ── 3) 10 acts malformés → socket fermée ──────────────────────────────────
  const c3 = new C(); await c3.open();
  for (let i = 0; i < 10; i++) c3.send({ t: 'act', a: 'malforme-' + i });
  const closed3 = await c3.waitClose(1500).then(() => true).catch(() => false);
  ok('10 acts malformés -> socket fermée', closed3);

  // ── 4) Flood > 20 msg/s → fermée avec raison « rate limited » ──────────────
  const c4 = new C(); await c4.open();
  const errP = c4.waitMsg((m) => m.t === 'error' && m.reason === 'rate limited', 2000);
  for (let i = 0; i < 30; i++) c4.send({ t: 'unqueue' });
  const rl = await errP.then(() => true).catch(() => false);
  const closed4 = await c4.waitClose(2000).then(() => true).catch(() => false);
  ok('flood > 20 msg/s -> erreur « rate limited »', rl);
  ok('flood > 20 msg/s -> socket fermée', closed4);

  // ── 6) unqueue → unqueued ─────────────────────────────────────────────────
  const c5 = new C(); await c5.open();
  c5.send({ t: 'queue', payload: { name: 'yang' } });
  await c5.waitMsg((m) => m.t === 'queued', 1500);
  c5.send({ t: 'unqueue' });
  const uq = await c5.waitMsg((m) => m.t === 'unqueued', 1500).then(() => true).catch(() => false);
  ok('unqueue -> unqueued', uq);
  try { c5.ws.close(); } catch { /* */ }

  await runMultiplayer();
}

// ═══════════════════════════════════════════════════════════════════════════
// MODE N JOUEURS (2 à 4) — ce que le relay ne savait pas faire.
//
// Tout ce qui précède valide le 1v1 tour par tour et doit rester vert TEL QUEL :
// c'est la preuve que la généralisation n'a rien changé pour Kekkai V2, qui
// tourne en production sur ce protocole. Ce qui suit valide ce qui est neuf.
// ═══════════════════════════════════════════════════════════════════════════
async function runMultiplayer() {
  // ── 12) Appariement à TROIS : même seed, sièges 0/1/2, charges de tous ────
  const p = [new C(), new C(), new C()];
  await Promise.all(p.map((c) => c.open()));
  p[0].send({ t: 'queue', players: 3, payload: { name: 'a' } });
  await p[0].waitMsg((m) => m.t === 'queued');
  p[1].send({ t: 'queue', players: 3, payload: { name: 'b' } });
  await p[1].waitMsg((m) => m.t === 'queued');
  const notYet = await p[0].expectNone((m) => m.t === 'matched', 300);
  ok('file à 3 : deux joueurs ne suffisent pas à démarrer', notYet);
  p[2].send({ t: 'queue', players: 3, payload: { name: 'c' } });
  const M = await Promise.all(p.map((c) => c.waitMsg((m) => m.t === 'matched', 1500)));
  ok('appariement à 3 : sièges 0/1/2 distincts',
    M[0].youAre === 0 && M[1].youAre === 1 && M[2].youAre === 2,
    JSON.stringify(M.map((m) => m.youAre)));
  ok('appariement à 3 : une seule et même seed',
    M[0].seed === M[1].seed && M[1].seed === M[2].seed);
  ok('appariement à 3 : `players` annoncé', M.every((m) => m.players === 3));
  ok('appariement à 3 : `opps` porte la charge des trois sièges',
    Array.isArray(M[0].opps) && M[0].opps.length === 3
    && M[0].opps[0].name === 'a' && M[0].opps[1].name === 'b' && M[0].opps[2].name === 'c',
    JSON.stringify(M[0].opps));
  ok('appariement à 3 : jetons de reprise tous différents',
    new Set(M.map((m) => m.token)).size === 3);

  // ── 13) Les files sont séparées PAR FORMAT ────────────────────────────────
  // Un joueur qui veut du 1v1 ne doit jamais être aspiré dans une partie à 4.
  const solo = new C(); await solo.open();
  solo.send({ t: 'queue', payload: { name: 'duo' } });
  await solo.waitMsg((m) => m.t === 'queued');
  const q4 = [new C(), new C()];
  await Promise.all(q4.map((c) => c.open()));
  for (const c of q4) c.send({ t: 'queue', players: 4, payload: null });
  const soloUntouched = await solo.expectNone((m) => m.t === 'matched', 500);
  ok('les files sont séparées par format (1v1 pas aspiré par une file à 4)', soloUntouched);
  solo.send({ t: 'unqueue' });
  await solo.waitMsg((m) => m.t === 'unqueued', 1500).catch(() => null);
  try { solo.ws.close(); for (const c of q4) c.ws.close(); } catch { /* */ }

  // ── 14) Une action est DIFFUSÉE à tous les autres, avec le siège émetteur ──
  let mk1 = p[1].mark(), mk2 = p[2].mark();
  p[0].send({ t: 'act', a: { k: 'move', x: 1 }, n: 1 });
  const r1 = await p[1].waitMsg((m) => m.t === 'act', 1500, mk1).catch(() => null);
  const r2 = await p[2].waitMsg((m) => m.t === 'act', 1500, mk2).catch(() => null);
  ok('action diffusée aux DEUX autres sièges', !!r1 && !!r2);
  ok('action estampillée du siège émetteur (`from`)',
    !!r1 && r1.from === 0 && !!r2 && r2.from === 0, JSON.stringify([r1 && r1.from, r2 && r2.from]));

  // ── 15) Les n° de séquence sont INDÉPENDANTS d'un siège à l'autre ─────────
  // Piège du 1v1 : un compteur unique par salle rejetterait le n°1 du siège 2
  // comme doublon du n°1 du siège 1 — l'action disparaîtrait en silence.
  mk1 = p[0].mark();
  p[1].send({ t: 'act', a: { k: 'seat1' }, n: 1 });
  p[2].send({ t: 'act', a: { k: 'seat2' }, n: 1 });
  const got1 = await p[0].waitMsg((m) => m.t === 'act' && m.a.k === 'seat1', 1500, mk1).catch(() => null);
  const got2 = await p[0].waitMsg((m) => m.t === 'act' && m.a.k === 'seat2', 1500, mk1).catch(() => null);
  ok('n° de séquence indépendants par siège (n=1 des sièges 1 ET 2 passent)',
    !!got1 && !!got2 && got1.from === 1 && got2.from === 2);

  // ── 16) Reprise à 3 : `have` par SIÈGE, rejeu sélectif ────────────────────
  // Le siège 0 a tout reçu du siège 1 (n=1) mais rien du siège 2 : seul le
  // second doit lui être rejoué. Avec le `have` scalaire du 1v1, c'était
  // indécidable.
  const dropP = p[1].waitMsg((m) => m.t === 'player_dropped', 1500, p[1].mark());
  p[0].ws.close();
  const pd = await dropP.catch(() => null);
  ok('coupure à 3 -> `player_dropped` avec le siège concerné', !!pd && pd.seat === 0,
    JSON.stringify(pd));
  const p0b = new C(); await p0b.open();
  const backP = p[2].waitMsg((m) => m.t === 'player_back', 1500, p[2].mark());
  p0b.send({ t: 'resume', token: M[0].token, have: [0, 1, 0] });
  const res3 = await p0b.waitMsg((m) => m.t === 'resumed', 1500).catch(() => null);
  ok('reprise à 3 acceptée', !!res3 && res3.ack === 1, JSON.stringify(res3));
  const replay3 = await p0b.waitMsg((m) => m.t === 'act', 1500).catch(() => null);
  ok('rejeu sélectif : seule l\'action du siège NON couvert par `have` revient',
    !!replay3 && replay3.from === 2 && replay3.a.k === 'seat2', JSON.stringify(replay3));
  const noReplay1 = await p0b.expectNone((m) => m.t === 'act' && m.a.k === 'seat1', 400);
  ok('rejeu sélectif : l\'action déjà couverte n\'est PAS rejouée', noReplay1);
  ok('reprise à 3 : les autres sont prévenus (`player_back`)',
    await backP.then(() => true).catch(() => false));

  // ── 17) Un départ sur trois NE TERMINE PAS la partie ──────────────────────
  // C'est l'hypothèse la plus profonde du relay 1v1 : « il est parti » y
  // signifiait « c'est fini », et la salle était détruite.
  const leftP = p[2].waitMsg((m) => m.t === 'player_left', 1500, p[2].mark());
  p[1].send({ t: 'bye' });
  const pl = await leftP.catch(() => null);
  ok('départ d\'un joueur sur 3 -> `player_left` avec son siège', !!pl && pl.seat === 1,
    JSON.stringify(pl));
  const noEnd = await p[2].expectNone((m) => m.t === 'opp_left', 400);
  ok('départ d\'un joueur sur 3 -> la partie N\'EST PAS finie', noEnd);
  const mkAlive = p[2].mark();
  p0b.send({ t: 'act', a: { k: 'encore' }, n: 2 });
  const alive = await p[2].waitMsg((m) => m.t === 'act' && m.a.k === 'encore', 1500, mkAlive)
    .catch(() => null);
  ok('la partie continue entre les survivants', !!alive && alive.from === 0);

  // …et quand il ne reste qu'un joueur, LÀ seulement c'est fini.
  const endP = p[2].waitMsg((m) => m.t === 'opp_left', 1500, p[2].mark());
  p0b.send({ t: 'bye' });
  ok('dernier joueur debout -> `opp_left` (fin de partie)',
    await endP.then(() => true).catch(() => false));
  try { p0b.ws.close(); for (const c of p) c.ws.close(); } catch { /* */ }

  // ── 18) CADENCE : une salle de jeu d'ACTION a droit à un débit soutenu ────
  // Le plafond de 20 msg/s est calibré pour du tour par tour ; à 30 ticks/s, une
  // partie cadencée se faisait couper au bout de quelques secondes. Le budget
  // élevé n'est accordé qu'à une socket ASSISE dans une salle cadencée.
  const k1 = new C(); const k2 = new C();
  await Promise.all([k1.open(), k2.open()]);
  k1.send({ t: 'queue', cadence: true, payload: null });
  await k1.waitMsg((m) => m.t === 'queued');
  k2.send({ t: 'queue', cadence: true, payload: null });
  await Promise.all([k1.waitMsg((m) => m.t === 'matched'), k2.waitMsg((m) => m.t === 'matched')]);
  const mkK = k2.mark();
  for (let i = 1; i <= 45; i++) k1.send({ t: 'act', a: { k: 'i', v: i }, n: i });
  const last = await k2.waitMsg((m) => m.t === 'act' && m.a.v === 45, 2000, mkK).catch(() => null);
  ok('salle cadencée : 45 actions d\'affilée passent sans coupure', !!last && !k1.closed);
  // …et la borne existe toujours : au-delà du budget cadencé, on coupe.
  const floodP = k1.waitMsg((m) => m.t === 'error' && m.reason === 'rate limited', 2500);
  for (let i = 46; i <= 200; i++) k1.send({ t: 'act', a: { k: 'i', v: i }, n: i });
  ok('salle cadencée : le plafond existe toujours (200 msg d\'un coup -> coupé)',
    await floodP.then(() => true).catch(() => false));
  try { k1.ws.close(); k2.ws.close(); } catch { /* */ }
}

let child;
try {
  child = await startRelay();
  await run();
} catch (e) {
  console.log('FAIL  exécution du test  -> ' + (e && e.message));
  failures++;
} finally {
  if (child) child.kill();
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}  total: ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
