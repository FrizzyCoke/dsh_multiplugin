// 专注模式（lib/focus-mode.js + 各处的安静判断）。临时目录、假 fetch，不碰真 dsh-pet。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFocusMode, quietConfig, restoreConfig } from '../lib/focus-mode.js';
import { buildMenu } from '../lib/dsh-pet-menu.js';
import { createDshPetBridge } from '../lib/dsh-pet-bridge.js';
import { createPetLife } from '../lib/pet-life.js';
import { createDailyRecap } from '../lib/daily-recap.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
const original = {
  pets: [{ id: 'main', name: '知更鸟', whisperEnabled: true, workStatusEnabled: true, display: 'desktop', whisperPrompt: 'x' }, { id: 'p2', whisperEnabled: false }],
  whisperImageEnabled: true, chatImageEnabled: true, chatMemoryRounds: 4,
};

console.log('focus mode');
await ok('改成专注：碎碎念 / 配图 / 工作状态气泡全关，别的不动；恢复后一模一样（原来没写的键也不多出来）', () => {
  const { next, snap } = quietConfig(original);
  assert.equal(next.whisperImageEnabled, false); assert.equal(next.chatImageEnabled, false);
  assert.ok(next.pets.every((p) => p.whisperEnabled === false && p.workStatusEnabled === false));
  assert.equal(next.chatMemoryRounds, 4); assert.equal(next.pets[0].whisperPrompt, 'x');
  assert.deepEqual(restoreConfig(next, snap), original);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(tmp, 'fm-'));
  const cfgFile = path.join(dir, 'main-config.jsonc');
  fs.writeFileSync(cfgFile, JSON.stringify(original));
  let focus = false;
  const chat = { focusEnabled: () => focus, setFocus: (on) => { focus = on; return { enabled: on }; } };
  const fm = createFocusMode({ chat, dshPetConfigPath: cfgFile, stateDir: dir, backupDir: path.join(dir, 'backups') });
  return { fm, cfgFile, dir, read: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')), setFocusRaw: (v) => { focus = v; } };
}
await ok('开 → dsh-pet 配置改成安静、存原值、备份；再开一次不覆盖原值；关 → 原样恢复', () => {
  const s = setup();
  s.fm.set(true);
  assert.equal(s.read().pets[0].whisperEnabled, false); assert.equal(s.fm.status().dshPetQuieted, true);
  assert.ok(fs.readdirSync(path.join(s.dir, 'backups')).length === 1);
  s.fm.set(true);
  s.fm.set(false);
  assert.deepEqual(s.read(), original);
  assert.equal(s.fm.status().enabled, false); assert.equal(s.fm.status().dshPetQuieted, false);
});
await ok('启动对齐：专注开着但 dsh-pet 没改 → 补改；关着却留着原值 → 补恢复', () => {
  const s = setup();
  s.setFocusRaw(true);
  s.fm.reconcile();
  assert.equal(s.read().whisperImageEnabled, false);
  s.setFocusRaw(false);
  s.fm.reconcile();
  assert.deepEqual(s.read(), original);
});
await ok('dsh-pet 配置读不到：SurfCore 这边照样进专注，带 code + hint', () => {
  let focus = false;
  const fm = createFocusMode({ chat: { focusEnabled: () => focus, setFocus: (on) => { focus = on; } }, dshPetConfigPath: path.join(tmp, 'nope.jsonc'), stateDir: fs.mkdtempSync(path.join(tmp, 'x-')) });
  const r = fm.set(true);
  assert.equal(r.enabled, true); assert.equal(focus, true);
  assert.equal(r.dshPet.ok, false); assert.equal(r.dshPet.code, 'focus.dshpet-config'); assert.ok(r.dshPet.hint);
});

console.log('quiet everywhere');
await ok('右键菜单：有专注开关，文字跟着状态变', () => {
  assert.equal(buildMenu({ enabled: false }, false).labels[0], '专注模式：关（点我开）');
  const on = buildMenu({ enabled: false }, true);
  assert.equal(on.labels[0], '专注模式：开 ✓（点我关）'); assert.deepEqual(on.actions.get(on.labels[0]), { type: 'focus', enable: false });
});
await ok('桌宠气泡：专注时她主动的不弹；你点菜单的确认（force）照弹', async () => {
  const sent = [];
  let quiet = true;
  const b = createDshPetBridge({ ctx: {}, chat: {}, readConfig: () => ({ enabled: true }), currentDshUrl: () => 'http://dsh', dshPetUserRoot: tmp, quiet: () => quiet });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { sent.push(String(u)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  try {
    assert.equal((await b.broadcast('她想说的')).code, 'focus');
    assert.equal(sent.length, 0);
    assert.equal((await b.broadcast('专注模式开了', { force: true })).ok, true);
    quiet = false;
    assert.equal((await b.broadcast('平时')).ok, true);
  } finally { globalThis.fetch = realFetch; }
});
await ok('桌宠生活：专注时不跳舞、不冒 B站 气泡；关了专注也不会把专注期间的补一堆', async () => {
  const biliDir = fs.mkdtempSync(path.join(tmp, 'bili-'));
  const t0 = new Date(2026, 10, 18, 15, 0).getTime();
  let t = t0;
  fs.writeFileSync(path.join(biliDir, 'mood.json'), JSON.stringify({ value: 8, at: new Date(t0).toISOString() }));
  fs.writeFileSync(path.join(biliDir, 'quota.json'), JSON.stringify({ log: [{ at: new Date(t0 + 30_000).toISOString(), type: 'dm', share: true }] }));
  const calls = []; const bubbles = [];
  let quiet = true;
  const life = createPetLife({
    readConfig: () => ({}), readNight: () => ({}), biliDir, currentDshUrl: () => 'http://dsh', now: () => t, quiet: () => quiet,
    broadcast: async (s) => { bubbles.push(s); return { ok: true }; },
    fetchImpl: async (u) => { calls.push(String(u)); return { json: async () => (String(u).includes('/pose') ? { ok: true, x: 0.5 } : { ok: true }) }; },
  });
  t = t0 + 40 * 60_000;
  await life.tick();
  assert.equal(calls.some((u) => u.includes('/anim')), false); assert.equal(bubbles.length, 0);
  quiet = false;
  await life.tick();
  assert.equal(bubbles.length, 0, '专注期间那条分享不补');
});
await ok('晚间回顾：专注时先不说、不记今天说过', async () => {
  const sent = [];
  const recap = createDailyRecap({
    chat: { systemPromptForFrontend: () => '', complete: async () => ({ text: 'x' }), proactive: async (p) => { sent.push(p); return { ok: true }; } },
    readConfig: () => ({}), biliDir: tmp, stateDir: fs.mkdtempSync(path.join(tmp, 'r-')), now: () => new Date(2026, 10, 18, 23, 0), quiet: () => true,
  });
  const r = await recap.runOnce();
  assert.equal(r.skipped, 'focus'); assert.equal(sent.length, 0); assert.equal(recap.status().state.lastDate, undefined);
});
await ok('B站 桌面通知：专注时不弹（命令里说明一句）', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, 'surfcore', 'pet'), { recursive: true });
  fs.writeFileSync(path.join(home, 'surfcore', 'pet', 'focus.json'), JSON.stringify({ enabled: true }));
  const cfgFile = path.join(home, 'surfcore', 'bili.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ notify: { type: 'desktop' } }));
  const notify = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools', 'commands', 'notify.mjs');
  const r = spawnSync(process.execPath, [notify, '测试消息'], { env: { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfgFile }, encoding: 'utf8', timeout: 20000 });
  assert.match(r.stdout + r.stderr, /专注模式开着：桌面通知没弹/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`focus mode: ${passed} passed`);
