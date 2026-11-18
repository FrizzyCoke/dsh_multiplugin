// 产生的文件统一封顶（lib/housekeeping.js）：临时目录，不碰真数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHousekeeping, defaultRules, pruneDir, trimDiary, trimLines } from '../lib/housekeeping.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-'));

console.log('housekeeping');
ok('日志：没超上限不动；超了只留最后 N 行（最新的那行在）', () => {
  const f = path.join(tmp, 'a.jsonl');
  fs.writeFileSync(f, Array.from({ length: 50 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
  assert.equal(trimLines(f, { maxKB: 100, keepLines: 10 }), 0);
  fs.writeFileSync(f, Array.from({ length: 5000 }, (_, i) => `{"i":${i},"pad":"${'x'.repeat(50)}"}`).join('\n') + '\n');
  assert.ok(trimLines(f, { maxKB: 64, keepLines: 100 }) > 0);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(lines.length, 100); assert.match(lines.at(-1), /"i":4999/);
});
ok('日记：超了把旧的挪进 .archive.md，她读的那本只留最近的（按段落切，最新一条在，旧的没丢）', () => {
  const f = path.join(tmp, 'whale-diary.md');
  const entries = Array.from({ length: 400 }, (_, i) => `## 第 ${i} 趟\n今天刷到了第 ${i} 个视频，${'很好笑。'.repeat(20)}\n`);
  fs.writeFileSync(f, entries.join('\n'));
  const r = trimDiary(f, { maxKB: 48, keepKB: 32, archiveMaxKB: 1024 });
  assert.ok(r.moved > 0);
  const keep = fs.readFileSync(f, 'utf8');
  assert.ok(Buffer.byteLength(keep) <= 34 * 1024, `留下 ${Buffer.byteLength(keep)} 字节`);
  assert.match(keep, /第 399 趟/); assert.match(keep, /更早的日记在 whale-diary\.archive\.md/);
  assert.match(keep.split('\n')[1], /^## 第 \d+ 趟/, '从段落开头切');
  const archive = fs.readFileSync(path.join(tmp, 'whale-diary.archive.md'), 'utf8');
  assert.match(archive, /第 0 趟/);
  assert.equal(trimDiary(f, { maxKB: 48, keepKB: 32, archiveMaxKB: 1024 }).moved, 0, '没超就不动');
});
ok('目录：只留最新 N 个；N 天内的也留；只动匹配的（手动快照不碰）', () => {
  const d = path.join(tmp, 'snapshots');
  const now = Date.now();
  for (let i = 0; i < 10; i += 1) {
    const p = path.join(d, `auto-2026-11-${String(i + 1).padStart(2, '0')}`);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'x'), 'x');
    const t = new Date(now - (10 - i) * 86_400_000);
    fs.utimesSync(p, t, t);
  }
  fs.mkdirSync(path.join(d, 'manual-keep'), { recursive: true });
  const old = new Date(now - 100 * 86_400_000); fs.utimesSync(path.join(d, 'manual-keep'), old, old);
  assert.equal(pruneDir(d, { match: /^auto-/, keepNewest: 7 }, now), 3);
  const left = fs.readdirSync(d).sort();
  assert.equal(left.filter((n) => n.startsWith('auto-')).length, 7); assert.ok(left.includes('manual-keep'));
  assert.equal(pruneDir(d, { match: /^auto-/, keepNewest: 2, keepDays: 30 }, now), 0, '30 天内的都留');
});
ok('整套：按规则表跑，失败的项带 code + hint，关掉就不跑', () => {
  const surf = path.join(tmp, 'surf'); const char = path.join(tmp, 'char');
  fs.mkdirSync(path.join(char, 'bili'), { recursive: true }); fs.mkdirSync(surf, { recursive: true });
  fs.writeFileSync(path.join(char, 'bili', 'dm-tick-err.log'), 'x'.repeat(300 * 1024).replace(/x{100}/g, (m) => `${m}\n`));
  const logs = [];
  const hk = createHousekeeping({ surfDir: surf, charDir: () => char, pluginLog: (...a) => logs.push(a.join(' ')) });
  const r = hk.run();
  assert.equal(r.ok, true); assert.ok(r.done.some((s) => /dm-tick-err/.test(s))); assert.ok(logs.length >= 1);
  assert.ok(fs.statSync(path.join(char, 'bili', 'dm-tick-err.log')).size < 256 * 1024);
  const bad = createHousekeeping({ surfDir: surf, charDir: () => char, rules: [{ kind: 'bogus', file: '{char}/bili/x' }] });
  const b = bad.run();
  assert.equal(b.ok, false); assert.equal(b.code, 'housekeeping.partial'); assert.ok(b.hint);
  assert.equal(createHousekeeping({ surfDir: surf, charDir: char, readConfig: () => ({ enabled: false }) }).run().skipped, 'disabled');
});
ok('规则表覆盖到所有会一直长的文件', () => {
  const targets = defaultRules().map((r) => r.file ?? r.dir).join(' ');
  for (const name of ['context-telemetry-plugin.jsonl', 'bridge-supervisor.log', 'dm-tick-err.log', 'whale-log.jsonl', 'watch-history.jsonl', 'commented-videos.md', 'memory-card-full.jsonl', 'whale-diary.md', 'whale-diary-private.md', 'snapshots', 'backups', 'pet/voice']) {
    assert.ok(targets.includes(name), `漏了 ${name}`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`housekeeping: ${passed} passed`);
