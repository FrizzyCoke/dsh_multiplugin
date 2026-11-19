// 2026-11-18：今天有到线、没分享过的视频 → 提示里点名让她发（以前只写「考虑分享」，她从没发过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shareDueLines } from '../lib/scheduler.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

const now = new Date();
const day = now.toLocaleDateString('sv-SE');
const B = { share: { enabled: true, minScore: 12 } };
const scores = { [day]: [
  { bv: 'BV1aaaaaaaaa', score: 10, reason: '一般' },
  { bv: 'BV1bbbbbbbbb', score: 13, reason: '一句话反杀' },
  { bv: 'BV1ccccccccc', score: 12, reason: '画风很强' },
], '2000-01-01': [{ bv: 'BV1zzzzzzzzz', score: 20 }] };
const mk = (log) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-due-'));
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ log }));
  return dir;
};

ok('今天到线没发过 → 点名最高分那条', () => {
  const lines = shareDueLines(B, { dir: mk([]), scores, now });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /BV1bbbbbbbbb.*13 分.*门槛 12/);
  assert.match(lines[1], /就发给他/);
});

ok('最高那条 7 天内分享过 → 换下一条到线的；都分享过 → 不提示', () => {
  const one = mk([{ at: now.toISOString(), share: true, target: 'BV:BV1bbbbbbbbb' }]);
  assert.match(shareDueLines(B, { dir: one, scores, now })[0], /BV1ccccccccc/);
  const both = mk([{ at: now.toISOString(), share: true, target: 'BV:BV1bbbbbbbbb' }, { at: now.toISOString(), share: true, target: 'BV:BV1ccccccccc' }]);
  assert.deepEqual(shareDueLines(B, { dir: both, scores, now }), []);
});

ok('没到线 / 分享关了 / 只有旧日期的高分 → 不提示', () => {
  assert.deepEqual(shareDueLines({ share: { minScore: 14 } }, { dir: mk([]), scores, now }), []);
  assert.deepEqual(shareDueLines({ share: { enabled: false, minScore: 12 } }, { dir: mk([]), scores, now }), []);
  assert.deepEqual(shareDueLines(B, { dir: mk([]), scores: { '2000-01-01': scores['2000-01-01'] }, now }), []);
});

console.log(`share due: ${passed} passed`);
