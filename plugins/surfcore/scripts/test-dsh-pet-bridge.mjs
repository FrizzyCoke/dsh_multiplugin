// Integration test for plugins/surfcore/lib/dsh-pet-bridge.js
// Real surfcore pet-chat service + a stand-in for dsh-pet that follows its exact memory-provider
// contract (copied from dsh-pet 0.4.9 src/host/chat-memory-provider.ts + plugin/chat-memory.ts)
// + a fake DSH HTTP server that records /dsh-pet-7340/broadcast calls. Isolated temp DSH_HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { fileURLToPath as __f } from 'node:url';
const REPO = __f(new URL('../../../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bridge-e2e-'));
process.env.DSH_HOME = home;
const S = path.join(home, 'surfcore');
const charId = 'char-bridgetest';
const charDir = path.join(S, 'characters', charId);
fs.mkdirSync(path.join(charDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(S, 'characters', 'current.json'), JSON.stringify({ version: 1, id: charId, name: '知更鸟', epoch: 1, dir: charDir }));
fs.writeFileSync(path.join(S, 'characters', 'index.json'), JSON.stringify({ version: 1, currentId: charId, epoch: 1, characters: [{ version: 1, id: charId, name: '知更鸟', persona: 'persona.md', memory: 'memory', bili: 'bili' }] }));
fs.writeFileSync(path.join(charDir, 'persona.md'), '# 角色卡：兄弟\n标记PERSONA_CORE\n');
fs.writeFileSync(path.join(charDir, 'persona.full.md'), '# 角色卡：兄弟\n标记PERSONA_FULL 哥们关系\n');
fs.writeFileSync(path.join(charDir, 'memory', 'memory-card-prompt-qq.md'), '## 桌宠（私下相处）\n- 标记MEMORY 哥们上周说他在打艾尔登法环\n');
const cfgFile = path.join(S, 'config.json');
const writeCfg = (bridge) => fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, persona: { mode: 'full' }, admin: { displayName: '测试哥' }, dshPetBridge: bridge }));
writeCfg({ enabled: false });
const petCfgDir = path.join(home, 'dsh-pet');
fs.mkdirSync(petCfgDir, { recursive: true });
const writePetCfg = (display) => fs.writeFileSync(path.join(petCfgDir, 'main-config.jsonc'),
  `{\n  // jsonc comment with "quotes" and // inside\n  "pets": [{ "id": "main", "name": "知更鸟", "display": "${display}", "whisperPrompt": "url http://x.y/z // not a comment" }]\n}\n`);
writePetCfg('both');

let fails = 0;
const check = (c, l, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); if (!c) fails += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stand-in for dsh-pet's petApi7340 (contract copied from its source) ──
let current = null;
const petApi = { memory: {
  register(def) {
    if (!def || typeof def.id !== 'string' || !def.id) throw new TypeError('id');
    if (def.id === 'native') throw new TypeError('native');
    if (typeof def.recall !== 'function' && typeof def.capture !== 'function') throw new TypeError('recall/capture');
    current = def;
    return () => { if (current === def) current = null; };
  },
  list() { return { builtin: ['native'], external: current ? [current.id] : [] }; },
} };
const ctx = { get: (name) => (name === 'petApi7340' ? petApi : undefined) };
async function dshPetChat(petId, userText) { // mimics chatWithPet: recallPatch (1.5s timeout) → generate → captureTurn
  const system = '你是桌宠人设(dsh-pet whisperPrompt)。你的名字是"知更鸟"。现在是周一晚上。';
  let patch;
  if (current?.recall) patch = await Promise.race([Promise.resolve(current.recall({ petId, system, history: [], userText })), sleep(1500).then(() => undefined)]);
  const usedSystem = typeof patch?.system === 'string' ? patch.system : system;
  const replyText = '记得啊 你在打艾尔登法环 😂';
  if (current?.capture) await Promise.resolve(current.capture({ petId, userText, replyText, ts: Date.now() })).catch(() => {});
  return usedSystem;
}

