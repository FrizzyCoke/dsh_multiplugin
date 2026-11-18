// 桌宠的生活（心情上脸 / 跟着作息睡 / B站 反应）+ 懂他（他的观看历史 / 对分享的反应 / 他说过的日子）。
// 假 fetch、临时 DSH_HOME，不联网、不碰真宠物。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPetLife, inSleepWindow, moodAnim, newBiliEvents, scrollingNow, HAPPY_ANIMS, SULKY_ANIMS, SHARE_ANIM } from '../lib/pet-life.js';
import { effectiveMinScore, parseOwnerHistory, reactionLines, refreshOwnerHistory, shareReactions, tasteFrom } from '../tools/lib/owner-taste.mjs';
import { dueDates, dueLines, parseWhen } from '../tools/lib/dates.mjs';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'know-you-'));
const night = { windows: [{ start: '07:30', end: '24:00', wakes: 10 }, { start: '00:00', end: '07:30', wakes: 2, quietSkip: true }], weekend: { enabled: true, windows: [{ start: '00:00', end: '09:30', wakes: 2, quietSkip: true }, { start: '09:30', end: '24:00', wakes: 10 }] } };

console.log('pet life');
await ok('睡觉时段：工作日 0~7:30、周末睡到 9:30；不是 quietSkip 的窗口不算', () => {
  assert.equal(inSleepWindow(night, new Date(2026, 10, 18, 3, 0)), true);   // 周三凌晨
  assert.equal(inSleepWindow(night, new Date(2026, 10, 18, 8, 30)), false);
  assert.equal(inSleepWindow(night, new Date(2026, 10, 21, 8, 30)), true);  // 周六 8:30 还在睡
  assert.equal(inSleepWindow({ windows: [{ start: '00:00', end: '07:30' }] }, new Date(2026, 10, 18, 3, 0)), false);
});
await ok('半夜醒来刷 B站 那 40 分钟算醒着', () => {
  const t = Date.now();
  assert.equal(scrollingNow({ action: 'wake', fired: true, wokeAt: new Date(t - 10 * 60_000).toISOString() }, t), true);
  assert.equal(scrollingNow({ action: 'wake', fired: true, wokeAt: new Date(t - 60 * 60_000).toISOString() }, t), false);
  assert.equal(scrollingNow({ action: 'skip', fired: true }, t), false);
});
await ok('心情 → 动画：≥5 开心、≤-4 不爽、中间不播', () => {
  assert.ok(HAPPY_ANIMS.includes(moodAnim(7, () => 0.3)));
  assert.ok(SULKY_ANIMS.includes(moodAnim(-6, () => 0.3)));
  assert.equal(moodAnim(1), null);
});
await ok('B站 新动作：只看 since 之后的，分享 / 评论分开', () => {
  const q = { log: [{ at: '2026-11-18T01:00:00Z', type: 'comment' }, { at: '2026-11-18T02:00:00Z', type: 'dm', share: true }, { at: '2026-11-18T03:00:00Z', type: 'other' }] };
  const ev = newBiliEvents(q, new Date('2026-11-18T01:30:00Z').getTime());
  assert.deepEqual(ev.map((e) => e.kind), ['share']);
});

function fakePet({ onDesktop = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ route: u.replace(/^.*\/dsh-pet-7340/, '').replace(/\?.*$/, ''), body: init?.body ? JSON.parse(init.body) : undefined });
    if (u.includes('/pose')) return { json: async () => (onDesktop ? { ok: true, x: 0.5, y: 0.9 } : { ok: false, reason: 'pet-not-displayed' }) };
    return { json: async () => ({ ok: true }) };
  };
  return { calls, fetchImpl };
}
const biliDir = path.join(tmp, 'bili'); fs.mkdirSync(biliDir, { recursive: true });

