// PwaPhaser — relay temps réel N JOUEURS (2 à 4) + petit store de profils (HTTP).
//
// AUCUNE LOGIQUE DE JEU ICI, et c'est délibéré : le relay apparie deux clients
// et relaie leurs actions, sans jamais les interpréter. C'est ce qui le rend
// réutilisable tel quel d'un jeu à l'autre. Le seul endroit à adapter si tu
// veux valider tes actions est `validAct` (plus bas).
// Rôle du relay : apparier deux clients par code de salle et relayer leurs
// actions. AUCUNE logique de jeu ici : les deux clients exécutent le même
// moteur déterministe (seed partagée envoyée au démarrage de la partie).
//
// Un seul process, un seul port (8999) : un serveur HTTP natif sert l'API de
// persistance (`/api/profile/:id`) et le WebSocketServer se greffe dessus via
// l'upgrade — le protocole WS est INCHANGÉ (cf. plus bas, `wss` sur `server`).
// Store proto : un fichier JSON par joueur sous `server/data/profiles/`
// (Postgres plus tard, sans toucher au client — voir design/23 §C).
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8999);

// ── DE 1v1 À N JOUEURS (2 à 4) ──────────────────────────────────────────────
// Ce relay a longtemps été STRICTEMENT 1 contre 1 : une salle = un `host` + un
// `guest`, et cette hypothèse s'était infiltrée partout — le journal de rejeu
// (« les actions de l'AUTRE camp »), les compteurs de séquence (`recv[0|1]`), et
// surtout la fin de partie (« il est parti » = « c'est fini »).
//
// La salle est désormais un TABLEAU DE SIÈGES. À deux joueurs, tout se comporte
// exactement comme avant, au bit près sur le fil : c'est ce que vérifient les
// tests historiques de `relay.test.mjs`. Ce qui est nouveau ne s'active qu'à
// partir de trois sièges (messages `player_left` / `player_dropped` /
// `player_back`, `have` sous forme de tableau à la reprise).
//
//   room = {
//     seats:    [ws|null, …]     — une socket par siège (null = absent)
//     players:  N                — 2 à 4
//     cadence:  bool             — jeu d'ACTION (une action par tick) vs tour par tour
//     payloads: [any, …]         — charge utile de mise en file de chaque siège
//     tokens:   [string, …]      — jetons de reprise
//     recv:     [n, …]           — dernier n° de séquence reçu par siège
//     down:     [timer|null, …]  — sursis en cours par siège
//     gone:     [bool, …]        — siège parti DÉFINITIVEMENT
//     log:      [{ side, n, a }] — journal ordonné, pour le rejeu au revenant
//   }
const rooms = new Map(); // code -> room (cf. ci-dessus)
const MAX_PLAYERS = 4;

// ── REPRISE DE CONNEXION ────────────────────────────────────────────────────
// Un tunnel WS qui saute (wifi→4G, écran verrouillé, relay redémarré) ne doit
// PLUS tuer la partie : la salle survit `RESUME_GRACE_MS`, le temps que le client
// revienne avec son jeton et rejoue ce qu'il a manqué.
//
// Ce que le relay garde par salle :
//   tokens[side] : jeton de reprise (secret, remis au client dans `matched`)
//   recv[side]   : dernier n° de séquence reçu de ce côté (dédoublonnage)
//   log          : journal ORDONNÉ des actions { side, n, a } — c'est lui qu'on
//                  rejoue au revenant (le lockstep ne transporte que des
//                  actions : les rejouer suffit à recoller l'état).
//   down[side]   : minuterie de grâce en cours pour ce côté.
// Toujours AUCUNE logique de jeu ici : le relay ne lit jamais le contenu de `a`.
// 60 s (règle Kevin) : au-delà, la déconnexion est une VRAIE défaite — le
// survivant reçoit `opp_left` et gagne. Doit rester < PVP_IDLE_FORFEIT_MS
// client (180 s) pour que le survivant ne déclare pas forfait AVANT le verdict
// du relay. Réglable par env pour que les tests observent l'expiration vite.
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS || 60_000);
const MAX_LOG_ACTS = 4000;        // borne mémoire du journal (une partie ≈ 300)
// …sauf dans une salle CADENCÉE (jeu d'action, ~30 actions/seconde ET PAR
// JOUEUR) : 4000 entrées y sont consommées en une minute et demie à quatre, si
// bien qu'un revenant se verrait rejouer un journal AMPUTÉ de son début — donc
// un état faux, en silence. On garde de quoi couvrir largement la fenêtre de
// grâce (60 s × 4 joueurs × 30/s = 7200) avec de la marge.
const MAX_LOG_ACTS_CADENCE = Number(process.env.MAX_LOG_ACTS_CADENCE || 20_000);
const resumeIndex = new Map();    // token -> { code, side }

