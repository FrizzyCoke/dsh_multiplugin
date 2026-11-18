// 生物钟排程回归（2026-11-18）：
//   ① whale-night.mjs 把窗口换算成分钟再交给 buildNightSchedule；以前 parseClock 只认 "HH:MM"，
//      分钟窗口全被判非法 → 永远退回 20:00–24:00×1（用户设的全天 12 次从没生效）。
//   ② 每个窗口自己的作息性格：skipChance / maxVideos / quietSkip（白天狂刷、夜里睡觉偶尔醒）。
//   ③ 设置页保存（store.normalizeBiliWindowList）不能把这些字段丢掉。
import assert from 'node:assert/strict';
import { buildNightSchedule, windowExtras } from '../tools/lib/night-schedule.mjs';
import { normalizeBiliWindowList } from '../lib/store.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

ok('分钟窗口 00:00–24:00 ×12 → 12 趟，不退回 20:00–24:00', () => {
  const r = buildNightSchedule({ windows: [{ start: 0, end: 1440, wrap: false, label: '00:00–24:00', wakes: 12 }], maxWakes: 12, nowMin: 5, skipChance: 0 });
  assert.equal(r.slots.length, 12);
  assert.ok(r.slots.every((s) => s.window === '00:00–24:00'));
  assert.deepEqual(r.warnings, []);
});

ok('跨午夜分钟窗口、"HH:MM" 窗口照常', () => {
  assert.equal(buildNightSchedule({ windows: [{ start: 1320, end: 1800, wrap: true, label: '22:00–06:00', wakes: 3 }], maxWakes: 12, nowMin: 5, skipChance: 0 }).slots.length, 3);
  assert.equal(buildNightSchedule({ windows: [{ start: '20:00', end: '24:00', wakes: 2 }], maxWakes: 12, nowMin: 5, skipChance: 0 }).slots.length, 2);
});

const human = [
  { start: '07:30', end: '12:00', wakes: 4, skipChance: 0, maxVideos: 12 },
  { start: '00:00', end: '07:30', wakes: 2, skipChance: 0.65, maxVideos: 4, quietSkip: true },
];

ok('每个窗口用自己的不看概率（固定随机数 0.5：白天 0% → 醒，夜里 65% → 不看）', () => {
  const r = buildNightSchedule({ windows: human, maxWakes: 12, nowMin: 0, skipChance: 0, random: () => 0.5 });
  const night = r.slots.filter((s) => s.window === '00:00–07:30');
  const day = r.slots.filter((s) => s.window === '07:30–12:00');
  assert.equal(night.length, 2); assert.equal(day.length, 4);
  assert.ok(night.every((s) => s.action === 'skip' && s.quietSkip === true && s.maxVideos === 4 && s.skipChance === 0.65));
  assert.ok(day.every((s) => s.action === 'wake' && s.maxVideos === 12 && !s.quietSkip));
});

ok('不看概率 10/20/10/70：模拟 4000 天，每个窗口实际不看比例落在 ±3% 内', () => {
  const wins = [
    { start: '07:30', end: '12:00', wakes: 4, skipChance: 0.1 },
    { start: '12:00', end: '19:00', wakes: 3, skipChance: 0.2 },
    { start: '19:00', end: '24:00', wakes: 3, skipChance: 0.1 },
    { start: '00:00', end: '07:30', wakes: 2, skipChance: 0.7, quietSkip: true },
  ];
  const tally = new Map();
  for (let d = 0; d < 4000; d += 1) {
    for (const s of buildNightSchedule({ windows: wins, maxWakes: 12, nowMin: 0, skipChance: 0 }).slots) {
      const t = tally.get(s.window) ?? { n: 0, skip: 0 };
      t.n += 1; if (s.action === 'skip') t.skip += 1;
      tally.set(s.window, t);
    }
  }
  const expect = { '07:30–12:00': 0.1, '12:00–19:00': 0.2, '19:00–24:00': 0.1, '00:00–07:30': 0.7 };
  for (const [label, p] of Object.entries(expect)) {
    const t = tally.get(label);
    assert.ok(t && t.n > 0, `${label} 有排到`);
    const rate = t.skip / t.n;
    assert.ok(Math.abs(rate - p) < 0.03, `${label} 不看比例 ${(rate * 100).toFixed(1)}% ≈ ${p * 100}%`);
  }
});