// ── fake DSH web server ──
const broadcasts = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/dsh-pet-7340/broadcast')) {
      broadcasts.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const dshUrl = `http://127.0.0.1:${server.address().port}`;

const { createPetChatService } = await import(`file:///${REPO}/plugins/surfcore/lib/pet-chat.js`);
const { createDshPetBridge, stripJsonComments } = await import(`file:///${REPO}/plugins/surfcore/lib/dsh-pet-bridge.js`);
const logs = [];
const chat = createPetChatService({ ctx, stateDir: S, pluginLog: (...a) => logs.push(a.join(' ')) });
const bridge = createDshPetBridge({
  ctx, chat,
  readConfig: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).dshPetBridge,
  currentDshUrl: () => dshUrl,
  dshPetUserRoot: petCfgDir,
  pluginLog: (...a) => logs.push(a.join(' ')),
});
const inbox = path.join(charDir, 'memory', 'memory-inbox.jsonl');
const inboxLines = () => (fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean) : []);

// 1. disabled = untouched
bridge.start();
check(current === null, 'disabled: does NOT register with dsh-pet');
let sys = await dshPetChat('main', '你好');
check(sys.startsWith('你是桌宠人设'), 'disabled: dsh-pet keeps its own prompt');
check(inboxLines().length === 0, 'disabled: nothing written to surfcore memory');
check(chat.frontendOnline() === false, 'disabled: not counted as online');

// 2. enable → registers
writeCfg({ enabled: true });
bridge.ensure();
check(current?.id === 'surfcore', 'enabled: registered as dsh-pet memory provider');
check(logs.some((l) => l.includes('已接管 dsh-pet 对话')), 'enabled: visible log line');

// 3. recall = surfcore brain
sys = await dshPetChat('main', '你记得我上周说啥吗');
check(sys.includes('标记PERSONA_FULL'), 'recall: uses persona.full.md (the file "full" mode loads)');
check(!sys.includes('标记PERSONA_CORE'), 'recall: not the split-mode core file');
check(sys.includes('标记MEMORY'), 'recall: includes surfcore memory card');
check(sys.includes('你是桌宠人设') && sys.includes('知更鸟'), 'recall: keeps dsh-pet pet/name/time context appended');
check(sys.includes('按人格卡的说法回答') && !sys.includes('绝不要提你是 AI'), 'recall: AI-rule contradiction removed');
const t0 = Date.now(); await bridge.recall({ petId: 'main', system: 'x' }); const recallMs = Date.now() - t0;
check(recallMs < 300, 'recall: fast (well under dsh-pet 1500ms timeout)', `${recallMs}ms`);
check((await bridge.recall({ petId: 'other', system: 'x' })) === undefined, 'recall: ignores pets not in petIds');

// 4. capture = surfcore memory
const lines = inboxLines();
check(lines.length === 2, 'capture: 2 inbox events (his line + her reply)', `got ${lines.length}`);
const ev = lines.map((l) => JSON.parse(l));
check(ev.every((e) => e.platform === 'pet'), 'capture: written as platform=pet (same as surfpet chats)');
check(ev.some((e) => e.isOwner && e.text.includes('上周')) && ev.some((e) => e.isSelf && e.text.includes('艾尔登法环')), 'capture: correct speaker roles');
const mc = await import(`file:///${REPO}/src/memory-card.js?bridge=1`);
const card = mc.createEmptyCard();
mc.ingestInboxLines(card, lines, {});
check(card.records.some((r) => r.source === 'pet-owner' && r.botReply.includes('艾尔登法环')), 'capture → maintainer: becomes a pet-owner memory with her reply');