// ── JOURNAL D'EXPLOITATION ──────────────────────────────────────────────────
// Sur stdout (→ `journalctl -u <ton-service>` en prod). C'est le SEUL moyen de
// comprendre après coup un « il a joué, je n'ai rien reçu » : on trace le cycle
// de vie des salles et CHAQUE action (acceptée / dédoublonnée / orpheline), avec
// le n° de séquence et le côté. Volume : ~1 ligne par action, négligeable à
// deux joueurs. Le CONTENU des actions n'est pas journalisé — seulement leur n°
// et leur champ `k` s'il existe : par convention, donne à tes actions un
// discriminant `k` ({ k: 'move', … }) et le journal devient lisible.
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ── APPARIEMENT PUBLIC : file « premier arrivé, premier servi » ─────────────
// Une file PAR FORMAT de partie — le format étant (nombre de joueurs, cadencé
// ou non). On n'apparie évidemment pas quelqu'un qui veut du 1v1 avec quelqu'un
// qui veut du 4 joueurs, ni un jeu d'action avec un tour par tour.
//
// Chaque file est une LISTE : dès qu'elle atteint N, la partie démarre (FCFS
// strict). À deux joueurs la liste ne contient jamais plus d'un élément, ce qui
// redonne mot pour mot l'ancien comportement « un seul joueur peut attendre à
// la fois ».
//
// L'ESTIMATION du temps d'attente annoncée au joueur qui entre en file =
// moyenne des attentes des 10 dernières parties formées (null tant qu'aucune
// n'a eu lieu depuis le démarrage).
const waitLists = new Map();     // "N|c" -> [{ ws, payload, since }, …]
const recentWaitsMs = [];        // durées d'attente des dernières mises en paire
let quickSeq = 0;                // suffixe de code de salle interne (q1, q2…)

const fmtKey = (players, cadence) => `${players}|${cadence ? 1 : 0}`;
function waitList(players, cadence) {
  const k = fmtKey(players, cadence);
  let l = waitLists.get(k);
  if (!l) { l = []; waitLists.set(k, l); }
  return l;
}
/** Retire une socket de TOUTES les files (départ, coupure, unqueue). */
function dropFromWaitLists(ws) {
  for (const [k, l] of waitLists) {
    const i = l.findIndex((e) => e.ws === ws);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) waitLists.delete(k);
  }
}
const isWaiting = (ws) => {
  for (const l of waitLists.values()) if (l.some((e) => e.ws === ws)) return true;
  return false;
};

function estimateWaitMs() {
  if (!recentWaitsMs.length) return null;
  const last = recentWaitsMs.slice(-10);
  return Math.round(last.reduce((s, v) => s + v, 0) / last.length);
}

/** Valide la charge d'une entrée en file : classe courte + liste d'ids bornée. */
/** La charge utile de mise en file est LIBRE (perso choisi, deck, pseudo…) :
 *  le relay ne la lit pas, il la transmet telle quelle à l'adversaire dans
 *  `matched.opp`. On ne vérifie que sa forme, comme pour une action. */
function validQueueMsg(msg) {
  return msg.payload === undefined || msg.payload === null
    || typeof msg.payload !== 'object' || shallowEnough(msg.payload, 0);
}

const send = (ws, obj) => {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
};

// ── DURCISSEMENT (item n°10 de la launch-checklist) ─────────────────────────
// Le relay ne fait toujours AUCUNE logique de jeu, mais il ne fait plus non plus
// aveuglément confiance au pair : chaque message entrant est borné en taille,
// validé structurellement (et en profondeur pour `act`), débit-limité, et les
// bornes globales (salles/sockets) sont respectées. Le protocole vu par un
// client honnête (client/src/core/net.ts) est INCHANGÉ.
const MAX_MSG_BYTES = 4 * 1024;   // taille brute max d'un message WS entrant (4 Ko)
const MAX_INVALID = 10;           // messages invalides tolérés avant fermeture
const RATE_PER_SEC = Number(process.env.RATE_PER_SEC || 20);   // messages/s max
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 400);  // messages/min max
// ── LE PLAFOND DE DÉBIT SUPPOSAIT DU TOUR PAR TOUR ──────────────────────────
// 20/s et 400/min sont calibrés pour un jeu de cartes : quelques actions par
// minute. Un jeu d'ACTION à pas fixe émet une action PAR TICK — 30/s — et se
// faisait donc fermer sa socket au bout de treize secondes, « rate limited ».
// C'est la toute première chose qui casse quand on sort du 1v1 tour par tour, et
// ça ne ressemble en rien à un problème de débit vu du jeu.
//
// La parade N'EST PAS de relever le plafond pour tout le monde : une socket
// anonyme doit rester bornée serré. Le budget élevé est accordé UNIQUEMENT à une
// socket effectivement ASSISE dans une salle cadencée — donc après appariement,
// jamais sur simple déclaration. Un client hostile qui inonde avant d'être
// apparié reste coupé à 20/s, exactement comme avant.
const CADENCE_RATE_PER_SEC = Number(process.env.CADENCE_RATE_PER_SEC || 90);
const CADENCE_RATE_PER_MIN = Number(process.env.CADENCE_RATE_PER_MIN || 4000);
const MAX_ROOMS = 200;            // salles simultanées max
const MAX_SOCKETS = 500;          // sockets simultanées max

