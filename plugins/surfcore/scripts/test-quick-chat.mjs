// 快捷对话：发送 / 识别 / 截图附件 / 联动抑制 / 进程管理（假 fetch、假 spawn，不起真进程）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuickChat, normalizeQuickChatConfig } from '../lib/quick-chat.js';
import { createDshPetBridge } from '../lib/dsh-pet-bridge.js';

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-home-'));
fs.mkdirSync(path.join(dshHome, 'electron'), { recursive: true });
fs.writeFileSync(path.join(dshHome, 'electron', 'electron.exe'), 'x');

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const out = await handler(String(url), body);
    return { status: 200, json: async () => out };
  };
  return { impl, calls };
}

function make({ handler, frame = { ok: true, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', title: '三角洲行动' }, chatResult, config = {}, bridgeOn = true } = {}) {
  const f = fakeFetch(handler || (async () => ({ ok: true, text: '嗯' })));
  const suppressed = [];
  const notes = [];
  const qc = createQuickChat({
    chat: { chat: async () => chatResult || { ok: true, reply: { text: '在呢', id: 'm1' } }, emit: () => {} },
    screenSource: { capture: async () => frame },
    readConfig: () => config,
    readScreenWatch: () => ({ ignoreApps: ['微信', 'Weixin'] }),
    bridge: { suppressScreenFor: (t) => suppressed.push(t) },
    bridgeEnabled: () => bridgeOn,
    currentDshUrl: () => 'http://127.0.0.1:1234/',
    dshHome,
    stateDir,
    notify: (t) => notes.push(t),
    fetchImpl: f.impl,
  });
  return { qc, calls: f.calls, suppressed, notes };
}

console.log('quick-chat');

await check('默认快捷键可配置', () => {
  assert.equal(normalizeQuickChatConfig({}).chatHotkey, 'Alt+N');
  assert.equal(normalizeQuickChatConfig({ chatHotkey: ' F9 ', micHotkey: 'F10' }).chatHotkey, 'F9');
  assert.equal(normalizeQuickChatConfig({ micHotkey: '' }).micHotkey, 'T');
});

await check('空消息：code + hint', async () => {
  const { qc } = make();
  const r = await qc.send({ text: '  ' });
  assert.equal(r.ok, false); assert.equal(r.code, 'quickchat.empty'); assert.ok(r.hint);
});

await check('文字 → dsh-pet /chat，不附图时不抑制看屏幕判断', async () => {
  const { qc, calls, suppressed } = make();
  const r = await qc.send({ text: '这是哪' });
  assert.equal(r.ok, true); assert.equal(r.via, 'dsh-pet'); assert.equal(r.reply, '嗯');
  assert.match(calls[0].url, /\/dsh-pet-7340\/chat\?pet=main/);
  assert.equal(calls[0].body.attachment, undefined);
  assert.deepEqual(suppressed, []);
});

await check('附截图 → 带 attachment，并抑制这一句的后台判断', async () => {
  const { qc, calls, suppressed } = make();
  const r = await qc.send({ text: '这是哪', withScreen: true });
  assert.equal(r.ok, true);
  assert.equal(calls[0].body.attachment.mediaType, 'image/png');
  assert.equal(calls[0].body.attachment.data, Buffer.from([1, 2, 3]).toString('base64'));
  assert.deepEqual(suppressed, ['这是哪']);
});

await check('隐私窗口不附图（也不抑制）', async () => {
  const { qc, calls, suppressed } = make({ frame: { ok: true, bytes: new Uint8Array([1]), mediaType: 'image/png', title: 'Weixin' } });
  const r = await qc.send({ text: '看下', withScreen: true });
  assert.equal(calls[0].body.attachment, undefined); assert.match(r.note, /隐私/); assert.deepEqual(suppressed, []);
});

await check('截图过大（游戏画面）：不发给 dsh-pet，改走看屏幕回答，只回一句', async () => {
  const f = fakeFetch(async () => ({ ok: true, text: '不该走到这' }));
  const looks = [];
  const remembered = [];
  const qc = createQuickChat({
    chat: { chat: async () => ({ ok: false }), rememberTurn: (t) => remembered.push(t) },
    screenSource: { capture: async () => ({ ok: true, bytes: new Uint8Array(700000), mediaType: 'image/png', title: '三角洲行动' }) },
    screenWatch: { lookOnce: async (o) => { looks.push(o); return { ok: true, said: '就剩你一个了 快撤' }; } },
    readConfig: () => ({}), bridgeEnabled: () => true, currentDshUrl: () => 'http://x', dshHome, stateDir, fetchImpl: f.impl,
  });
  const r = await qc.send({ text: '啥都没了', withScreen: true });
  assert.equal(r.ok, true); assert.equal(r.via, 'screen-watch'); assert.equal(r.reply, '就剩你一个了 快撤');
  assert.equal(f.calls.length, 0);
  assert.equal(looks[0].question, '啥都没了'); assert.equal(looks[0].force, true);
  assert.equal(remembered[0].userText, '啥都没了');
});

await check('截图过大且没有看屏幕服务：照发文字并说明', async () => {
  const { qc, calls } = make({ frame: { ok: true, bytes: new Uint8Array(700000), mediaType: 'image/png', title: 'x' } });
  const r = await qc.send({ text: '看下', withScreen: true });
  assert.equal(calls[0].body.attachment, undefined); assert.match(r.note, /太大/);
});

await check('截图失败：照样发文字，带说明', async () => {
  const { qc, calls } = make({ frame: { ok: false, code: 'screen.x', error: '截不到' } });
  const r = await qc.send({ text: '看下', withScreen: true });
  assert.equal(r.ok, true); assert.equal(calls.length, 1); assert.match(r.note, /截不到/);
});

await check('dsh-pet 拒绝 → 退回 surfpet', async () => {
  const { qc } = make({ handler: async () => ({ ok: false, reason: 'bad-request', message: 'x' }) });
  const r = await qc.send({ text: '在吗' });
  assert.equal(r.ok, true); assert.equal(r.via, 'surfpet'); assert.equal(r.reply, '在呢');
});

await check('都失败：code + hint', async () => {
  const { qc } = make({ bridgeOn: false, chatResult: { ok: false, error: '模型挂了' } });
  const r = await qc.send({ text: '在吗' });
  assert.equal(r.ok, false); assert.equal(r.code, 'quickchat.chat-failed'); assert.ok(r.hint);
});

await check('语音：配置的识别器不支持就换下一个', async () => {
  const { qc, calls } = make({ handler: async (_u, b) => (b.provider === 'deepseek' ? { ok: false, reason: 'unsupported' } : { ok: true, text: '这是哪' }) });
  const r = await qc.hear({ audio: 'AAAA' });
  assert.equal(r.ok, true); assert.equal(r.text, '这是哪'); assert.equal(r.provider, 'dsh');
  assert.deepEqual(calls.map((c) => c.body.provider), ['deepseek', 'dsh']);
});

await check('语音：全不支持 → stt-unavailable + hint', async () => {
  const { qc } = make({ handler: async () => ({ ok: false, reason: 'unsupported', message: 'no stt' }) });
  const r = await qc.hear({ audio: 'AAAA' });
  assert.equal(r.code, 'quickchat.stt-unavailable'); assert.ok(r.hint);
});

await check('语音：没录到 → no-audio + hint', async () => {
  const { qc } = make();
  const r = await qc.hear({});
  assert.equal(r.code, 'quickchat.no-audio'); assert.ok(r.hint);
});

await check('联动：被抑制的那句跳过看屏幕判断，只生效一次', async () => {
  let asked = 0;
  const bridge = createDshPetBridge({
    ctx: {}, chat: { systemPromptForFrontend: () => 'BASE' },
    readConfig: () => ({ enabled: true }), currentDshUrl: () => '', dshPetUserRoot: stateDir,
    onUserMessage: () => { asked += 1; return Promise.resolve(false); },
    extraSystem: () => '',
  });
  bridge.suppressScreenFor('这是哪');
  await bridge.recall({ petId: 'main', system: '', userText: '这是哪' });
  assert.equal(asked, 0);
  await bridge.recall({ petId: 'main', system: '', userText: '这是哪' });
  assert.equal(asked, 1);
});

await check('进程：按配置的快捷键启动；快捷键冲突 → 气泡提示；改快捷键会重启', async () => {
  const spawned = [];
  const notes = [];
  let config = { chatHotkey: 'F9', micHotkey: 'F10' };
  const spawnImpl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.stdout = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => child.emit('exit', 0);
    spawned.push({ exe, args, env: opts.env, child });
    return child;
  };
  const qc = createQuickChat({
    chat: {}, screenSource: {}, readConfig: () => config, currentDshUrl: () => '', dshHome, stateDir,
    notify: (t) => notes.push(t), spawnImpl,
  });
  const prev = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  qc.start();
  if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = prev;
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.SURFCORE_CHAT_KEY, 'F9');
  assert.equal(spawned[0].env.ELECTRON_RUN_AS_NODE, undefined);
  spawned[0].child.stdout.emit('data', `${JSON.stringify({ event: 'ready', keys: { chat: { key: 'F9', ok: false }, mic: { key: 'F10', ok: true } } })}\n`);
  assert.match(notes[0], /F9/);
  assert.match(qc.status().lastError, /F9/);
  spawned[0].child.stdout.emit('data', JSON.stringify({ event: 'ready', keys: { chat: { key: 'F9', ok: true }, mic: { key: 'T', ok: false, error: '缺少 uiohook-napi' } } }) + '\n');
  assert.match(notes[1], /语音键 T 用不了：缺少 uiohook-napi/);
  assert.match(qc.status().lastError, /语音键 T/);
  config = { chatHotkey: 'F8', micHotkey: 'F10' };
  qc.stop(); qc.start();
  assert.equal(spawned.at(-1).env.SURFCORE_CHAT_KEY, 'F8');
  qc.stop();
});

console.log(`quick-chat: ${passed} passed`);
