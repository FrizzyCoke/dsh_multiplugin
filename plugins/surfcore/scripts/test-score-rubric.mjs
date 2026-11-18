// 打分标尺（tools/lib/score-rubric.mjs）+ score 命令 + 分享不信传进来的分。离线：SURFCORE_SCORE_OFFLINE=1、临时 DSH_HOME。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeScore, normalizeScoringConfig, pickLabels, rubricPromptLines, similarity, DEFAULT_WEIGHTS } from '../tools/lib/score-rubric.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };
const ctx = {
  like: ['擦边', '带货', '标题党', '纯搬运', '低质'],
  dislike: ['猫咪', 'DSH/AI 工具与插件'],
  prefWeights: { 擦边: 2 },
  ownerTaste: [{ tag: '网络游戏', count: 9 }, { tag: 'MAD·AMV', count: 5 }, { tag: '计算机技术', count: 4 }, { tag: '影视杂谈', count: 2 }],
  favorites: ['狼叔抓羊名场面'], highTitles: [], goodExplore: ['狼叔整活'], jokes: ['水果咬人'], recent: [], exploreToday: [],
};
const cfg = normalizeScoringConfig();

console.log('score rubric');
ok('满分 20：权重默认 7/2/2/2/4/3（他的口味别太重），13 分代码算', () => {
  assert.deepEqual(cfg.weights, DEFAULT_WEIGHTS);
  assert.equal(Object.values(cfg.weights).reduce((a, b) => a + b, 0), 20);
});
ok('她的口味：勾的类别 × 权重（擦边权重 2 → 一项就满）', () => {
  const one = computeScore({ title: '普通视频' }, { fits: ['标题党'], funny: 0, hooked: 0 }, ctx, cfg);
  const heavy = computeScore({ title: '普通视频' }, { fits: ['擦边'], funny: 0, hooked: 0 }, ctx, cfg);
  assert.equal(one.items.taste, 3.5); assert.equal(heavy.items.taste, 7);
});
ok('只认配置里的类别（模型自己造的类不算）', () => {
  assert.deepEqual(pickLabels('标题党, 神作, 低质', ctx.like), { ok: ['标题党', '低质'], unknown: ['神作'] });
  assert.equal(computeScore({ title: 'x' }, { fits: ['神作'], funny: 0, hooked: 0 }, ctx, cfg).items.taste, 0);
});
ok('他会喜欢：分区对上他观看历史的口味（前 3 满分，其余 0.7）', () => {
  assert.equal(computeScore({ title: 'x', tname: '网络游戏' }, { funny: 0, hooked: 0 }, ctx, cfg).items.him, 2);
  assert.equal(computeScore({ title: 'x', tname: '影视杂谈' }, { funny: 0, hooked: 0 }, ctx, cfg).items.him, 1.4);
  assert.equal(computeScore({ title: 'x', tname: '美食' }, { funny: 0, hooked: 0 }, ctx, cfg).items.him, 0);
});
ok('沾了不爱看的：封顶到分享线以下（字面出现也算）', () => {
  const r = computeScore({ title: '猫咪日常', tname: '网络游戏' }, { fits: ['擦边', '标题党'], funny: 4, hooked: 4 }, ctx, cfg);
  assert.equal(r.total, 6); assert.equal(r.capped, true); assert.deepEqual(r.dislikes, ['猫咪']);
});
ok('记忆：跟收藏 / 逛得好的方向 / 梗沾边加分（最多 2）', () => {
  const r = computeScore({ title: '狼叔抓羊名场面第二弹' }, { funny: 0, hooked: 0 }, ctx, cfg);
  assert.ok(r.items.memory > 0 && r.items.memory <= 2);
});
ok('新鲜：近似重复才扣；今天逛的方向搜来的不扣', () => {
  const rec = { ...ctx, recent: [{ title: '狼叔又在抓羊了 第三集', mid: '7' }] };
  assert.equal(computeScore({ title: '狼叔又在抓羊了 第三集', mid: '7' }, { funny: 0, hooked: 0 }, rec, cfg).items.fresh, 0);
  assert.equal(computeScore({ title: '完全不一样的视频', mid: '7' }, { funny: 0, hooked: 0 }, rec, cfg).items.fresh, 2);
  assert.equal(computeScore({ title: '狼叔又在抓羊了 第三集', mid: '7', kw: '狼叔整活' }, { funny: 0, hooked: 0 }, { ...rec, exploreToday: ['狼叔整活'] }, cfg).items.fresh, 2);
  assert.ok(similarity('狼叔又在抓羊了', '狼叔又在抓羊了第二集') > 0.7);
});
ok('好笑 0~4 → 4 分、上头 0~4 → 3 分；越界夹住', () => {
  const r = computeScore({ title: 'x' }, { funny: 4, hooked: 2 }, ctx, cfg);
  assert.equal(r.items.funny, 4); assert.equal(r.items.hooked, 1.5);
  assert.equal(computeScore({ title: 'x' }, { funny: 9, hooked: -3 }, ctx, cfg).items.funny, 4);
});
ok('权重可调：总分按 20 归一', () => {
  const c = normalizeScoringConfig({ weights: { taste: 10, him: 0, memory: 0, fresh: 0, funny: 5, hooked: 5 } });
  assert.equal(computeScore({ title: 'x' }, { fits: ['擦边'], funny: 4, hooked: 4 }, ctx, c).total, 20);
});
ok('提示里写清只能从哪几类选、锚点是什么、搬运/低质不扣分', () => {
  const text = rubricPromptLines({}, ctx.like, ctx.dislike).join('\n');
  assert.match(text, /擦边、带货、标题党/); assert.match(text, /笑到想立刻发给他/); assert.match(text, /搬运、低质本来就是你爱看的，不扣分/);
  assert.match(text, /13 分由代码/);
});