const KNOWN_TYPES = new Set(['create', 'join', 'act', 'bye', 'queue', 'unqueue', 'resume', 'ping']);

const isSeq = (n) => Number.isInteger(n) && n >= 0 && n <= 1000000; // n° de séquence d'act

// ── VALIDATION DES ACTIONS ─────────────────────────────────────────────────
// Le relay ne connaît PAS ton jeu : une action est un JSON quelconque, dont on
// ne vérifie que la forme et la taille. C'est volontaire — c'est ce qui rend ce
// serveur réutilisable tel quel d'un jeu à l'autre.
//
// ⚠ Le corollaire : le relay ne peut PAS empêcher un client modifié d'envoyer
// une action illégale au regard des règles. Le lockstep fait confiance aux deux
// clients. Acceptable pour du jeu entre amis ; à durcir (validation métier ici,
// ou simulation côté serveur) le jour où le résultat d'une partie a de la valeur.
//
// SI TU VEUX VALIDER TES ACTIONS : remplace le corps de `validAct` par tes
// propres règles de forme. C'est le seul endroit du serveur à toucher.
const MAX_ACT_KEYS = 24;      // garde-fou anti-objet géant (CLÉS d'un objet)
const MAX_ACT_ITEMS = 512;    // garde-fou anti-tableau géant (ÉLÉMENTS)
const MAX_ACT_DEPTH = 6;      // garde-fou anti-JSON récursif

function shallowEnough(v, depth) {
  if (depth > MAX_ACT_DEPTH) return false;
  if (v === null || typeof v !== 'object') return true;
  // Un TABLEAU et un OBJET n'ont pas la même borne, et les confondre a un coût
  // réel : la première version comptait les éléments d'un tableau contre la
  // limite de clés, si bien qu'une liste parfaitement légitime de 30 entiers
  // (un deck de cartes) était refusée par le serveur. La vraie protection
  // contre une charge utile abusive est de toute façon MAX_MSG_BYTES (4 Ko) ;
  // ces bornes-ci ne visent que les formes pathologiques.
  const entries = Array.isArray(v) ? v : Object.values(v);
  if (entries.length > (Array.isArray(v) ? MAX_ACT_ITEMS : MAX_ACT_KEYS)) return false;
  return entries.every(e => shallowEnough(e, depth + 1));
}

/** Une action valide = un objet ou un tableau JSON, borné en taille/profondeur.
 *  (La taille brute du message est déjà plafonnée par MAX_MSG_BYTES.) */
function validAct(a) {
  if (a === null || typeof a !== 'object') return false;
  return shallowEnough(a, 0);
}

/** Nombre de joueurs demandé : absent = 2 (le cas historique). */
const validPlayers = (p) => p === undefined || (Number.isInteger(p) && p >= 2 && p <= MAX_PLAYERS);

/** Valide structurellement un message DÉJÀ parsé ; `act` est validé en profondeur. */
function validMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (!KNOWN_TYPES.has(msg.t)) return false;
  if (msg.t === 'act') return validAct(msg.a) && (msg.n === undefined || isSeq(msg.n));
  if (msg.t === 'queue' || msg.t === 'create') {
    if (!validPlayers(msg.players)) return false;
    if (msg.cadence !== undefined && typeof msg.cadence !== 'boolean') return false;
  }
  if (msg.t === 'resume') {
    // `have` = ce que le revenant a déjà appliqué. NOMBRE dans une partie à
    // deux (forme historique, un seul flux d'actions à rejouer) ; TABLEAU
    // indexé par siège au-delà — chaque siège ayant sa propre numérotation, un
    // nombre unique ne peut pas dire « j'ai tout de 1 mais rien de 3 ».
    const haveOk = msg.have === undefined || isSeq(msg.have)
      || (Array.isArray(msg.have) && msg.have.length <= MAX_PLAYERS && msg.have.every(isSeq));
    return typeof msg.token === 'string' && msg.token.length > 0 && msg.token.length <= 64 && haveOk;
  }
  return true;
}