await ok('夜里到点 → /sleep；天亮 → /wake；你刚找过它就不睡', async () => {
  let t = new Date(2026, 10, 18, 2, 0).getTime();
  let chatAt = 0;
  const pet = fakePet();
  const life = createPetLife({ readConfig: () => ({}), readNight: () => night, biliDir, currentDshUrl: () => 'http://dsh', fetchImpl: pet.fetchImpl, now: () => t, lastChatAt: () => chatAt });
  await life.tick();
  assert.ok(pet.calls.some((c) => c.route === '/sleep')); assert.equal(life.status().sleeping, true);
  t = new Date(2026, 10, 18, 8, 0).getTime();
  await life.tick();
  assert.ok(pet.calls.some((c) => c.route === '/wake')); assert.equal(life.status().sleeping, false);
  const pet2 = fakePet();
  t = new Date(2026, 10, 18, 3, 0).getTime(); chatAt = t - 60_000;
  const life2 = createPetLife({ readConfig: () => ({}), readNight: () => night, biliDir, currentDshUrl: () => 'http://dsh', fetchImpl: pet2.fetchImpl, now: () => t, lastChatAt: () => chatAt });
  await life2.tick();
  assert.equal(pet2.calls.some((c) => c.route === '/sleep'), false, '刚说过话：不睡');
});
await ok('她刚分享 → 雀跃动画 + 一句气泡；没在桌面上就什么都不做', async () => {
  const t0 = new Date(2026, 10, 18, 14, 0).getTime();
  let t = t0;
  const bubbles = [];
  const pet = fakePet();
  const life = createPetLife({ readConfig: () => ({}), readNight: () => night, biliDir, currentDshUrl: () => 'http://dsh', fetchImpl: pet.fetchImpl, now: () => t, broadcast: async (s) => { bubbles.push(s); return { ok: true }; } });
  fs.writeFileSync(path.join(biliDir, 'quota.json'), JSON.stringify({ log: [{ at: new Date(t0 + 30_000).toISOString(), type: 'dm', share: true }] }));
  t = t0 + 60_000;
  await life.tick();
  assert.ok(pet.calls.some((c) => c.route === '/anim' && c.body.name === SHARE_ANIM)); assert.equal(bubbles.length, 1);
  await life.tick();
  assert.equal(bubbles.length, 1, '同一条不重复');
  const off = fakePet({ onDesktop: false });
  const life2 = createPetLife({ readConfig: () => ({}), readNight: () => night, biliDir, currentDshUrl: () => 'http://dsh', fetchImpl: off.fetchImpl, now: () => t });
  await life2.tick();
  assert.deepEqual(off.calls.map((c) => c.route), ['/pose']);
});
await ok('心情动画隔一阵才一次；很开心时跳舞', async () => {
  fs.writeFileSync(path.join(biliDir, 'quota.json'), JSON.stringify({ log: [] }));
  const t0 = new Date(2026, 10, 18, 15, 0).getTime();
  let t = t0;
  fs.writeFileSync(path.join(biliDir, 'mood.json'), JSON.stringify({ value: 8, at: new Date(t0).toISOString() }));
  const pet = fakePet();
  const life = createPetLife({ readConfig: () => ({}), readNight: () => night, biliDir, currentDshUrl: () => 'http://dsh', fetchImpl: pet.fetchImpl, now: () => t, random: () => 0.1 });
  await life.tick();
  assert.equal(pet.calls.some((c) => c.route === '/anim'), false, '刚启动不马上播');
  t = t0 + 31 * 60_000;
  await life.tick();
  const anim = pet.calls.find((c) => c.route === '/anim');
  assert.ok(anim && HAPPY_ANIMS.includes(anim.body.name));
});

