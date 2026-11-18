// 「出去逛」（按记忆自己换方向）+ 一天的回顾（2026-11-18）。不联网、不发真消息：假模型、假桌宠。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exploreEntries, exploreSummary, exploreSummaryLines, exploreWeight, normalizeExploreTerms, appendExploreLog, readExploreLog } from '../tools/lib/explore.mjs';
import { buildRecapPrompt, collectBiliDay, createDailyRecap, normalizeDailyRecapConfig } from '../lib/daily-recap.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-recap-'));

console.log('explore');
await ok('最多 2 个方向；跟「不爱看」沾边的拒', () => {
  const r = normalizeExploreTerms('狼叔整活，AI绘画, 水果梗, 原神整活', ['DSH/AI 工具与插件', '猫咪']);
  assert.deepEqual(r.terms, ['狼叔整活', '水果梗']);
  assert.ok(r.rejected.some((x) => x.term === 'AI绘画' && /不爱看/.test(x.why)));
  assert.ok(r.rejected.some((x) => x.term === '原神整活' && /最多/.test(x.why)));
  assert.deepEqual(normalizeExploreTerms('猫咪日常', ['猫咪']).terms, []);
  assert.deepEqual(normalizeExploreTerms('', []).terms, []);
});
await ok('探索词合计最多占三成权重（主人的口味权重说了算）', () => {
  const base = [{ weight: 1 }, { weight: 1 }, { weight: 1 }, { weight: 1 }, { weight: 1 }];
  for (const k of [1, 2]) {
    const w = exploreWeight(base, k);
    const share = (w * k) / (5 + w * k);
    assert.ok(share <= 0.3 + 1e-9, `k=${k} share=${share}`);
  }
  // 主人权重很高时探索只是一小块
  assert.ok(exploreWeight([{ weight: 5 }], 2) <= 1);
  const entries = exploreEntries(['狼叔整活'], base);
  assert.equal(entries[0].kind, 'explore'); assert.equal(entries[0].key, 'explore:狼叔整活');
});
await ok('「ai」按词边界拒：AI绘画 拒、aim 练枪 / rain 不误伤', () => {
  const dis = ['DSH/AI 工具与插件'];
  assert.deepEqual(normalizeExploreTerms('AI绘画', dis).terms, []);
  assert.deepEqual(normalizeExploreTerms('aim练枪, rain world', dis).terms, ['aim练枪', 'rain world']);
});
await ok('从探索词搜出来的候选算这个方向的（标题里没有原词也算）→ 战绩能记上', async () => {
  const { preferenceHits, selectDiverse } = await import('../tools/lib/feed-core.mjs');
  const { withExploreHits } = await import('../tools/lib/explore.mjs');
  const like = [{ key: '擦边', label: '擦边', kind: 'like', weight: 1, tokens: ['擦边'] }];
  const explore = exploreEntries(['狼叔整活'], like);
  const enabled = [...like, ...explore];
  const pool = [
    { bv: 'BV1w1', t: '【狼叔】又在抓羊了', kw: '狼叔整活', dm: 50, d: 100 },
    { bv: 'BV1w2', t: '狼叔名场面合集', kw: '狼叔整活', dm: 40, d: 100 },
    { bv: 'BV1c1', t: '擦边舞蹈', kw: '擦边', dm: 30, d: 100 },
  ];
  const candidates = pool.map((x) => ({ ...x, _hits: withExploreHits(preferenceHits(x.t, enabled), x, explore), _score: 1 }));
  const sel = selectDiverse(candidates, enabled, { n: 3, perPref: 2, generic: 1, seed: 's' });
  const viaExplore = sel.picked.filter((x) => x._via === explore[0].key).map((x) => x.bv);
  assert.ok(viaExplore.length >= 1, `探索方向记上了：${JSON.stringify(sel.picked.map((x) => [x.bv, x._via]))}`);
  // 不加这条规则时：标题里没有「狼叔整活」→ 一条都记不上（这就是要修的问题）
  const bare = pool.map((x) => ({ ...x, _hits: preferenceHits(x.t, enabled), _score: 1 }));
  assert.equal(selectDiverse(bare, enabled, { n: 3, perPref: 2, generic: 1, seed: 's' }).picked.filter((x) => x._via === explore[0].key).length, 0);
});
await ok('战绩：按评分判断接着挖还是换方向', () => {
  const file = path.join(tmp, 'explore-log.json');
  appendExploreLog(file, { date: '2026-11-17', term: '狼叔整活', bvs: ['BV1a', 'BV1b'] });
  appendExploreLog(file, { date: '2026-11-16', term: '水果梗', bvs: ['BV1c'] });
  appendExploreLog(file, { date: '2026-11-18', term: '新词', bvs: [] });
  const summary = exploreSummary(readExploreLog(file), { '2026-11-17': [{ bv: 'BV1a', score: 16 }, { bv: 'BV1b', score: 12 }], '2026-11-16': [{ bv: 'BV1c', score: 3 }] });
  const byTerm = Object.fromEntries(summary.map((s) => [s.term, s]));
  assert.equal(byTerm['狼叔整活'].avg, 14); assert.equal(byTerm['水果梗'].avg, 3); assert.equal(byTerm['新词'].avg, null);
  const lines = exploreSummaryLines(summary, 11).join('\n');
  assert.match(lines, /狼叔整活.*接着挖/); assert.match(lines, /水果梗.*换方向/); assert.match(lines, /新词.*还没评分/);
  assert.equal(summary[0].term, '新词', '最近的在前');
});

