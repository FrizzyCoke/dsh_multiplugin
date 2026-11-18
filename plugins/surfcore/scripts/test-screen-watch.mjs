// screen-watch 集成测试：真 pet-chat + 真 screen-watch，假 DSH llm/attachments，假截图源，隔离 DSH_HOME。
// 假模型「扮演」决定：带工具时遇到「这是哪/看看我屏幕」就调用 look_at_screen，其余不调。
// 测的是机制（工具交给模型 → 模型调用 → 截图交回 → 作答；节奏由模型 nextLookSec 决定），不是关键词规则。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-screen-test-'));
process.env.DSH_HOME = home;
const S = path.join(home, 'surfcore');
const charId = 'char-screentest';
const charDir = path.join(S, 'characters', charId);
fs.mkdirSync(path.join(charDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(S, 'characters', 'current.json'), JSON.stringify({ version: 1, id: charId, name: '知更鸟', epoch: 1, dir: charDir }));
fs.writeFileSync(path.join(S, 'characters', 'index.json'), JSON.stringify({ version: 1, currentId: charId, epoch: 1, characters: [{ version: 1, id: charId, name: '知更鸟', persona: 'persona.md', memory: 'memory', bili: 'bili' }] }));
fs.writeFileSync(path.join(charDir, 'persona.full.md'), '# 角色卡：兄弟\n标记BRO_PERSONA 哥们关系\n');
fs.writeFileSync(path.join(charDir, 'persona.md'), '# 角色卡：兄弟\n');
const cfgFile = path.join(S, 'config.json');
let watchCfg = { enabled: true, firstIntervalSec: 30, minIntervalSec: 15, maxIntervalSec: 600, maxCommentsPerHour: 2, commentCooldownSec: 0, skipIfChattedSec: 0, changeThreshold: 0.04 };
const writeCfg = () => fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, persona: { mode: 'full' }, admin: { displayName: '测试哥' }, screenWatch: watchCfg }));
writeCfg();

let fails = 0;
const check = (c, l, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); if (!c) fails += 1; };

// ── fake DSH services ──
const llmCalls = [];
let watcherReply = '{"note":"他在艾尔登法环里打拉达恩","say":"这boss马会跳 小心点","memory":{"title":"艾尔登法环·打拉达恩","text":"哥们第一次打到拉达恩","detail":"骑马boss，二阶段会砸流星","tags":["艾尔登法环","拉达恩"],"importance":75},"nextLookSec":20}';
let saved = [];
let attachmentsOn = true;
let toolsSupported = true;
// 只看「这一句」（pet-chat 把当前这句标成「（现在）：」，前面是历史），和真模型做决定时看的一样。
const userText = (opts) => {
  const all = (opts.messages?.[0]?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  const at = all.lastIndexOf('（现在）：');
  return at >= 0 ? all.slice(at) : all;
};
const ctx = {
  get(name) {
    if (name === 'llm') return {
      async *stream(opts) {
        llmCalls.push(opts);
        if (opts.tools && !toolsSupported) throw new Error('tools not supported by adapter');
        if (String(opts.system).includes('只回 yes 或 no')) {
          // 扮演「要不要看屏幕」的判断
          yield { type: 'text-delta', text: /在干嘛|这是哪/.test(userText(opts).split('他刚说：').pop()) ? 'yes' : 'no' };
        } else if (String(opts.system).includes('他刚在桌宠里问你')) {
          yield { type: 'text-delta', text: globalThis.__questionReply ?? '{"note":"他在调桌宠设置","say":"你在调我的看屏设置啊 😂","memory":null,"nextLookSec":60}' };
        } else if (String(opts.system).includes('只输出一个 JSON')) {
          yield { type: 'text-delta', text: watcherReply };
        } else if (opts.tools && !opts.messages.some((m) => m.role === 'tool') && /这是哪|看看我屏幕/.test(userText(opts))) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'look_at_screen', arguments: '{"reason":"他问这是哪"}' } };
        } else if (opts.messages.some((m) => m.role === 'tool')) {
          const toolMsg = opts.messages.find((m) => m.role === 'tool');
          const sawImage = toolMsg.content.some((p) => p.type === 'image');
          yield { type: 'text-delta', text: sawImage ? '这是王城罗德尔 你在打拉达恩 😂' : '没看 那是你聊天窗口' };
        } else {
          yield { type: 'text-delta', text: '咋了 累就歇会儿' };
        }
        yield { type: 'usage', usage: { input: 1000, output: 40 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'anthropic', model: 'claude-haiku-5-5' }) };
    if (name === 'attachments') return attachmentsOn ? { async saveImages(inputs) { saved.push(...inputs); return inputs.map((_, i) => ({ id: `ref${saved.length}-${i}` })); } } : undefined;
    return undefined;
  },
};