console.log('know you');
await ok('他的观看历史：只要视频、去掉泛标签、口味按标签次数', () => {
  const items = parseOwnerHistory([
    { title: 'A', tag_name: '网络游戏,搞笑', history: { bvid: 'BV1aaaaaaaaa', business: 'archive' }, view_at: 1 },
    { title: 'B', tag_name: '网络游戏', history: { bvid: 'BV1bbbbbbbbb', business: 'archive' } },
    { title: '直播', history: { business: 'live' } },
  ]);
  assert.equal(items.length, 2); assert.deepEqual(items[0].tags, ['网络游戏']);
  assert.deepEqual(tasteFrom(items), [{ tag: '网络游戏', count: 2 }]);
});
await ok('拉历史：2 小时缓存；没登录 → 带 code 不报错', async () => {
  const cacheFile = path.join(tmp, 'oh.json');
  let hits = 0;
  const fetchImpl = async () => { hits += 1; return { json: async () => ({ code: 0, data: { list: [{ title: 'X', history: { bvid: 'BV1ccccccccc', business: 'archive' } }] } }) }; };
  const cred = path.join(tmp, 'owner.json'); fs.writeFileSync(cred, JSON.stringify({ sessdata: 'test' }));
  const r1 = await refreshOwnerHistory({ credFile: cred, cacheFile, fetchImpl });
  assert.equal(r1.ok, true); assert.equal(r1.items.length, 1);
  const r2 = await refreshOwnerHistory({ credFile: cred, cacheFile, fetchImpl });
  assert.equal(r2.cached, true); assert.equal(hits, 2, '第二次走缓存（第一次拉了两页）');
  const r3 = await refreshOwnerHistory({ credFile: path.join(tmp, 'none.json'), cacheFile: path.join(tmp, 'x.json'), fetchImpl });
  assert.equal(r3.ok, false); assert.equal(r3.code, 'owner-watch.no-login');
});
await ok('他对分享的反应：回得多门槛降、老不理升、样本少不动（最多 ±2）', () => {
  const t = Date.now();
  const mk = (a, i) => ({ state: { pending: [...Array(a).fill(0).map((_, k) => ({ kind: 'share', at: new Date(t - k * 1000).toISOString(), answered: true, target: `BV${k}` })), ...Array(i).fill(0).map((_, k) => ({ kind: 'share', at: new Date(t - k * 1000).toISOString(), expired: true }))] } });
  assert.equal(effectiveMinScore(11, mk(5, 0).state, { now: t }).minScore, 9);
  assert.equal(effectiveMinScore(11, mk(0, 6).state, { now: t }).minScore, 13);
  assert.equal(effectiveMinScore(11, mk(1, 1).state, { now: t }).minScore, 11, '样本少');
  assert.equal(shareReactions(mk(2, 3).state, { now: t }).ignored.length, 3);
  const lines = reactionLines(mk(4, 1).state, { d: [{ bv: 'BV0', title: '狼叔抓羊' }] }, 11, { now: t }).join('\n');
  assert.match(lines, /他回过的分享：「狼叔抓羊」/);
});
await ok('日子：一次性 / 每年；今天 / 明天提醒；坏日期拒', () => {
  assert.deepEqual(parseWhen('2026-12-03'), { when: '2026-12-03', yearly: false });
  assert.deepEqual(parseWhen('3-15'), { when: '03-15', yearly: true });
  assert.equal(parseWhen('2026-02-31'), null); assert.equal(parseWhen('明天'), null);
  const items = [{ id: 1, when: '2026-11-19', what: '他考试' }, { id: 2, when: '11-18', yearly: true, what: '他生日' }, { id: 3, when: '2025-11-18', yearly: true, what: '去年记的纪念日' }];
  const due = dueDates(items, new Date(2026, 10, 18, 9));
  assert.deepEqual(due.map((d) => `${d.id}:${d.due}`), ['1:tomorrow', '2:today', '3:today']);
  assert.match(dueLines(items, new Date(2026, 10, 18, 9)).join('\n'), /明天是他说过的「他考试」/);
});

console.log('commands (temp DSH_HOME)');
const home = path.join(tmp, 'home');
const cfgFile = path.join(home, 'surfcore', 'bili.config.json');
fs.mkdirSync(path.join(home, 'surfcore', 'bili'), { recursive: true });
fs.writeFileSync(path.join(home, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'test', bili_jct: 'test', buvid3: 'test' }));
fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '123456789' }, share: { minScore: 11, chatDaily: 6 } }));
const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfgFile };
const toolsDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools');
const cli = (...args) => spawnSync(process.execPath, [path.join(toolsDir, 'bili.mjs'), ...args], { env, encoding: 'utf8', timeout: 20000 });
const state = (name) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { biliState } from './tools/lib/state-paths.mjs'; process.stdout.write(biliState(${JSON.stringify(name)}))`], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) }).stdout;

await ok('dates add：只记他 48 小时内真说过的；坏日期 / 没写是啥 都带 code', () => {
  fs.rmSync(state('owner-last-dm.json'), { force: true });
  assert.match(cli('dates', 'add', '--when', '2026-12-03', '--what', '他考试').stderr, /dates\.no-source/);
  fs.writeFileSync(state('owner-last-dm.json'), JSON.stringify({ at: new Date().toISOString() }));
  assert.match(cli('dates', 'add', '--when', '明天', '--what', 'x').stderr, /dates\.bad-when/);
  assert.match(cli('dates', 'add', '--when', '2026-12-03').stderr, /dates\.no-what/);
  assert.equal(cli('dates', 'add', '--when', '2026-12-03', '--what', '他考试').status, 0);
  assert.match(cli('dates').stdout, /2026-12-03 他考试/);
});
await ok('私信分享要真到线：没评分 / 分不够 → 拒（带 code）', () => {
  const today = new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(state('scores.json'), JSON.stringify({ [today]: [{ bv: 'BV1lowlowlo1', score: 8 }, { bv: 'BV1goodgood1', score: 15 }] }));
  assert.match(cli('dm', '--msg', '看这个', '--share', '--target', 'BV1unscored1', '--dry').stderr, /dm\.share-unscored/);
  assert.match(cli('dm', '--msg', '看这个', '--share', '--target', 'BV1lowlowlo1', '--dry').stderr, /dm\.share-score.*8 分.*11/);
  assert.doesNotMatch(cli('dm', '--msg', '看这个', '--share', '--target', 'BV1goodgood1', '--dry').stderr, /dm\.share-(score|unscored)/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`know you: ${passed} passed`);