console.log('daily recap');
const biliDir = path.join(tmp, 'bili');
fs.mkdirSync(biliDir, { recursive: true });
const day = new Date(2026, 10, 18, 22, 40);
const date = day.toLocaleDateString('sv-SE');
fs.writeFileSync(path.join(biliDir, 'scores.json'), JSON.stringify({ [date]: [
  { bv: 'BV1x', score: 9, title: '普通视频', reason: '一般' },
  { bv: 'BV1y', score: 17, title: '狼叔又在抓羊', reason: '职业病笑死' },
], '2026-01-01': [{ bv: 'BV1old', score: 20, title: '旧的' }] }));
// 太平洋时间晚上收藏的（UTC 已是第二天）也要算今天
fs.writeFileSync(path.join(biliDir, 'favorites.json'), JSON.stringify({ items: [{ bv: 'BV1y', title: '狼叔又在抓羊', at: new Date(2026, 10, 18, 21, 0).toISOString() }] }));

await ok('读今天 B站 的事实：按分数排序、收藏按本机日期算', () => {
  const facts = collectBiliDay(biliDir, date);
  assert.equal(facts.watched, 2); assert.equal(facts.top[0].title, '狼叔又在抓羊');
  assert.deepEqual(facts.favs, ['狼叔又在抓羊']);
  assert.match(buildRecapPrompt(facts), /狼叔又在抓羊.*17\/20/);
});
await ok('配置收敛', () => {
  assert.deepEqual(normalizeDailyRecapConfig({}), { enabled: true, at: '22:30' });
  assert.equal(normalizeDailyRecapConfig({ at: '25:99' }).at, '22:30');
  assert.equal(normalizeDailyRecapConfig({ enabled: false, at: '21:05' }).at, '21:05');
});

function makeRecap({ at = day, reply = '狼叔那个抓羊的视频 笑死我了', deliver = { ok: true }, blocked = false, dir = biliDir } = {}) {
  const sent = [];
  const calls = [];
  const stateDir = fs.mkdtempSync(path.join(tmp, 'state-'));
  const recap = createDailyRecap({
    chat: {
      systemPromptForFrontend: () => 'PERSONA',
      complete: async (o) => { calls.push(o); if (reply instanceof Error) throw reply; return { text: reply, usage: {} }; },
      proactive: async (p) => { sent.push(p); return deliver; },
    },
    readConfig: () => ({ at: '22:30' }),
    biliDir: dir,
    stateDir,
    tokenBudget: { block: async () => ({ blocked }) },
    now: () => at,
  });
  return { recap, sent, calls };
}