ok('没写的窗口用全局不看概率', () => {
  const r = buildNightSchedule({ windows: [{ start: '08:00', end: '12:00', wakes: 2 }], maxWakes: 12, nowMin: 0, skipChance: 1, random: () => 0.5 });
  assert.ok(r.slots.every((s) => s.action === 'skip' && s.maxVideos === undefined));
});

ok('windowExtras：夹范围、空值不写', () => {
  assert.deepEqual(windowExtras({ skipChance: 3, maxVideos: 99, quietSkip: true }), { skipChance: 1, maxVideos: 30, quietSkip: true });
  assert.deepEqual(windowExtras({ skipChance: '', maxVideos: null, quietSkip: 'yes' }), {});
});

ok('设置页保存：作息性格字段原样保留', () => {
  const { windows } = normalizeBiliWindowList(human);
  assert.deepEqual(windows[0], { start: '07:30', end: '12:00', wakes: 4, skipChance: 0, maxVideos: 12 });
  assert.deepEqual(windows[1], { start: '00:00', end: '07:30', wakes: 2, skipChance: 0.65, maxVideos: 4, quietSkip: true });
});

// ⑤ 精力 / 心情
{
  const { energyAt, moodOf, tiredSkipChance, tiredVideos, applyEnergyToSlot, seededRandom } = await import('../tools/lib/night-schedule.mjs');
  const fired = (at, videos) => ({ id: `f${at}`, status: 'fired', action: 'wake', at, doneAt: at, maxVideos: videos });
  ok('精力：只扣真刷过的趟，两趟之间按小时回', () => {
    assert.equal(energyAt([], 600), 100);
    // 08:00 刷 12 条（-18）→ 82；到 09:00 回 10 → 92
    assert.equal(energyAt([fired(480, 12)], 540, { costPerVideo: 1.5 }), 92);
    // 轻醒/睡着不扣
    assert.equal(energyAt([{ status: 'skipped', action: 'skip', at: 480 }], 540), 100);
    // 连着狂刷：累
    const binge = [fired(480, 30), fired(500, 30), fired(520, 30)];
    assert.ok(energyAt(binge, 530, { costPerVideo: 1.5 }) < 25);
  });
  ok('心情分档 + 累了更容易不刷、刷得少', () => {
    assert.deepEqual([moodOf(90), moodOf(60), moodOf(30), moodOf(10)], ['来劲', '正常', '有点累', '累瘫']);
    assert.equal(tiredSkipChance(80, 0.5), 0);
    assert.ok(tiredSkipChance(0, 0.5) === 0.5 && tiredSkipChance(30, 0.5) > 0);
    assert.equal(tiredVideos(12, 80), 12);
    assert.ok(tiredVideos(12, 10) < 12 && tiredVideos(12, 0) >= 3);
  });
  ok('累了的那趟：只定一次（重算计划结果不变），不刷时安静（不私信）', () => {
    const base = () => ({ slots: [fired(480, 30), fired(500, 30), fired(520, 30), { id: 's9', status: 'pending', action: 'wake', at: 540, maxVideos: 12 }] });
    // 找一个会掷到「累了不刷」的日期，再验证重复调用不变
    let date = '';
    for (let i = 0; i < 200 && !date; i += 1) {
      const s = base(); applyEnergyToSlot(s, s.slots[3], { date: `d${i}`, nowMin: 540 });
      if (s.slots[3].tired) date = `d${i}`;
    }
    assert.ok(date, '有日期能掷到累了');
    const s = base();
    const slot = applyEnergyToSlot(s, s.slots[3], { date, nowMin: 540 });
    assert.equal(slot.action, 'skip'); assert.equal(slot.quietSkip, true); assert.ok(slot.energy < 25);
    const again = applyEnergyToSlot(s, slot, { date, nowMin: 600 });
    assert.equal(again.action, 'skip'); assert.equal(again.energy, slot.energy);
    assert.equal(seededRandom('x|1'), seededRandom('x|1'));
  });
  ok('精神好时不改那一趟；精力关掉只记录不改', () => {
    const s = { slots: [{ id: 'a', status: 'pending', action: 'wake', at: 540, maxVideos: 12 }] };
    applyEnergyToSlot(s, s.slots[0], { date: 'x', nowMin: 540 });
    assert.equal(s.slots[0].action, 'wake'); assert.equal(s.slots[0].maxVideos, 12); assert.equal(s.slots[0].mood, '来劲');
    const t = { slots: [fired(480, 60), fired(490, 60), { id: 'b', status: 'pending', action: 'wake', at: 500, maxVideos: 12 }] };
    applyEnergyToSlot(t, t.slots[2], { date: 'x', nowMin: 500, energy: { enabled: false } });
    assert.equal(t.slots[2].action, 'wake'); assert.equal(t.slots[2].maxVideos, 12);
  });
}