const T_A = '10'.repeat(576), T_B = 'f0'.repeat(576);
let nextFrame = { ok: true, bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mediaType: 'image/png', width: 1280, height: 720, title: 'ELDEN RING™', thumb: T_A };
let captures = 0;
const source = { async capture() { captures += 1; return { ...nextFrame }; }, async close() {} };

const { createPetChatService } = await import(`file:///${REPO}/plugins/surfcore/lib/pet-chat.js`);
const sw = await import(`file:///${REPO}/plugins/surfcore/lib/screen-watch.js`);
const logs = [];
const chat = createPetChatService({ ctx, stateDir: S, pluginLog: (...a) => logs.push(a.join(' ')) });
let clock = 1_800_000_000_000;
const watch = sw.createScreenWatch({ chat, source, readConfig: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).screenWatch, pluginLog: (...a) => logs.push(a.join(' ')), now: () => clock });
const bubbles = [];
chat.addFrontend({ id: 'probe', online: () => true, onProactive: (p) => bubbles.push(p.text) });
watch.start();
const inbox = path.join(charDir, 'memory', 'memory-inbox.jsonl');
const inboxRows = () => (fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── A. background look: same brain, image, comment, memory, model-chosen pace ──
let r = await watch.lookOnce();
const call = llmCalls.at(-1);
check(r.ok && !r.skipped, 'look: ran', JSON.stringify(r).slice(0, 80));
check(call.messages[0].content.some((p) => p.type === 'image' && p.attachment?.id) && saved.length === 1, 'look: image sent via DSH attachments');
check(String(call.system).includes('标记BRO_PERSONA') && String(call.system).includes('ELDEN RING'), 'look: same bro persona + window title');
check(call.reasoningEffort === 'low' && !call.tools, 'look: own effort, no tools in the watcher call');
check(bubbles.at(-1) === '这boss马会跳 小心点', 'look: comment delivered as pet bubble');
check(inboxRows().length === 1 && inboxRows()[0].platform === 'screen' && inboxRows()[0].importance === 75, 'look: notable moment → screen memory');
check(watch.status().paceSec === 20 && watch.status().nextLookAt === clock + 20_000, 'pace: model chose next look in 20s', `pace=${watch.status().paceSec}`);

// ── B. pacing is the model's call, clamped to config bounds ──
check(sw.paceSeconds(sw.normalizeScreenWatchConfig(watchCfg), 3, 30) === 15, 'pace clamp: 3s → floor 15s');
check(sw.paceSeconds(sw.normalizeScreenWatchConfig(watchCfg), 99999, 30) === 600, 'pace clamp: huge → ceiling 600s');
check(sw.paceSeconds(sw.normalizeScreenWatchConfig(watchCfg), null, 30) === 30, 'pace: model gave none → fallback');
let c0 = captures;
clock += 10_000; await watch.tick();
check(captures === c0, 'tick before her chosen time: no look');
clock += 11_000; nextFrame = { ...nextFrame, thumb: T_B };
watcherReply = '{"note":"在主菜单挂机","say":null,"memory":null,"nextLookSec":300}';
await watch.tick();
check(captures === c0 + 1 && watch.status().paceSec === 300, 'tick at her time: looks; idle scene → she slows to 300s');
clock += 120_000; await watch.tick();
check(captures === c0 + 1, 'she said 300s: no look at +120s');

// ── C. rails stay deterministic ──
clock = watch.status().nextLookAt + 1; const n1 = llmCalls.length;
await watch.tick();
check(watch.status().lastSkip === 'unchanged' && llmCalls.length === n1, 'rail: unchanged screen → no model call');
nextFrame = { ...nextFrame, title: '微信', thumb: T_A };
clock = watch.status().nextLookAt + 1;
await watch.tick();
check(watch.status().lastSkip === 'ignored-app' && llmCalls.length === n1, 'rail: 微信 in front → nothing sent');
watchCfg = { ...watchCfg, watchApps: ['ELDEN'] }; writeCfg();
nextFrame = { ...nextFrame, title: 'Visual Studio Code', thumb: T_B };
clock = watch.status().nextLookAt + 1;
await watch.tick();
check(watch.status().lastSkip === 'not-watched-app', 'rail: watchApps set → other windows skipped');
watchCfg = { ...watchCfg, watchApps: [] }; writeCfg();
check(sw.parseLookReply('```json\n{"note":"桌面","say":null,"memory":null}\n```').say === null && sw.parseLookReply('乱码').say === null, 'parser: null / garbage = silent');
check(chat.systemPromptForFrontend().includes('你最近亲眼看到的他的屏幕'), 'recent screen notes reach the chat prompt');

// ── D. chat: the MODEL decides whether to look (tool), not a keyword rule ──
nextFrame = { ...nextFrame, title: 'ELDEN RING™', thumb: T_A };
c0 = captures; let s0 = saved.length;
let reply = await chat.chat({ text: '你知道这是哪吗' });
const firstChatCall = llmCalls.find((o, i) => i >= llmCalls.length - 2 && o.tools);
check(firstChatCall?.tools?.some((t) => t.name === 'look_at_screen' && t.parameters), 'chat: look_at_screen offered to the model as a tool');
check(captures === c0 + 1 && saved.length === s0 + 1, 'chat: model called the tool → one fresh capture');
const followUp = llmCalls.at(-1);
const toolMsg = followUp.messages.find((m) => m.role === 'tool');
check(toolMsg?.toolCallId === 'call-1' && toolMsg.content.some((p) => p.type === 'image'), 'chat: screenshot returned as tool result (image block)');
check(followUp.messages.some((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'tool-call' && p.name === 'look_at_screen')), 'chat: assistant tool-call echoed back');
check(reply.ok && reply.reply?.text?.includes('王城'), 'chat: answers from what she saw', reply.reply?.text);
check(inboxRows().some((row) => row.platform === 'pet' && row.isSelf && row.text.includes('王城')), 'chat: Q&A saved to memory (continue later)');
c0 = captures;
reply = await chat.chat({ text: '今天好累' });
check(reply.ok && captures === c0, 'chat: model chose not to look → no capture');

// ── E. privacy rail on the tool + fallbacks ──
nextFrame = { ...nextFrame, title: '微信' };
s0 = saved.length;
reply = await chat.chat({ text: '你知道这是哪吗' });
check(saved.length === s0 && reply.reply?.text.includes('没看'), 'tool + 微信 in front: no screenshot sent; she says she did not look');
nextFrame = { ...nextFrame, title: 'ELDEN RING™' };
toolsSupported = false;
reply = await chat.chat({ text: '你知道这是哪吗' });
check(reply.ok && logs.some((l) => l.includes('带工具的调用失败')), 'tools unsupported → falls back to plain chat, still replies');
toolsSupported = true;
attachmentsOn = false;
reply = await chat.chat({ text: '你知道这是哪吗' });
check(reply.ok, 'attachments missing during tool → chat still answers (tool reports failure)');
nextFrame = { ...nextFrame, thumb: T_B }; clock += 700_000;
r = await watch.lookOnce();
check(r.ok === false && r.code === 'screen.no-attachments' && r.hint, 'watcher without attachments: coded error + hint');
attachmentsOn = true;

// ── E2. dsh-pet path: model decides whether to look, answers as a follow-up bubble ──
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
check(watch.dshPetHint().includes('等下我看一眼'), 'dsh-pet hint: tells her to say "等下我看一眼" instead of "看不到"');
nextFrame = { ...nextFrame, title: 'dsh-pet 设置', thumb: T_B };
c0 = captures; let bq = bubbles.length;
watch.onUserMessage('哈喽');
await sleep(2200);
check(captures === c0 && bubbles.length === bq, 'dsh-pet "哈喽": model said no → no look, no bubble');
watch.onUserMessage('看看我现在在干嘛');
await sleep(2600);
check(captures === c0 + 1, 'dsh-pet "看看我在干嘛": model said yes → fresh capture');
check(bubbles.at(-1) === '你在调我的看屏设置啊 😂', 'answer delivered as follow-up bubble', bubbles.at(-1));
const qCall = llmCalls.filter((o) => String(o.system).includes('他刚在桌宠里问你')).at(-1);
check(qCall && String(qCall.system).includes('看看我现在在干嘛'), 'the look carries his question');
check(inboxRows().some((row) => row.platform === 'pet' && row.isSelf && row.text.includes('看屏设置')), 'answer saved to surfcore memory (continue later)');
nextFrame = { ...nextFrame, title: 'Weixin' };
let sq = saved.length; bq = bubbles.length;
watch.onUserMessage('这是哪');
await sleep(2600);
check(saved.length === sq && bubbles.at(-1)?.includes('隐私'), 'question while Weixin in front: no screenshot sent, says so');
nextFrame = { ...nextFrame, title: 'ELDEN RING™' };

// ── F. failures back off; error shown once ──
watch._state.backoffUntil = 0; watch._state.failStreak = 0; watch._state.failCode = '';
const realCapture = source.capture;
let failCaptures = 0;
source.capture = async () => { failCaptures += 1; return { ok: false, code: 'screen.capture-failed', error: '截不到', hint: '换无边框窗口' }; };
const b0 = bubbles.length;
for (let i = 0; i < 3; i += 1) { clock = Math.max(clock, watch.status().nextLookAt) + 1; await watch.tick(); }
check(failCaptures === 3 && watch.status().backoffUntil > clock, 'after 3 failures: backoff');
const w1 = watch.status().backoffUntil - clock;
clock += 5_000; await watch.tick();
check(failCaptures === 3, 'inside backoff: no attempt (no retry storm)');
clock = Math.max(watch.status().backoffUntil, watch.status().nextLookAt) + 1; await watch.tick();
const w2 = watch.status().backoffUntil - clock;
check(failCaptures === 4 && w2 > w1, 'backoff grows', `${Math.round(w1 / 1000)}s → ${Math.round(w2 / 1000)}s`);
check(bubbles.slice(b0).filter((b) => b.includes('截不到')).length === 1, 'error bubble shown once');
source.capture = realCapture;
clock = Math.max(watch.status().backoffUntil, watch.status().nextLookAt) + 1;
watcherReply = '{"note":"恢复了","say":null,"memory":null,"nextLookSec":30}';
await watch.tick();
check(watch.status().failStreak === 0 && !watch.status().lastError, 'recovers: streak reset');

// ── F2. 他问了问题、模型回复被截断：她仍然要补一句，不能只剩「我瞅瞅」 ──
globalThis.__questionReply = '{"note":"他在打三角洲，画面';
nextFrame = { ...nextFrame, title: '三角洲行动', thumb: T_B };
const qr = await watch.lookOnce({ force: true, deliver: true, question: '啥都没了' });
check(qr.said === '没看清 你再说一遍' && bubbles.at(-1) === '没看清 你再说一遍', 'question + truncated reply → honest fallback, never silent', JSON.stringify(qr).slice(0, 100));
globalThis.__questionReply = '就剩你一个了 快撤';
const qr2 = await watch.lookOnce({ force: true, deliver: true, question: '啥都没了' });
check(qr2.said === '就剩你一个了 快撤', 'question + plain-text reply → use it as the answer');
delete globalThis.__questionReply;
// 他问了、她说了「我瞅瞅」，但截图失败：也要补一句「没看成…」，并交给 onAnswer 写回 dsh-pet 历史。
nextFrame = { ok: false, code: 'screen.capture-failed', error: '截不到', hint: '重试' };
const answered = [];
const need = await watch.onUserMessage('你看这是哪', { onAnswer: (a) => answered.push(a) });
await new Promise((resolve) => setTimeout(resolve, 2500));
check(need === true && /^没看成/.test(bubbles.at(-1) || '') && /^没看成/.test(answered[0] || ''), 'question + capture failed → honest "没看成" line, never silent', `${need} ${bubbles.at(-1)} ${answered[0]}`);
nextFrame = { ok: true, bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mediaType: 'image/png', width: 1280, height: 720, title: 'ELDEN RING™', thumb: T_A };

// ── G. switches ──
watchCfg = { ...watchCfg, enabled: false }; writeCfg();
c0 = captures; clock += 3_600_000; await watch.tick();
check(captures === c0, 'disabled: no looks');
c0 = captures; await chat.chat({ text: '你知道这是哪吗' });
check(captures === c0, 'disabled: tool not offered → no capture');
check(!chat.systemPromptForFrontend().includes('你最近亲眼看到的'), 'disabled: no screen notes in prompt');
const st = { lookTimes: [clock - 1, clock - 2], commentTimes: [], lastThumb: '' };
const capCfg = sw.normalizeScreenWatchConfig({ enabled: true, maxLooksPerHour: 2 });
check(sw.decideLook(capCfg, st, {}, clock).reason === 'look-cap' && sw.decideLook(capCfg, { ...st, lookTimes: [] }, { focus: true }, clock).reason === 'focus', 'gates: hourly cap, focus mode');

await watch.stop();
fs.rmSync(home, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