await ok('到点说一次，进桌宠记忆；当天不再说（重启也不重发）', async () => {
  const { recap, sent, calls } = makeRecap();
  const r = await recap.runOnce();
  assert.equal(r.ok, true); assert.equal(sent.length, 1);
  assert.equal(sent[0].remember, true); assert.equal(sent[0].purpose.kind, 'recap');
  assert.match(calls[0].system, /PERSONA/); assert.match(calls[0].user, /狼叔又在抓羊/);
  const again = await recap.runOnce();
  assert.equal(again.skipped, 'done-today'); assert.equal(sent.length, 1);
  assert.equal(recap.status().state.lastText, '狼叔那个抓羊的视频 笑死我了');
});
await ok('没到点不说；今天没刷不说；额度用完不说', async () => {
  assert.equal((await makeRecap({ at: new Date(2026, 10, 18, 20, 0) }).recap.runOnce()).skipped, 'not-yet');
  const empty = path.join(tmp, 'empty-bili'); fs.mkdirSync(empty, { recursive: true });
  const e = makeRecap({ dir: empty });
  assert.equal((await e.recap.runOnce()).skipped, 'no-bili-today'); assert.equal(e.sent.length, 0);
  const b = makeRecap({ blocked: true });
  assert.equal((await b.recap.runOnce()).skipped, 'budget'); assert.equal(b.calls.length, 0);
});
await ok('失败带 code + hint，记 lastError，不记「今天说过」（下一分钟还能重试）', async () => {
  const f = makeRecap({ reply: '' });
  const r = await f.recap.runOnce();
  assert.equal(r.ok, false); assert.equal(r.code, 'recap.empty'); assert.ok(r.hint);
  assert.match(f.recap.status().state.lastError, /recap\.empty/); assert.equal(f.recap.status().state.lastDate, undefined);
  const d = makeRecap({ deliver: { ok: false, error: '桌宠不在线' } });
  const r2 = await d.recap.runOnce();
  assert.equal(r2.code, 'recap.deliver-failed'); assert.ok(r2.hint);
  const m = makeRecap({ reply: new Error('model down') });
  assert.equal((await m.recap.runOnce()).code, 'recap.failed');
});

console.log('pet closed → save tokens');
await ok('回顾：桌宠关着不说、不记「今天说过」，打开后再说', async () => {
  let present = false;
  const sent = [];
  const stateDir = fs.mkdtempSync(path.join(tmp, 'state-'));
  const recap = createDailyRecap({
    chat: { systemPromptForFrontend: () => 'P', complete: async () => ({ text: '狼叔那个绝了' }), proactive: async (p) => { sent.push(p); return { ok: true }; } },
    readConfig: () => ({}), biliDir, stateDir, now: () => day, petPresent: () => present,
  });
  assert.equal((await recap.runOnce()).skipped, 'no-pet'); assert.equal(sent.length, 0);
  assert.equal(recap.status().state.lastDate, undefined);
  present = true;
  assert.equal((await recap.runOnce()).ok, true); assert.equal(sent.length, 1);
});
await ok('看屏幕：开着也一样 —— 桌宠关着就不截图不调模型，打开自动恢复', async () => {
  const { createScreenWatch } = await import('../lib/screen-watch.js');
  let present = false;
  let captures = 0;
  const logs = [];
  const watch = createScreenWatch({
    chat: { lastActivity: () => ({}), systemPromptForFrontend: () => '', complete: async () => ({ text: '{"note":"x","say":null,"memory":null,"nextLookSec":60}' }), proactive: async () => ({ ok: true }) },
    source: { capture: async () => { captures += 1; return { ok: false, code: 'screen.test', error: 'stop here' }; } },
    readConfig: () => ({ enabled: true, firstIntervalSec: 15 }),
    pluginLog: (...a) => logs.push(a.join(' ')),
    now: () => 10_000_000,
    petPresent: () => present,
  });
  for (let i = 0; i < 3; i += 1) await watch.tick();
  assert.equal(captures, 0, '桌宠关着：一张都不截');
  assert.equal(logs.filter((l) => /暂停后台看屏幕/.test(l)).length, 1, '只提示一次');
  present = true;
  await watch.tick();
  assert.ok(logs.some((l) => /恢复看屏幕/.test(l)));
  assert.equal(watch.status().lastSkip === 'no-pet', false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`explore + recap: ${passed} passed`);