// 5. proactive mirrored to dsh-pet
check(chat.online().online === false && chat.frontendOnline() === true, 'purpose gate: surfpet offline but dsh-pet counts as online');
await chat.proactive({ text: '在干嘛 兄弟' });
await sleep(400);
check(broadcasts.length === 1, 'proactive: broadcast sent to dsh-pet', `got ${broadcasts.length}`);
check(broadcasts[0]?.url.includes('pet=main') && broadcasts[0]?.url.includes('surface=any'), 'proactive: correct route + query', broadcasts[0]?.url);
check(broadcasts[0]?.body.text === '在干嘛 兄弟' && broadcasts[0]?.body.duration === 8000, 'proactive: correct body');

// 6. display none → not online, no broadcast
writePetCfg('none');
check(chat.frontendOnline() === false, 'display=none: not counted as online');
await chat.proactive({ text: '看不到我吧' }); await sleep(300);
check(broadcasts.length === 1, 'display=none: no broadcast');
writePetCfg('both');

// 7. dsh-pet hot reload (its module state resets) → we re-register
current = null;
bridge.ensure();
check(current?.id === 'surfcore', 'dsh-pet reload: re-registers automatically');

// 8. broadcast failure is visible, not silent
server.close();
await chat.proactive({ text: '服务器挂了' }); await sleep(800);
check(bridge.status().lastError.includes('dsh-pet-bridge.broadcast-failed'), 'failure: recorded with code + logged', bridge.status().lastError.slice(0, 70));

// 9. switch off → unregisters, dsh-pet back to native
writeCfg({ enabled: false });
bridge.ensure();
check(current === null, 'switch off: unregistered (dsh-pet back to its own brain)');
bridge.stop();

// 9b. screen question: one answer — "我瞅瞅" now, the real answer after the look
writeCfg({ enabled: true });
let decide = () => Promise.resolve(true);
let answerHook = null;
const qBridge = createDshPetBridge({
  ctx, chat, readConfig: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).dshPetBridge,
  currentDshUrl: () => dshUrl, dshPetUserRoot: petCfgDir,
  onUserMessage: (text, opts) => { answerHook = opts?.onAnswer; return decide(text); },
  extraSystem: () => '【看屏幕提示】等下我看一眼',
});
let qs = (await qBridge.recall({ petId: 'main', system: 'x', userText: '看下我屏幕' })).system;
check(qs.includes('只回「我瞅瞅」') && !qs.includes('等下我看一眼'), 'decision=yes → she only says "我瞅瞅" now');
decide = () => Promise.resolve(false);
qs = (await qBridge.recall({ petId: 'main', system: 'x', userText: '今天好累' })).system;
check(!qs.includes('我瞅瞅') && !qs.includes('等下我看一眼'), 'decision=no → normal chat, no screen talk');
decide = () => new Promise((r) => setTimeout(() => r(true), 3000));
const tq = Date.now();
qs = (await qBridge.recall({ petId: 'main', system: 'x', userText: '这是哪' })).system;
check(Date.now() - tq < 1400 && qs.includes('等下我看一眼'), 'slow decision → falls back within dsh-pet\'s 1.5s budget', `${Date.now() - tq}ms`);
fs.writeFileSync(path.join(petCfgDir, 'memory.json'), JSON.stringify({ main: { main: { messages: [{ role: 'user', content: '看下我屏幕', ts: 1 }, { role: 'assistant', content: '我瞅瞅', ts: 2 }] } } }));
answerHook?.('你在打三角洲 刚落地');
const dmem = JSON.parse(fs.readFileSync(path.join(petCfgDir, 'memory.json'), 'utf8'));
check(dmem.main.main.messages.at(-1).content === '你在打三角洲 刚落地', 'the real answer is written back into dsh-pet\'s own chat history');

// 10. JSONC stripping
const parsed = JSON.parse(stripJsonComments(fs.readFileSync(path.join(petCfgDir, 'main-config.jsonc'), 'utf8')));
check(parsed.pets[0].whisperPrompt === 'url http://x.y/z // not a comment', 'jsonc: strips comments, keeps // inside strings');

fs.rmSync(home, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