/** Fenêtre glissante par socket : met à jour ws.msgTimes et renvoie true si le
 *  débit dépasse RATE_PER_SEC ou RATE_PER_MIN. Le ping/pong keepalive passe par
 *  des trames de contrôle (pas d'événement 'message') → jamais compté ici. */
function rateLimited(ws, now) {
  // `ws.cadence` n'est posé qu'à l'appariement dans une salle cadencée : avant
  // ça, et pour tout le tour par tour, on garde le plafond serré d'origine.
  const perSec = ws.cadence ? CADENCE_RATE_PER_SEC : RATE_PER_SEC;
  const perMin = ws.cadence ? CADENCE_RATE_PER_MIN : RATE_PER_MIN;
  const times = ws.msgTimes;
  while (times.length && now - times[0] > 60000) times.shift();
  times.push(now);
  if (times.length > perMin) return true;
  let inSec = 0;
  for (let i = times.length - 1; i >= 0 && now - times[i] <= 1000; i--) inSec++;
  return inSec > perSec;
}

// ── store de profils (HTTP JSON) ────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, 'data', 'profiles');
const MAX_BODY = 64 * 1024;              // 64 Ko : une progression reste minuscule
const ID_RE = /^[a-z0-9-]{8,64}$/;       // id anonyme sanitisé (cf. client profile.ts)

// Origines autorisées (CORS) : la prod + le dev local (vite). L'API et le jeu
// sont same-origin en prod (nginx proxifie /api), mais en dev le jeu tourne sur
// un autre port → il faut autoriser explicitement.
const ALLOWED_ORIGINS = new Set([
  'https://battlecards.real3d.fr',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',   // vite preview
]);

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function sendJson(res, code, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
  res.end(body);
}

/** Lit le corps de la requête en respectant la limite de taille. Dès qu'on
 *  dépasse : on répond 413 puis on coupe (pas de buffer géant en mémoire). Le
 *  rejet porte `{ handled: true }` quand la réponse a déjà été envoyée, pour que
 *  l'appelant ne réponde pas une 2e fois. */
function readBody(req, res, origin) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        sendJson(res, 413, { error: 'too_large' }, origin);
        req.destroy();
        reject({ handled: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!done) reject(e); });
  });
}

/** Écriture atomique : on écrit un fichier temporaire puis on le renomme, pour
 *  ne jamais laisser un JSON à moitié écrit si le process meurt en plein vol. */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function handleProfileGet(res, id, origin) {
  const file = path.join(PROFILES_DIR, `${id}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
    res.end(raw); // on renvoie le JSON stocké tel quel
  } catch {
    sendJson(res, 404, { error: 'not_found' }, origin);
  }
}

async function handleProfilePut(req, res, id, origin) {
  const ctype = String(req.headers['content-type'] || '');
  if (!ctype.includes('application/json')) {
    return sendJson(res, 415, { error: 'expected_json' }, origin);
  }
  let body;
  try {
    body = await readBody(req, res, origin);
  } catch (e) {
    if (e && e.handled) return; // 413 déjà envoyée
    return sendJson(res, 400, { error: 'read_failed' }, origin);
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8')); // valide que c'est bien du JSON
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' }, origin);
  }
  try {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    // On re-sérialise (compact) : normalise et neutralise tout contenu exotique.
    await writeAtomic(path.join(PROFILES_DIR, `${id}.json`), JSON.stringify(parsed));
    sendJson(res, 200, { ok: true }, origin);
  } catch (e) {
    sendJson(res, 500, { error: 'write_failed' }, origin);
  }
}

async function handleHttp(req, res) {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','profile',':id']

  // Préflight CORS.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  // Santé / non-API : réponse minimale (le relay n'a pas de page).
  if (!(parts[0] === 'api' && parts[1] === 'profile' && parts[2])) {
    return sendJson(res, 404, { error: 'not_found' }, origin);
  }

  const id = decodeURIComponent(parts[2]);
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad_id' }, origin);

  if (req.method === 'GET') return handleProfileGet(res, id, origin);
  if (req.method === 'PUT') return handleProfilePut(req, res, id, origin);
  return sendJson(res, 405, { error: 'method_not_allowed' }, origin);
}

// ── serveur HTTP + upgrade WebSocket (même port) ────────────────────────────
const server = http.createServer((req, res) => {
  handleHttp(req, res).catch(() => {
    try { sendJson(res, 500, { error: 'internal' }, req.headers.origin); } catch { /* déjà répondu */ }
  });
});

// Le WS se greffe sur le serveur HTTP : mêmes upgrades qu'avant, protocole
// INCHANGÉ (create/join/act/bye). On écoute sur 127.0.0.1 comme avant — nginx
// proxifie /ws ET /api vers ce port en prod.
const wss = new WebSocketServer({ server });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] HTTP+WS listening on 127.0.0.1:${PORT} (profiles: ${PROFILES_DIR})`);
});

function newCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

/** Siège occupé par cette socket dans cette salle, ou -1. */
const seatOf = (room, ws) => room.seats.indexOf(ws);

/** Diffuse `obj` à tous les sièges SAUF `except`. Renvoie le nombre de remises. */
function broadcast(room, obj, except = -1) {
  let n = 0;
  for (let s = 0; s < room.players; s++) {
    if (s === except) continue;
    if (send(room.seats[s], obj)) n++;
  }
  return n;
}

/** Sièges encore EN JEU : ni partis définitivement, ni… c'est tout. Un siège en
 *  sursis compte encore : il peut revenir, et sa place lui est gardée. */
function stillPlaying(room) {
  let n = 0;
  for (let s = 0; s < room.players; s++) if (!room.gone[s]) n++;
  return n;
}

/** Détruit une salle et tout ce qui pend après (minuteries, jetons). */
function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.down) for (const t of room.down) if (t) clearTimeout(t);
  if (room.tokens) for (const tok of room.tokens) if (tok) resumeIndex.delete(tok);
  for (const ws of room.seats) if (ws) { ws.roomCode = null; ws.cadence = false; }
  rooms.delete(code);
}

/**
 * Le siège `side` ne revient pas.
 *
 * À DEUX joueurs, c'est la fin : l'autre reçoit `opp_left` et la salle meurt.
 * C'était l'hypothèse cachée du relay 1v1 — « il est parti » signifiait « c'est
 * fini », et la salle était détruite sans autre forme de procès.
 *
 * À TROIS OU QUATRE, un départ n'est PAS la fin : les autres reçoivent
 * `player_left` et continuent à jouer. La salle ne meurt que lorsqu'il ne reste
 * qu'un joueur (ou zéro) — et ce dernier reçoit alors `opp_left`, qui garde
 * exactement le sens qu'il a toujours eu : « il n'y a plus personne en face ».
 */
function endRoom(code, side) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.gone[side]) return;
  room.gone[side] = true;
  if (room.down[side]) { clearTimeout(room.down[side]); room.down[side] = null; }
  const ws = room.seats[side];
  if (ws) { ws.roomCode = null; ws.cadence = false; room.seats[side] = null; }

  if (room.players === 2) {
    const told = broadcast(room, { t: 'opp_left' }, side);
    log(`FIN room=${code} : side=${side} parti/expiré -> opp_left ${told ? 'envoyé' : 'NON remis (pair absent aussi)'}`);
    destroyRoom(code);
    return;
  }

  const told = broadcast(room, { t: 'player_left', seat: side }, side);
  const left = stillPlaying(room);
  log(`DÉPART room=${code} side=${side} -> player_left à ${told} pair(s), ${left} joueur(s) restant(s)`);
  if (left <= 1) {
    broadcast(room, { t: 'opp_left' }, side);
    log(`FIN room=${code} : plus qu'un joueur -> opp_left`);
    destroyRoom(code);
  }
}

/** Une socket disparaît. `graceful` = départ VOLONTAIRE (`bye`) : fin immédiate.
 *  Coupure brutale : le SIÈGE est mis en sursis (les autres reçoivent
 *  `opp_dropped` / `player_dropped` et attendent) au lieu d'être perdu. Un salon
 *  privé que personne n'a encore rejoint (`tokens` null) est détruit sans
 *  sursis. */
function cleanup(ws, graceful = false) {
  dropFromWaitLists(ws);
  for (const [code, room] of [...rooms]) {
    const side = seatOf(room, ws);
    if (side < 0) continue;
    if (!graceful && room.tokens) {
      if (room.down[side]) continue;              // sursis déjà en cours
      room.down[side] = setTimeout(() => endRoom(code, side), RESUME_GRACE_MS);
      // `opp_dropped` (historique, sans siège) reste émis dans une partie à
      // deux ; `player_dropped` porte le siège et sert dès qu'on est plus
      // nombreux. Émettre les deux évite d'avoir à faire évoluer un client 1v1.
      const told = room.players === 2
        ? broadcast(room, { t: 'opp_dropped', graceMs: RESUME_GRACE_MS }, side)
        : broadcast(room, { t: 'player_dropped', seat: side, graceMs: RESUME_GRACE_MS }, side);
      log(`COUPURE room=${code} side=${side} -> sursis ${RESUME_GRACE_MS / 1000}s (${told} pair(s) prévenu(s))`);
      continue;
    }
    endRoom(code, side);
  }
}

