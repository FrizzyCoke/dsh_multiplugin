// 截图自动清理（lib/attachment-gc.js）：假 DSH_HOME，不碰真附件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createAttachmentGc, sha256Hex } from '../lib/attachment-gc.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const DAY = 86_400_000;

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-'));
  const state = path.join(home, 'state');
  const put = (bytes) => {
    const h = sha256Hex(bytes);
    const dir = path.join(home, 'attachments', 'v1', 'objects', h.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, h), bytes);
    return h;
  };
  const exists = (h) => fs.existsSync(path.join(home, 'attachments', 'v1', 'objects', h.slice(0, 2), h));
  const session = (text, { zstd = true, broken = false } = {}) => {
    const dir = path.join(home, 'sessions', 'proj', `session-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), broken ? Buffer.from('not zstd') : zstd ? zlib.zstdCompressSync(Buffer.from(text)) : text);
  };
  return { home, state, put, exists, session };
}

console.log('attachment gc');
await ok('只清自己记过账的：超过 2 天删，没过期留着，别人的附件不碰', () => {
  const s = setup();
  let t = Date.now();
  const gc = createAttachmentGc({ dshHome: s.home, stateDir: s.state, now: () => t });
  const mine = Buffer.from('screenshot-old');
  const h1 = s.put(mine); gc.record(mine);
  const others = s.put(Buffer.from('user pasted image'));
  t += 1 * DAY;
  const fresh = Buffer.from('screenshot-new'); const h2 = s.put(fresh); gc.record(fresh);
  t += 1.5 * DAY;
  const r = gc.sweep();
  assert.equal(r.deleted, 1);
  assert.equal(s.exists(h1), false); assert.equal(s.exists(h2), true); assert.equal(s.exists(others), true);
});
await ok('超过总量上限：从最旧的删到上限以下', () => {
  const s = setup();
  let t = Date.now();
  const gc = createAttachmentGc({ dshHome: s.home, stateDir: s.state, now: () => t, readConfig: () => ({ maxMB: 1, maxAgeDays: 30 }) });
  const hs = [];
  for (let i = 0; i < 3; i += 1) { const b = Buffer.alloc(600 * 1024, i + 1); hs.push(s.put(b)); gc.record(b); t += 1000; }
  const r = gc.sweep();
  assert.equal(r.deleted, 2); assert.equal(s.exists(hs[0]), false); assert.equal(s.exists(hs[1]), false); assert.equal(s.exists(hs[2]), true);
});
await ok('还被会话 / 桌宠记录提到的：不删', () => {
  const s = setup();
  let t = Date.now();
  const gc = createAttachmentGc({ dshHome: s.home, stateDir: s.state, now: () => t });
  const b = Buffer.from('used in chat'); const h = s.put(b); gc.record(b);
  s.session(`{"attachment":{"attachmentId":"${h}"}}`);
  t += 10 * DAY;
  const r = gc.sweep();
  assert.equal(r.deleted, 0); assert.equal(r.keptReferenced, 1); assert.equal(s.exists(h), true);
});
await ok('会话日志读不了：这次一张都不删（宁可多留），带 code + hint', () => {
  const s = setup();
  let t = Date.now();
  const gc = createAttachmentGc({ dshHome: s.home, stateDir: s.state, now: () => t });
  const b = Buffer.from('old'); const h = s.put(b); gc.record(b);
  s.session('', { broken: true });
  t += 10 * DAY;
  const r = gc.sweep();
  assert.equal(r.ok, false); assert.equal(r.code, 'attachment-gc.sessions-unreadable'); assert.ok(r.hint);
  assert.equal(s.exists(h), true);
});
await ok('一次性收编旧截图：没被引用的记账、被引用的不记；关掉时不清', () => {
  const s = setup();
  const a = s.put(Buffer.from('old-a')); const b = s.put(Buffer.from('old-b'));
  s.session(`ref ${b}`);
  let t = Date.now() + 1000;
  const gc = createAttachmentGc({ dshHome: s.home, stateDir: s.state, now: () => t, readConfig: () => ({ enabled: false }) });
  const r = gc.adoptUnreferenced();
  assert.equal(r.adopted, 1); assert.equal(r.referenced, 1);
  t += 10 * DAY;
  assert.equal(gc.sweep().skipped, 'disabled'); assert.equal(s.exists(a), true);
  assert.equal(gc.sweep({ force: true }).deleted, 1); assert.equal(s.exists(a), false); assert.equal(s.exists(b), true);
});

await ok('用完即删：存前不存在的 → 记账 → 这次调用结束立刻删；本来就有的（别人的同一张）不删', () => {
  const s = setup();
  const gc = createAttachmentGc({ dshHome: s.home, stateDir: s.state });
  const theirs = Buffer.from('same bytes as a user image');
  const theirHash = s.put(theirs);
  assert.equal(gc.exists(theirs), true, '已存在 → pet-chat 不会记账');
  const shot = Buffer.from('fresh screenshot');
  assert.equal(gc.exists(shot), false);
  const h = s.put(shot); gc.record(shot);
  const r = gc.release([h, theirHash]);
  assert.equal(r.released, 1); assert.equal(s.exists(h), false); assert.equal(s.exists(theirHash), true);
  assert.equal(gc.status().tracked, 0);
});
await ok('pet-chat 接线：一次模型调用里存的截图（含工具返回的），调用结束全部交给 done；调用失败也交', async () => {
  const { createPetChatService } = await import('../lib/pet-chat.js');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const done = [];
  let fail = false;
  const ctx = { get(name) {
    if (name === 'attachments') return { saveImages: async (inputs) => inputs.map((_, i) => ({ attachmentId: `a${i}` })) };
    if (name === 'llm') return { async *stream() { if (fail) throw new Error('model down'); yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'anthropic', model: 'claude-haiku-5-5' }) };
    return undefined;
  } };
  let n = 0;
  const chat = createPetChatService({ ctx, stateDir: state, attachmentHooks: { exists: () => false, saved: () => `h${n += 1}`, done: (hs) => done.push(hs) } });
  await chat.complete({ system: 's', user: 'u', images: [{ data: Buffer.from('a'), mediaType: 'image/png' }, { data: Buffer.from('b'), mediaType: 'image/png' }] });
  assert.deepEqual(done[0], ['h1', 'h2']);
  fail = true;
  try { await chat.complete({ system: 's', user: 'u', images: [{ data: Buffer.from('c'), mediaType: 'image/png' }] }); } catch {}
  assert.deepEqual(done[1], ['h3'], '失败也删');
  fs.rmSync(state, { recursive: true, force: true });
});

console.log(`attachment gc: ${passed} passed`);