// ⑥ 周末作息：设置页保存不丢、窗口照样校验；精力配置收敛
{
  const { normalizeBiliConfig } = await import('../lib/store.js');
  ok('周末作息：保存后还在（含每窗性格），坏窗口被丢、没写窗口时复制平时的', () => {
    const cfg = normalizeBiliConfig({ night: { windows: [{ start: '08:00', end: '12:00', wakes: 2 }], weekend: { enabled: true, windows: [{ start: '10:00', end: '14:00', wakes: 3, skipChance: 0.1, maxVideos: 12 }, { start: 'xx', end: '1', wakes: 1 }] } } });
    assert.equal(cfg.night.weekend.enabled, true);
    assert.deepEqual(cfg.night.weekend.windows, [{ start: '10:00', end: '14:00', wakes: 3, skipChance: 0.1, maxVideos: 12 }]);
    const cfg2 = normalizeBiliConfig({ night: { windows: [{ start: '08:00', end: '12:00', wakes: 2 }], weekend: { enabled: false } } });
    assert.deepEqual(cfg2.night.weekend.windows, [{ start: '08:00', end: '12:00', wakes: 2 }]);
    assert.equal(normalizeBiliConfig({ night: {} }).night.weekend, undefined);
  });
  ok('精力配置收敛到范围内', () => {
    const cfg = normalizeBiliConfig({ night: { energy: { strength: 9, costPerVideo: -1 } } });
    assert.equal(cfg.night.energy.strength, 1); assert.equal(cfg.night.energy.costPerVideo, 0); assert.equal(cfg.night.energy.enabled, true);
  });
}