/** Équipe une salle pleine et annonce l'appariement à tous ses sièges. */
function startRoom(code, room, seed, hostStarts) {
  const tokens = [];
  for (let s = 0; s < room.players; s++) {
    const tok = randomUUID();
    tokens.push(tok);
    resumeIndex.set(tok, { code, side: s });
  }
  room.tokens = tokens;
  for (let s = 0; s < room.players; s++) {
    const ws = room.seats[s];
    if (!ws) continue;
    ws.roomCode = code;
    // Le budget de débit élevé n'est accordé QU'ICI : une socket assise dans une
    // salle cadencée, jamais une socket qui se contente de le demander.
    ws.cadence = !!room.cadence;
    const m = {
      t: 'matched', seed, hostStarts, youAre: s, token: tokens[s],
      players: room.players, opps: room.payloads,
    };
    // `opp` (au singulier) reste renseigné dans une partie à deux : c'est le
    // champ que lisent les jeux 1v1 existants. Au-delà il n'a pas de sens.
    if (room.players === 2) m.opp = room.payloads[s === 0 ? 1 : 0];
    send(ws, m);
  }
}

/** Reprise d'une partie après coupure : la nouvelle socket remplace l'ancienne
 *  dans la salle, puis on rejoue les actions du pair que le revenant n'a pas
 *  reçues (`have` = dernier n° appliqué). Le client, lui, renvoie les siennes
 *  au-delà de `ack` — le dédoublonnage par n° de séquence rend l'échange
 *  idempotent dans les deux sens. */
function handleResume(ws, msg) {
  const ref = resumeIndex.get(String(msg.token));
  const room = ref ? rooms.get(ref.code) : null;
  if (!ref || !room) {
    log(`resume REFUSÉ (salle expirée/inconnue) token=…${String(msg.token).slice(-6)}`);
    return send(ws, { t: 'error', reason: 'resume expired' });
  }
  const side = ref.side;
  if (room.gone[side]) {
    log(`resume REFUSÉ (siège déjà déclaré parti) room=${ref.code} side=${side}`);
    return send(ws, { t: 'error', reason: 'resume expired' });
  }
  const current = room.seats[side];
  // Socket d'origine toujours vivante ET DIFFÉRENTE : c'est le cas « demi-ouvert »
  // le plus courant (le client a renoncé et rouvre, le serveur ne sait pas encore
  // que l'ancienne est morte). On lui prend la place et on TUE l'ancienne : la
  // laisser vivre, c'est la transformer en zombie dont les octets en vol
  // reviendraient polluer la salle (cf. garde `side < 0` sur `act`).
  if (room.down[side]) { clearTimeout(room.down[side]); room.down[side] = null; }
  // ORDRE IMPORTANT : on installe la nouvelle socket AVANT de tuer l'ancienne.
  // Sinon la fermeture de l'ancienne repasse par `cleanup`, qui la reconnaîtrait
  // encore comme celle de la salle et armerait un sursis fantôme (salle tuée
  // 60 s plus tard, en pleine partie).
  room.seats[side] = ws;
  ws.roomCode = ref.code;
  ws.cadence = !!room.cadence;
  if (current && current !== ws) {
    current.roomCode = null;
    current.cadence = false;
    try { current.terminate(); } catch { /* déjà morte */ }
    log(`resume: ancienne socket remplacée room=${ref.code} side=${side}`);
  }
  // `have` = ce que le revenant a déjà appliqué, PAR SIÈGE. Le relay 1v1
  // acceptait un nombre unique : ça suffisait parce qu'il n'y avait qu'un seul
  // autre camp, donc un seul flux d'actions à rejouer. À trois joueurs, un
  // nombre unique ne peut plus rien dire d'utile — on accepte donc AUSSI un
  // tableau indexé par siège, et le nombre reste compris comme « ce chiffre-là
  // pour tous les autres sièges » (compatibilité descendante).
  const haveArr = new Array(room.players).fill(0);
  if (Array.isArray(msg.have)) {
    for (let s = 0; s < room.players; s++) if (isSeq(msg.have[s])) haveArr[s] = msg.have[s];
  } else if (isSeq(msg.have)) {
    haveArr.fill(msg.have);
  }
  send(ws, { t: 'resumed', ack: room.recv[side] });
  let replayed = 0;
  for (const e of room.log) {
    if (e.side === side || e.n <= haveArr[e.side]) continue;
    send(ws, { t: 'act', a: e.a, n: e.n, from: e.side });
    replayed++;
  }
  if (room.players === 2) broadcast(room, { t: 'opp_back' }, side);
  else broadcast(room, { t: 'player_back', seat: side }, side);
  log(`resume OK room=${ref.code} side=${side} have=[${haveArr}] rejouées=${replayed} ack=${room.recv[side]}`);
}

