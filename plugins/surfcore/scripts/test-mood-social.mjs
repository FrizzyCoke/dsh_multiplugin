// 心情 / 一起看 / 梗 / 关注 UP / 周回顾 / 桌宠挪位置（2026-11-18）。不联网、不发真消息：临时 DSH_HOME、假 fetch、假模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  addPending, applyMood, chatCapFor, checkIgnored, decayedMood, moodLabel, moodSkipShift, moodVideosFactor, ownerReplied,
} from '../tools/lib/mood.mjs';
import { applyEnergyToSlot } from '../tools/lib/night-schedule.mjs';
import { candidatesFrom } from '../tools/lib/follow-core.mjs';
import { collectBiliWeek, createDailyRecap, WEEKLY_INSTRUCTION } from '../lib/daily-recap.js';
import { createPetMove, parseDirection, targetX } from '../lib/pet-move.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const H = 3_600_000;
const T0 = new Date(2026, 10, 18, 14, 0).getTime();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-social-'));

console.log('mood');
await ok('回落：4 小时消一半；夹在 ±10', () => {
  assert.equal(decayedMood({ value: 8, at: new Date(T0).toISOString() }, T0 + 4 * H), 4);
  assert.equal(decayedMood({ value: 8, at: new Date(T0).toISOString() }, T0), 8);
  let s = {};
  for (let i = 0; i < 20; i += 1) s = applyMood(s, 2, { now: T0 + i * H, kind: 'dm' }).state;
  assert.ok(s.value <= 10);
});
await ok('一次最多 ±3、一小时累计最多 ±6（更灵活，但刷屏照样打不到底）', () => {
  let r = applyMood({}, 5, { now: T0, kind: 'dm' });
  assert.equal(r.applied, 3);
  r = applyMood(r.state, 3, { now: T0 + 1000, kind: 'dm' });
  r = applyMood(r.state, -3, { now: T0 + 2000, kind: 'dm' });
  assert.equal(r.applied, 0, '这一小时已经动了 6');
  r = applyMood(r.state, -2, { now: T0 + H + 5000, kind: 'dm' });
  assert.ok(r.applied < 0, '过了一小时又能动');
});
await ok('各来源权重：乘在变化量上；0 = 这个来源不影响心情', () => {
  const cfg = { weights: { pet: 2, video: 0 } };
  assert.equal(applyMood({}, 1, { now: T0, kind: 'pet', cfg }).applied, 2);
  assert.equal(applyMood({}, -1, { now: T0, kind: 'video', cfg }).applied, 0);
  assert.equal(applyMood({}, -1, { now: T0, kind: 'ignored', cfg }).applied, -1, '没写的来源按 1');
});
await ok('门槛放低：到 3 就很开心、-1 就有点不爽；分档可配', () => {
  assert.deepEqual([moodLabel(4), moodLabel(1.5), moodLabel(0), moodLabel(-2), moodLabel(-5)], ['很开心', '心情不错', '平常', '有点不爽', '闷闷不乐']);
  assert.equal(moodLabel(2, { bands: { happy: 2 } }), '很开心');
  assert.ok(moodSkipShift(-10) > 0 && moodSkipShift(10) < 0);
  assert.ok(moodVideosFactor(10) > 1 && moodVideosFactor(-10) < 1);
});
await ok('闲聊上限：不爽只会变少，开心也不超过设置的数', () => {
  assert.equal(chatCapFor(9, 6), 6);
  assert.equal(chatCapFor(0, 6), 6);
  assert.equal(chatCapFor(-2, 6), 3);
  assert.equal(chatCapFor(-8, 6), 2);
  assert.equal(chatCapFor(-8, 0), 0);
  for (let v = -10; v <= 10; v += 1) assert.ok(chatCapFor(v, 6) <= 6);
});
await ok('他回了她主动发的 → +1（只算一次）；没有等回的不加', () => {
  let s = addPending({}, { now: T0, kind: 'chat' });
  s = addPending(s, { now: T0 + 1000, kind: 'share' });
  const r = ownerReplied(s, { now: T0 + H });
  assert.equal(r.applied, 1);
  assert.ok(r.state.pending.every((p) => p.answered));
  assert.equal(ownerReplied(r.state, { now: T0 + 2 * H }).applied, 0);
});
await ok('不理她：他今天在线却 2 小时没回 → -1；他不在 / 半夜发的不冤枉；一天最多扣 4', () => {
  const around = { ownerLastAt: new Date(T0 - H).toISOString() };
  let s = addPending(around, { now: T0, kind: 'chat' });
  assert.equal(checkIgnored(s, { now: T0 + 1.5 * H }).applied, 0, '还没到 2 小时');
  let r = checkIgnored(s, { now: T0 + 3.5 * H });
  assert.equal(r.applied, -1);
  assert.equal(checkIgnored(r.state, { now: T0 + 5 * H }).applied, 0, '同一条不重复扣');
  const away = addPending({ ownerLastAt: new Date(T0 - 30 * H).toISOString() }, { now: T0, kind: 'chat' });
  assert.equal(checkIgnored(away, { now: T0 + 4 * H }).applied, 0, '他一天没上 B站：不算不理');
  const night = addPending(around, { now: new Date(2026, 10, 18, 3, 0).getTime(), kind: 'chat' });
  assert.equal(checkIgnored(night, { now: new Date(2026, 10, 18, 9, 0).getTime() }).applied, 0, '凌晨 3 点发的：不算');
  let many = { ownerLastAt: new Date(T0 - H).toISOString() };
  for (let i = 0; i < 6; i += 1) many = addPending(many, { now: T0 + i * 60_000, kind: 'chat' });
  r = checkIgnored(many, { now: T0 + 4 * H });
  assert.equal(r.state.ignorePenalty, 4, '一天最多扣 4（ignorePenaltyDaily）');
});
await ok('心情进刷视频：不爽更容易不刷（安静不刷、标 sulky），开心多刷几条；一趟只定一次', () => {
  const slot = () => ({ id: 's1', status: 'pending', action: 'wake', at: 600, maxVideos: 12 });
  let date = '';
  for (let i = 0; i < 300 && !date; i += 1) { const s = { slots: [slot()] }; applyEnergyToSlot(s, s.slots[0], { date: `m${i}`, nowMin: 600, moodValue: -10 }); if (s.slots[0].action === 'skip') date = `m${i}`; }
  assert.ok(date);
  const s = { slots: [slot()] };
  applyEnergyToSlot(s, s.slots[0], { date, nowMin: 600, moodValue: -10 });
  assert.equal(s.slots[0].sulky, true); assert.equal(s.slots[0].quietSkip, true);
  applyEnergyToSlot(s, s.slots[0], { date, nowMin: 900, moodValue: 10 });
  assert.equal(s.slots[0].action, 'skip', '重算不变');
  const h = { slots: [slot()] };
  applyEnergyToSlot(h, h.slots[0], { date: 'x', nowMin: 600, moodValue: 10 });
  assert.equal(h.slots[0].action, 'wake'); assert.equal(h.slots[0].maxVideos, 15);
});