console.log('commands (temp DSH_HOME, offline)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-'));
const home = path.join(tmp, 'home');
const cfgFile = path.join(home, 'surfcore', 'bili.config.json');
fs.mkdirSync(path.join(home, 'surfcore', 'bili'), { recursive: true });
fs.writeFileSync(path.join(home, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'test', bili_jct: 'test', buvid3: 'test' }));
fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '123456789' }, share: { minScore: 11 }, preferences: { like: ctx.like, dislike: ctx.dislike, weights: ctx.prefWeights } }));
const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfgFile, SURFCORE_SCORE_OFFLINE: '1' };
const tools = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools');
const cli = (...a) => spawnSync(process.execPath, [path.join(tools, 'bili.mjs'), ...a], { env, encoding: 'utf8', timeout: 20000 });
const state = (name) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { biliState } from './tools/lib/state-paths.mjs'; process.stdout.write(biliState(${JSON.stringify(name)}))`], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) }).stdout;

ok('老写法（她自己报总分）→ 拒，带 code 和新写法提示', () => {
  const r = cli('score', 'BV1aaaaaaaa1', '--score', '16', '--reason', '很好看');
  assert.equal(r.status, 2); assert.match(r.stderr, /score\.old-form/); assert.match(r.stderr, /--fits/);
});
ok('缺好笑/上头 或 理由 → 拒', () => {
  assert.match(cli('score', 'BV1aaaaaaaa1', '--fits', '擦边', '--funny', '5', '--hooked', '2', '--reason', '还行吧行').stderr, /score\.bad-item/);
  assert.match(cli('score', 'BV1aaaaaaaa1', '--funny', '2', '--hooked', '2').stderr, /score\.no-reason/);
});
ok('新写法：代码算总分，分项存进 scores.json；不认识的类别提示没算', () => {
  const r = cli('score', 'BV1aaaaaaaa1', '--fits', '擦边,神作', '--funny', '3', '--hooked', '3', '--reason', '擦边但做得挺上头', '--title', '某擦边视频');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /「神作」不在/); assert.match(r.stdout, /分项：口味 7/);
  const sc = JSON.parse(fs.readFileSync(state('scores.json'), 'utf8'));
  const row = Object.values(sc).flat().find((x) => x.bv === 'BV1aaaaaaaa1');
  assert.ok(row.items && row.items.taste === 7); assert.deepEqual(row.fits, ['擦边']); assert.ok(row.score >= 11);
});
ok('分享不信传进来的分：share-dynamic 没评分 → share.unscored', () => {
  const r = spawnSync(process.execPath, [path.join(tools, 'bili.mjs'), 'share-dynamic', '--bvid', 'BV1zzzzzzzz1', '--text', '给大家推一条', '--reason', '很好笑很好笑', '--score', '20', '--dry'], { env, encoding: 'utf8', timeout: 20000 });
  assert.match(r.stderr + r.stdout, /share\.unscored|没评分/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`score rubric: ${passed} passed`);