// ④ 闲聊私信硬上限（dm --chat）：在任何网络请求之前拦，失败带 code。用临时 DSH_HOME，不碰真账号。
{
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-chat-'));
  const cfgFile = path.join(home, 'surfcore', 'bili.config.json');
  fs.mkdirSync(path.join(home, 'surfcore', 'bili'), { recursive: true });
  // 假凭据（不是真 token）：dm.mjs 启动就读这个文件；闸门在任何网络请求之前拦，所以永远用不上。
  fs.writeFileSync(path.join(home, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({ SESSDATA: 'test', bili_jct: 'test', DedeUserID: '1' }));
  const dmScript = new URL('../tools/commands/dm.mjs', import.meta.url);
  const run = (share, args, quota, limits) => {
    fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '123456789', name: 'x' }, share, ...(limits ? { limits } : {}) }));
    const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfgFile };
    if (quota) {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "import { biliState } from './tools/lib/state-paths.mjs'; process.stdout.write(biliState('dm-quota.json'))"], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) });
      fs.mkdirSync(path.dirname(probe.stdout), { recursive: true });
      fs.writeFileSync(probe.stdout, JSON.stringify(quota));
    }
    return spawnSync(process.execPath, [dmScript.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { env, encoding: 'utf8', timeout: 20000 });
  };
  ok('dm --chat：chatDaily=0 → dm.chat-disabled', () => {
    const r = run({ chatDaily: 0 }, ['--msg', '在吗', '--chat', '--dry']);
    assert.equal(r.status, 4); assert.match(r.stderr, /dm\.chat-disabled/);
  });
  ok('dm --chat：今天用满 → dm.chat-cap', () => {
    const today = new Date().toLocaleDateString('sv-SE');
    const r = run({ chatDaily: 2 }, ['--msg', '在吗', '--chat', '--dry'], { chatDate: today, chatCount: 2 });
    assert.equal(r.status, 4); assert.match(r.stderr, /dm\.chat-cap.*2\/2/);
  });
  ok('私信主人总上限（默认 10）：今天已 10 条 → dm.owner-cap（闲聊、分享、报备都拦）', () => {
    const today = new Date().toLocaleDateString('sv-SE');
    for (const args of [['--msg', '报备'], ['--msg', '在吗', '--chat'], ['--msg', '看这个', '--share', '--target', 'BV1xx']]) {
      const r = run({ chatDaily: 6 }, [...args, '--dry'], { date: today, count: 10, chatDate: today, chatCount: 0 });
      assert.equal(r.status, 4, args.join(' ')); assert.match(r.stderr, /dm\.owner-cap.*10\/10/);
    }
  });
  ok('私信主人总上限可调：limits.ownerDmDaily=3 时第 4 条被拦', () => {
    const today = new Date().toLocaleDateString('sv-SE');
    const r = run({}, ['--msg', 'x', '--dry'], { date: today, count: 3 }, { ownerDmDaily: 3 });
    assert.equal(r.status, 4); assert.match(r.stderr, /dm\.owner-cap.*3\/3/);
  });
  ok('回主人的私信（--reply）不占上限；但主人 30 分钟内没发过就拒（防伪装）', () => {
    const today = new Date().toLocaleDateString('sv-SE');
    const lastFile = () => {
      const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfgFile };
      return spawnSync(process.execPath, ['--input-type=module', '-e', "import { biliState } from './tools/lib/state-paths.mjs'; process.stdout.write(biliState('owner-last-dm.json'))"], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) }).stdout;
    };
    fs.rmSync(lastFile(), { force: true });
    const noRecent = run({ chatDaily: 6 }, ['--msg', '在', '--reply', '--dry'], { date: today, count: 10 });
    assert.equal(noRecent.status, 4); assert.match(noRecent.stderr, /dm\.reply-no-recent/);
    fs.writeFileSync(lastFile(), JSON.stringify({ at: new Date().toISOString() }));
    const replied = run({ chatDaily: 6 }, ['--msg', '在', '--reply', '--dry'], { date: today, count: 10 });
    assert.doesNotMatch(replied.stderr, /dm\.owner-cap|dm\.reply-no-recent/, '回复不被上限拦（之后的网络步骤在测试里会失败，没关系）');
    const proactive = run({ chatDaily: 6 }, ['--msg', '在', '--dry'], { date: today, count: 10 });
    assert.match(proactive.stderr, /dm\.owner-cap/, '同一时间主动找他照样被拦');
    const mixed = run({ chatDaily: 6 }, ['--msg', '在', '--reply', '--chat', '--dry'], {});
    assert.equal(mixed.status, 2); assert.match(mixed.stderr, /dm\.reply-mixed/);
  });
  ok('dm --chat --share 同时用 → dm.chat-and-share', () => {
    const r = run({ chatDaily: 3 }, ['--msg', '在吗', '--chat', '--share', '--dry']);
    assert.equal(r.status, 2); assert.match(r.stderr, /dm\.chat-and-share/);
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`night schedule: ${passed} passed`);