wss.on('connection', (ws) => {
  // Borne globale : au-delà du plafond de sockets, refus propre puis fermeture.
  // (wss.clients inclut déjà la socket courante à ce stade.)
  if (wss.clients.size > MAX_SOCKETS) {
    send(ws, { t: 'error', reason: 'server full' });
    ws.close();
    return;
  }
  ws.isAlive = true;
  ws.invalidCount = 0;   // messages invalides cumulés sur cette socket
  ws.msgTimes = [];      // horodatages pour la fenêtre glissante de débit
  ws.cadence = false;    // budget de débit élevé — accordé SEULEMENT à l'appariement
  ws.on('pong', () => { ws.isAlive = true; });

  // Un message invalide est ignoré silencieusement ; au-delà de MAX_INVALID
  // messages invalides cumulés, on ferme la socket (pair probablement hostile).
  const dropInvalid = () => { if (++ws.invalidCount >= MAX_INVALID) ws.close(); };

  ws.on('message', (raw, isBinary) => {
    const now = Date.now();
    // 1) Débit borné (avant tout parsing). Le keepalive ne passe pas par ici.
    if (rateLimited(ws, now)) {
      send(ws, { t: 'error', reason: 'rate limited' });
      ws.close();
      return;
    }
    // 2) Taille brute bornée : un message géant est traité comme invalide.
    const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
    if (isBinary || bytes > MAX_MSG_BYTES) return dropInvalid();

    // 3) JSON valide + structure connue (`act` validé en profondeur).
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return dropInvalid(); }
    if (!validMessage(msg)) return dropInvalid();

    if (msg.t === 'create') {
      // SALON PRIVÉ : le créateur reçoit un code à 4 chiffres à partager.
      // Même équipement de reprise que l'appariement public — un salon privé
      // survit donc aussi à une coupure de wifi. `players` permet d'ouvrir un
      // salon à 3 ou 4 : la partie démarre quand tous les sièges sont pris.
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', reason: 'server full' });
      const code = newCode();
      if (!code) return send(ws, { t: 'error', reason: 'server full' });
      const players = msg.players ?? 2;
      const room = {
        players, cadence: !!msg.cadence, opts: { private: true },
        seats: new Array(players).fill(null),
        payloads: new Array(players).fill(null),
        tokens: null,
        recv: new Array(players).fill(0),
        down: new Array(players).fill(null),
        gone: new Array(players).fill(false),
        log: [],
      };
      room.seats[0] = ws;
      room.payloads[0] = msg.payload ?? null;
      rooms.set(code, room);
      ws.roomCode = code;
      send(ws, { t: 'room', code });
      log(`SALON room=${code} cree (${players} joueurs${room.cadence ? ', cadencé' : ''})`);

    } else if (msg.t === 'join') {
      const room = rooms.get(String(msg.code || ''));
      if (!room) return send(ws, { t: 'error', reason: 'room not found' });
      const free = room.seats.indexOf(null);
      if (free < 0 || room.tokens) return send(ws, { t: 'error', reason: 'room full' });
      const code = String(msg.code);
      room.seats[free] = ws;
      room.payloads[free] = msg.payload ?? null;
      ws.roomCode = code;
      if (room.seats.includes(null)) {
        send(ws, { t: 'waiting', seat: free, players: room.players });
        log(`SALON room=${code} : siège ${free} pris, ${room.seats.filter(s => !s).length} restant(s)`);
        return;
      }
      const seed = (Math.random() * 0xffffffff) >>> 0;
      startRoom(code, room, seed, Math.random() < 0.5);
      log(`SALON room=${code} rejoint, seed=${seed}`);

    } else if (msg.t === 'queue') {
      // APPARIEMENT PUBLIC — premier arrivé, premier servi, PAR FORMAT.
      if (!validQueueMsg(msg)) return send(ws, { t: 'error', reason: 'bad queue payload' });
      if (isWaiting(ws)) return; // déjà en file
      const players = msg.players ?? 2;
      const cadence = !!msg.cadence;
      const list = waitList(players, cadence);
      // On purge d'abord les sockets mortes qui traînent dans la file.
      for (let i = list.length - 1; i >= 0; i--) if (list[i].ws.readyState !== 1) list.splice(i, 1);
      list.push({ ws, payload: msg.payload ?? null, since: Date.now() });

      if (list.length < players) {
        send(ws, { t: 'queued', estimateMs: estimateWaitMs() });
        return;
      }
      if (rooms.size >= MAX_ROOMS) {
        list.pop();
        return send(ws, { t: 'error', reason: 'server full' });
      }
      // Assez de monde → la partie se forme. L'ordre des sièges est l'ordre
      // d'ARRIVÉE : le siège 0 est le premier qui attendait.
      const seated = list.splice(0, players);
      if (!list.length) waitLists.delete(fmtKey(players, cadence));
      for (const e of seated) {
        recentWaitsMs.push(Date.now() - e.since);
        if (recentWaitsMs.length > 50) recentWaitsMs.shift();
      }
      const code = `q${++quickSeq}`;
      const room = {
        players, cadence, opts: { quick: true },
        seats: seated.map((e) => e.ws),
        payloads: seated.map((e) => e.payload),
        tokens: null,
        recv: new Array(players).fill(0),
        down: new Array(players).fill(null),
        gone: new Array(players).fill(false),
        log: [],
      };
      rooms.set(code, room);
      const seed = (Math.random() * 0xffffffff) >>> 0;
      startRoom(code, room, seed, Math.random() < 0.5);
      log(`MATCH room=${code} seed=${seed} joueurs=${players}${cadence ? ' cadencé' : ''}`);

    } else if (msg.t === 'unqueue') {
      dropFromWaitLists(ws);
      send(ws, { t: 'unqueued' });

    } else if (msg.t === 'act') {
      const room = rooms.get(ws.roomCode || '');
      if (!room) return;
      // CÔTÉ PAR IDENTITÉ, jamais par défaut. Une socket qui n'est plus celle de
      // la salle est une ZOMBIE : elle a été remplacée par une reprise, mais ses
      // octets en vol peuvent arriver APRÈS (TCP finit par retransmettre).
      // L'ancien `room.host === ws ? 0 : 1` les attribuait alors au camp d'EN
      // FACE : action rejouée du mauvais côté, compteur `recv` de l'adversaire
      // gonflé — et donc ses VRAIES actions suivantes rejetées comme doublons.
      // C'est le « il a cliqué fin de tour, je n'ai jamais rien reçu ».
      const side = seatOf(room, ws);
      if (side < 0) { log(`act ORPHELINE ignorée (socket zombie) room=${ws.roomCode} n=${msg.n} k=${msg.a && msg.a.k}`); return; }
      // Numérote, dédoublonne (renvoi après reprise) et journalise pour le rejeu.
      const n = isSeq(msg.n) ? msg.n : room.recv[side] + 1;
      if (n <= room.recv[side]) {
        log(`act DOUBLON room=${ws.roomCode} side=${side} n=${n} (recv=${room.recv[side]}) k=${msg.a && msg.a.k}`);
        send(ws, { t: 'ack', n });   // déjà connue : on ré-accuse pour vider l'outbox du client
        return;
      }
      room.recv[side] = n;
      room.log.push({ side, n, a: msg.a });
      const logCap = room.cadence ? MAX_LOG_ACTS_CADENCE : MAX_LOG_ACTS;
      if (room.log.length > logCap) room.log.shift();
      // ACQUITTEMENT : sans lui, un client dont la socket est « à moitié
      // ouverte » (wifi qui meurt sans FIN — readyState reste OPEN) envoie dans
      // le vide sans jamais le savoir. L'ack est le seul signal qui lui permet
      // de détecter le trou et de forcer une reprise.
      send(ws, { t: 'ack', n });
      // `from` = siège de l'émetteur. Indispensable dès qu'il y a plus de deux
      // sièges (« l'autre » ne veut plus rien dire), et inoffensif à deux : un
      // client 1v1 existant ignore les champs qu'il ne connaît pas.
      const relayed = broadcast(room, { t: 'act', a: msg.a, n, from: side }, side);
      log(`act room=${ws.roomCode} side=${side} n=${n} k=${msg.a && msg.a.k}${relayed ? '' : ' [pair ABSENT -> journalisée]'}`);

    } else if (msg.t === 'ping') {
      // Sonde de vivacité APPLICATIVE du client (le ping/pong protocolaire ne
      // remonte pas jusqu'au JS du navigateur).
      send(ws, { t: 'pong' });

    } else if (msg.t === 'resume') {
      handleResume(ws, msg);

    } else if (msg.t === 'bye') {
      log(`bye room=${ws.roomCode || '-'}`);
      cleanup(ws, true);   // départ volontaire : pas de sursis
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

// keepalive (les téléphones coupent les sockets muets)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
