// 2026-11-18 体检：日志里的真错误别被淹 / 别看不出原因。
import assert from 'node:assert/strict';
import { formatListenError } from '../lib/scheduler.js';
import { createFailLogGate } from '../lib/vector-memory.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

ok('B站监听失败：fetch failed 带上真正原因（code + 主机）', () => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', host: 'api.bilibili.com' });
  const s = formatListenError(e);
  assert.match(s, /^［原因 ECONNRESET read ECONNRESET @api\.bilibili\.com］ TypeError: fetch failed/);
  assert.equal(formatListenError(new Error('plain')), 'plain', '没 cause 不加前缀');
});

ok('向量记忆：同一个失败只记一次；换错误再记；恢复说一声；正常时不记', () => {
  const gate = createFailLogGate();
  const fail = { ok: false, code: 'vector.service-missing', error: 'Embedding 服务发现文件不存在' };
  assert.match(gate(fail), /向量记忆整理失败：vector\.service-missing/);
  assert.equal(gate(fail), null);
  assert.equal(gate(fail), null);
  assert.match(gate({ ok: false, code: 'vector.other', error: 'x' }), /vector\.other/);
  assert.equal(gate({ ok: true }), '向量记忆恢复正常');
  assert.equal(gate({ ok: true }), null);
  assert.match(gate(fail), /service-missing/, '恢复后再坏要重新记');
});

console.log(`log noise: ${passed} passed`);