console.log('commands (temp DSH_HOME)');
const home = path.join(tmp, 'home');
const cfgFile = path.join(home, 'surfcore', 'bili.config.json');
fs.mkdirSync(path.join(home, 'surfcore', 'bili'), { recursive: true });
fs.writeFileSync(path.join(home, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'test', bili_jct: 'test', buvid3: 'test' }));
fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '123456789' }, share: { minScore: 11 }, preferences: { dislike: ['猫咪'] } }));
const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfgFile };
const cli = (...args) => spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools', 'bili.mjs'), ...args], { env, encoding: 'utf8', timeout: 20000 });
const stateFile = (name) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { biliState } from './tools/lib/state-paths.mjs'; process.stdout.write(biliState(${JSON.stringify(name)}))`], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) }).stdout;

await ok('mood note：要给 delta 和理由；幅度被夹到 ±3', () => {
  assert.match(cli('mood', 'note', '--delta', '0', '--why', 'x').stderr, /mood\.bad-delta/);
  assert.match(cli('mood', 'note', '--delta', '2').stderr, /mood\.no-why/);
  const r = cli('mood', 'note', '--delta', '5', '--why', '他发的梗笑死');
  assert.equal(r.status, 0); assert.match(r.stdout, /\+3/);
  assert.match(cli('mood').stdout, /心情：3/);
});
await ok('梗：必须有出处；dm 出处要他 48 小时内真私信过；一天只翻一个旧梗', () => {
  assert.match(cli('joke', 'add', '--text', '编的梗', '--source', 'xx').stderr, /joke\.no-source/);
  fs.rmSync(stateFile('owner-last-dm.json'), { force: true });
  assert.match(cli('joke', 'add', '--text', '狼叔职业病', '--source', 'dm').stderr, /joke\.no-source/);
  fs.writeFileSync(stateFile('owner-last-dm.json'), JSON.stringify({ at: new Date().toISOString() }));
  assert.equal(cli('joke', 'add', '--text', '狼叔职业病', '--source', 'dm').status, 0);
  assert.equal(cli('joke', 'add', '--text', '水果咬人', '--source', 'BV1xx411c7mD').status, 0);
  assert.equal(cli('joke', 'use', '--id', '1').status, 0);
  assert.match(cli('joke', 'use', '--id', '2').stderr, /joke\.daily/);
});
await ok('关注 UP：14 天里同一个 UP ≥3 条到线才够格；不爱看的、关过的排除；不够格的 --mid 被拒', () => {
  const scores = { a: [
    { bv: 'BV1', mid: '11', up: '狼叔', score: 15, title: '狼叔抓羊' },
    { bv: 'BV2', mid: '11', up: '狼叔', score: 12, title: '狼叔又来' },
    { bv: 'BV3', mid: '11', up: '狼叔', score: 18, title: '狼叔名场面' },
    { bv: 'BV4', mid: '22', up: '猫咪日常', score: 19 }, { bv: 'BV5', mid: '22', up: '猫咪日常', score: 19 }, { bv: 'BV6', mid: '22', up: '猫咪日常', score: 19 },
    { bv: 'BV7', mid: '33', up: '一般', score: 10 }, { bv: 'BV8', mid: '33', up: '一般', score: 20 }, { bv: 'BV9', mid: '33', up: '一般', score: 20 },
  ] };
  assert.deepEqual(candidatesFrom(scores, 11, {}, ['猫咪']).map((c) => c.mid), ['11']);
  assert.deepEqual(candidatesFrom(scores, 11, { 11: {} }, ['猫咪']), []);
  const r = cli('follow', '--mid', '99999', '--dry');
  assert.equal(r.status, 4); assert.match(r.stderr, /follow\.not-qualified/);
});

console.log('watch together / owner DM');
const { newWatchTogether, ownerDmLines } = await import('../lib/scheduler.js');
await ok('他发的视频：BV 和 b23 短链都认，看过的不重复', async () => {
  const file = path.join(tmp, 'wt.json');
  const fetchImpl = async (url) => ({ headers: { get: () => (String(url).includes('abc') ? 'https://www.bilibili.com/video/BV1Ab411c7mD?p=1' : '') } });
  const first = await newWatchTogether('看这个 https://b23.tv/abc 还有 BV1xx411c7mD', { file, fetchImpl });
  assert.deepEqual(first.sort(), ['BV1Ab411c7mD', 'BV1xx411c7mD']);
  assert.deepEqual(await newWatchTogether('BV1xx411c7mD', { file, fetchImpl }), []);
});
await ok('主人私信提示：带心情、不许抱怨没人理、一起看的步骤、时间只用 debrief 给的', () => {
  const text = ownerDmLines({ moodValue: -2, bvids: ['BV1xx411c7mD'] }).join('\n');
  assert.match(text, /有点不爽/); assert.match(text, /不许.*抱怨/);
  assert.match(text, /debrief BV1xx411c7mD --no-frames/); assert.match(text, /\?t=秒数/); assert.match(text, /没有时间就别编/);
  assert.match(text, /mood note/); assert.match(text, /joke/);
});

console.log('weekly recap');
await ok('周日：说这周口味变化（7 天、最好最烂、逛过的方向）', async () => {
  const dir = path.join(tmp, 'wk'); fs.mkdirSync(dir, { recursive: true });
  const sun = new Date(2026, 10, 22, 22, 40);
  const d = (n) => new Date(2026, 10, 22 - n, 12).toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(dir, 'scores.json'), JSON.stringify({ [d(0)]: [{ bv: 'BVa', score: 17, title: '狼叔' }], [d(3)]: [{ bv: 'BVb', score: 3, title: '烂片' }, { bv: 'BVc', score: 12, title: '还行' }, { bv: 'BVd', score: 9, title: '一般' }], [d(9)]: [{ bv: 'BVz', score: 20, title: '太早了' }] }));
  fs.writeFileSync(path.join(dir, 'explore-log.json'), JSON.stringify({ entries: [{ date: d(3), term: '狼叔整活', bvs: ['BVa'] }] }));
  const w = collectBiliWeek(dir, d(0));
  assert.equal(w.watched, 4); assert.equal(w.top[0].title, '狼叔'); assert.equal(w.worst.title, '烂片');
  assert.deepEqual(w.explores, [{ term: '狼叔整活', avg: 17 }]);
  const calls = [];
  const recap = createDailyRecap({
    chat: { systemPromptForFrontend: () => 'P', complete: async (o) => { calls.push(o); return { text: '这周狼叔刷上头了' }; }, proactive: async () => ({ ok: true }) },
    readConfig: () => ({}), biliDir: dir, stateDir: path.join(tmp, 'wkstate'), now: () => sun,
  });
  const r = await recap.runOnce();
  assert.equal(r.ok, true); assert.ok(calls[0].system.includes(WEEKLY_INSTRUCTION)); assert.match(calls[0].user, /最烂/);
});

console.log('pet move');
await ok('方向解析 + 目标位置夹在屏幕内', () => {
  assert.equal(parseDirection(' Left '), 'left'); assert.equal(parseDirection('none'), null); assert.equal(parseDirection('往左'), null);
  assert.equal(targetX(0.6, 'left'), 0.35); assert.equal(targetX(0.1, 'left'), 0.05); assert.equal(targetX(0.9, 'right'), 0.95); assert.equal(targetX(0.2, 'center'), 0.5);
});
await ok('走过去：先打断当前动作 → 转向 + 用 dsh-pet 自带的走路真走（不另外平移）；远的分几步走到；没显示在桌面 → 带 code', async () => {
  // 假宠物：收到走位动作就按朝向挪一段（跟 dsh-pet 的 tryMove 一样：方向 = facing）
  const mk = (x0, { onDesktop = true, busy = false } = {}) => {
    const calls = [];
    let x = x0;
    const m = createPetMove({
      chat: {}, readConfig: () => ({}), currentDshUrl: () => 'http://dsh', pollMs: 0, leadWaitMs: 0,
      fetchImpl: async (url, init) => {
        const route = String(url).replace(/^.*\/dsh-pet-7340/, '').replace(/\?.*$/, '');
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ route, body });
        if (route === '/pose') return { json: async () => (onDesktop ? { ok: true, x, y: 0.9 } : { ok: false, reason: 'pet-not-displayed', message: '没显示' }) };
        if (route === '/anim') {
          if (busy) return { json: async () => ({ ok: false, reason: 'busy' }) };
          const step = body.name === '原地左转奔跑' ? 0.2 : 0.1;
          x = Math.max(0.05, Math.min(0.95, x + (body.facing === 'left' ? -step : step)));
        }
        return { json: async () => ({ ok: true }) };
      },
    });
    return { m, calls, posX: () => x };
  };
  const a = mk(0.6);
  const r = await a.m.move('main', 'left');
  assert.equal(r.ok, true); assert.equal(r.facing, 'left'); assert.equal(r.steps, 1);
  const routes = a.calls.map((c) => c.route);
  assert.deepEqual(routes.slice(0, 3), ['/pose', '/position', '/anim'], '先读位置 → 原地打断 → 走');
  assert.equal(a.calls[1].body.mode, 'instant'); assert.equal(a.calls[1].body.x, 0.6, '打断时不挪位置');
  assert.equal(a.calls[2].body.name, '螃蟹走路'); assert.equal(a.calls[2].body.facing, 'left');
  assert.equal(a.calls.filter((c) => c.route === '/position').length, 1, '不再另外平移');
  assert.ok(a.posX() < 0.6);
  const c = mk(0.1);
  const rc = await c.m.move('main', 'center');
  assert.ok(rc.steps >= 2, `远的分几步：${rc.steps}`); assert.ok(Math.abs(c.posX() - 0.5) <= 0.1, `走到中间附近：${c.posX()}`);
  assert.ok(c.calls.filter((x) => x.route === '/anim').every((x) => x.body.facing === 'right'));
  const o = mk(0.8);
  const ro = await o.m.move('main', 'otherside');
  assert.equal(ro.facing, 'left'); assert.equal(o.calls.find((x) => x.route === '/anim').body.name, '原地左转奔跑', '往那边：跑');
  const off = mk(0.5, { onDesktop: false });
  const n = await off.m.move('main', 'left');
  assert.equal(n.ok, false); assert.equal(n.code, 'petmove.no-desktop'); assert.deepEqual(off.calls.map((x) => x.route), ['/pose']);
  const b = mk(0.5, { busy: true });
  const nb = await b.m.move('main', 'left');
  assert.equal(nb.ok, false); assert.equal(nb.code, 'petmove.rejected');
});
await ok('桌宠对话的语气：同一次判断给出「挪不挪 + 语气」，怪她 → 交给心情；不挪的照样算语气', async () => {
  const { parseTone, TONES } = await import('../lib/pet-move.js');
  assert.equal(parseTone('blame'), 'blame'); assert.equal(parseTone('??'), 'neutral');
  assert.equal(TONES.funny, 2); assert.equal(TONES.rude, -2);
  const tones = [];
  let calls = 0;
  const m = createPetMove({
    chat: { complete: async () => { calls += 1; return { text: 'none blame' }; } },
    readConfig: () => ({ enabled: true }), currentDshUrl: () => '',
    toneEnabled: () => true, onTone: (tone, delta, text) => tones.push({ tone, delta, text }),
  });
  m.onUserMessage('你真笨');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1, '只调一次'); assert.deepEqual(tones, [{ tone: 'blame', delta: -1, text: '你真笨' }]);
});
await ok('挪位置关了、语气开着：照样判断语气，但不会走', async () => {
  const tones = []; const fetched = [];
  const m = createPetMove({
    chat: { complete: async () => ({ text: 'left funny' }) },
    readConfig: () => ({ enabled: false }), currentDshUrl: () => 'http://dsh',
    fetchImpl: async (u) => { fetched.push(String(u)); return { json: async () => ({ ok: true }) }; },
    toneEnabled: () => true, onTone: (tone) => tones.push(tone),
  });
  m.onUserMessage('往左走哈哈哈');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(tones, ['funny']); assert.equal(fetched.length, 0);
});
await ok('关掉就不判断（不花 token）', async () => {
  let asked = 0;
  const m = createPetMove({ chat: { complete: async () => { asked += 1; return { text: 'none' }; } }, readConfig: () => ({ enabled: false }), currentDshUrl: () => '' });
  m.onUserMessage('往左走');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`mood + social: ${passed} passed`);
