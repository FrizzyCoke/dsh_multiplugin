/**
 * 看屏幕（screen-watch）：定期看一眼屏幕，碰到值得说的时刻主动搭一句；同时维护「最近看到的」，
 * 聊天时（surfpet / dsh-pet 都一样）自然知道他在干嘛。
 *
 * 大脑：和桌宠同一份 system prompt（chat.systemPromptForFrontend：人格卡 + 记忆卡 + 心事）。
 * 记忆：模型认为值得记的时刻 → appendMemoryInboxEvent(platform:'screen') → 插件维护器并入记忆卡。
 * 发言：chat.proactive(remember:false) → surfpet 气泡 + 额外显示端（dsh-pet）。
 *
 * 省钱的闸门按「最便宜的先挡」排：开关 → 专注模式 → 额度 → 正在聊天 → 每小时看图上限 →
 * 截图（本地，免费）→ 前台窗口过滤 → 画面没变化 → 才调模型 → 发言冷却/每小时上限。
 * 配置：合体层 config.json 的 `screenWatch`（默认关）。
 */
import { appendMemoryInboxEvent } from '../../../src/memory-card.js?rev=20261117-screen-memory';
import { activeMemoryPaths } from '../../../src/character-persona.js';
import { thumbDiff } from './screen-capture.js';

const HOUR = 60 * 60 * 1000;

const DEFAULT_IGNORE = ['微信', 'WeChat', 'Weixin', 'Telegram', 'WhatsApp', 'Signal', '1Password', 'Bitwarden', 'KeePass', '密码', 'Password', '银行', 'Bank', '支付宝', 'Alipay', '钉钉', 'Outlook', 'Gmail', 'Mail'];

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function list(value, fallback) {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : fallback;
}

export function normalizeScreenWatchConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true,
    // 多久看下一眼由模型自己定（nextLookSec）；这里只是上下限与第一眼。
    minIntervalSec: clampNum(c.minIntervalSec, 15, 5, 3600),
    maxIntervalSec: clampNum(c.maxIntervalSec, 600, 10, 86400),
    firstIntervalSec: clampNum(c.firstIntervalSec ?? c.intervalSec, 30, 5, 3600),
    changeThreshold: clampNum(c.changeThreshold, 0.04, 0, 1),
    watchApps: list(c.watchApps, []),
    ignoreApps: list(c.ignoreApps, DEFAULT_IGNORE),
    maxLooksPerHour: clampNum(c.maxLooksPerHour, 60, 1, 720),
    maxCommentsPerHour: clampNum(c.maxCommentsPerHour, 6, 0, 120),
    commentCooldownSec: clampNum(c.commentCooldownSec, 180, 0, 86400),
    skipIfChattedSec: clampNum(c.skipIfChattedSec, 20, 0, 3600),
    chattiness: ['quiet', 'normal', 'chatty'].includes(c.chattiness) ? c.chattiness : 'normal',
    onDemand: c.onDemand !== false,
    rememberNotable: c.rememberNotable !== false,
    minMemoryImportance: clampNum(c.minMemoryImportance, 55, 1, 100),
    notesInPrompt: clampNum(c.notesInPrompt, 5, 0, 20),
    noteMaxAgeMin: clampNum(c.noteMaxAgeMin, 30, 1, 1440),
    scale: clampNum(c.scale, 0.5, 0.2, 1),
    effort: ['off', 'low', 'high', 'max'].includes(c.effort) ? c.effort : 'low',
    windowsMcpExe: String(c.windowsMcpExe ?? ''),
  };
}

function titleMatches(title, keywords) {
  const t = String(title || '').toLowerCase();
  return keywords.some((k) => t.includes(String(k).toLowerCase()));
}

const recent = (times, now) => times.filter((t) => now - t < HOUR);

/** 模型给的下一眼间隔，夹在配置上下限里；没给就用 fallback。 */
export function paceSeconds(cfg, requested, fallback) {
  const lo = Math.min(cfg.minIntervalSec, cfg.maxIntervalSec);
  const hi = Math.max(cfg.minIntervalSec, cfg.maxIntervalSec);
  const n = Number(requested);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) && n > 0 ? n : fallback));
}

/** 截图前的闸门（纯函数）。 */
export function decideLook(cfg, state, env, now) {
  if (!cfg.enabled) return { look: false, reason: 'disabled' };
  if (env.focus) return { look: false, reason: 'focus' };
  if (env.budgetBlocked) return { look: false, reason: 'budget' };
  if (env.chatBusy) return { look: false, reason: 'chat-busy' };
  if (cfg.skipIfChattedSec && env.lastChatAt && now - env.lastChatAt < cfg.skipIfChattedSec * 1000) return { look: false, reason: 'just-chatted' };
  if (recent(state.lookTimes, now).length >= cfg.maxLooksPerHour) return { look: false, reason: 'look-cap' };
  return { look: true, reason: 'ok' };
}

/** 截图后、调模型前的闸门（纯函数）。 */
export function decideAfterCapture(cfg, state, frame) {
  if (cfg.watchApps.length && !titleMatches(frame.title, cfg.watchApps)) return { ask: false, reason: 'not-watched-app' };
  if (titleMatches(frame.title, cfg.ignoreApps)) return { ask: false, reason: 'ignored-app' };
  const diff = thumbDiff(state.lastThumb, frame.thumb);
  if (state.lastThumb && diff < cfg.changeThreshold) return { ask: false, reason: 'unchanged', diff };
  return { ask: true, reason: 'ok', diff };
}

/** 模型说了想说的话之后，能不能真的发出去（纯函数）。 */
export function decideSpeak(cfg, state, env, now) {
  if (cfg.maxCommentsPerHour <= 0) return { speak: false, reason: 'comments-off' };
  if (recent(state.commentTimes, now).length >= cfg.maxCommentsPerHour) return { speak: false, reason: 'comment-cap' };
  const last = Math.max(state.lastCommentAt || 0, env.lastProactiveAt || 0);
  if (last && now - last < cfg.commentCooldownSec * 1000) return { speak: false, reason: 'cooldown' };
  return { speak: true, reason: 'ok' };
}

/** 解析模型输出：容忍 ```json 包裹与前后废话；解析不了 = 沉默。 */
export function parseLookReply(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { note: '', say: null, memory: null, nextLookSec: null, parsed: false };
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return { note: '', say: null, memory: null, nextLookSec: null, parsed: false }; }
  const next = Number(obj?.nextLookSec);
  const note = String(obj?.note ?? '').trim().slice(0, 200);
  const sayRaw = typeof obj?.say === 'string' ? obj.say.trim() : '';
  const say = sayRaw && !/^(null|无|沉默|\.\.\.)$/i.test(sayRaw) ? sayRaw.slice(0, 120) : null;
  let memory = null;
  const m = obj?.memory;
  if (m && typeof m === 'object' && String(m.text ?? '').trim().length >= 4) {
    memory = {
      title: String(m.title ?? '').trim().slice(0, 80),
      text: String(m.text).trim().slice(0, 500),
      detail: String(m.detail ?? '').trim().slice(0, 500),
      tags: Array.isArray(m.tags) ? m.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
      importance: Number.isFinite(Number(m.importance)) ? Math.max(1, Math.min(100, Math.round(Number(m.importance)))) : 50,
    };
  }
  return { note, say, memory, nextLookSec: Number.isFinite(next) && next > 0 ? next : null, parsed: true };
}

const CHATTY = {
  quiet: '非常克制：只有真正精彩/离谱/关键的时刻（大胜、惨败、名场面、他明显卡关很久）才开口，大部分时候沉默。',
  normal: '有值得说的才说：精彩操作、翻车、新地图/新剧情、他在看的东西有意思，可以短短接一句；平常的画面就沉默。',
  chatty: '可以多说一点：看到有意思的就吐槽或捧场，但同一件事别说两次，别解说每个画面。',
};

export function buildLookInstruction(cfg, { title, notes, forced, question = '' }) {
  const lines = [
    '【你在干嘛】你刚瞄了一眼他的电脑屏幕（附图）。你就是上面人格卡里的那个人，像坐在旁边的兄弟一样看。',
    title ? `前台窗口：${title}` : '',
    notes.length ? `你之前几次看到的（旧→新）：\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
    question ? `他刚在桌宠里问你：「${String(question).slice(0, 200)}」。你刚跟他说了「等下我看一眼」，这张就是你为了回他现截的图。` : '',
    '',
    `开口规则：${CHATTY[cfg.chattiness]}`,
    '- 不要解说画面、不要逐条描述、不要客服腔；说就像真人随口一句（1~20字），可以带梗/脏话/emoji。',
    '- 只说你真看到的；看不清/不确定就不说，绝不编。',
    question ? '' : '- 和之前看到的差不多 → 沉默。',
    question
      ? '- say 必须给：直接回答他的问题（像接着刚才聊天，1~30字）；截图回答不了就照实说看不出来。'
      : (forced ? '- 这次是他让你看的，say 必须给一句。' : '- 沉默是正常的，大多数时候 say 应该是 null。'),
    '- 真正值得以后记住的时刻（第一次玩某游戏、通关/过大Boss、名场面、他特别激动的事）才给 memory，写具体：游戏名、地点/Boss、发生了什么。日常画面 memory 给 null。',
    `- 你自己决定多久后再看一眼（nextLookSec，${cfg.minIntervalSec}~${cfg.maxIntervalSec} 秒）：激烈对局/剧情关键/变化快 → 短；他在看文档、挂机、开会、桌面没动 → 长。`,
    '',
    '只输出一个 JSON，不要别的文字：',
    '{"note":"一句话：屏幕上是什么、他在干嘛（给你自己记的，客观）","say":null或"你要说的那句话","memory":null或{"title":"短标题","text":"发生了什么","detail":"补充细节","tags":["关键词"],"importance":1-100},"nextLookSec":秒数}',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

export function createScreenWatch({ chat, source, readConfig, focusEnabled = () => false, tokenBudget = null, pluginLog = () => {}, now = () => Date.now(), petPresent = () => true } = {}) {
  const state = {
    lookTimes: [],
    commentTimes: [],
    lastCommentAt: 0,
    lastThumb: '',
    notes: [],
    lastLookAt: 0,
    lastResult: null,
    lastError: null,
    lastSkip: '',
    running: false,
    lastAttemptAt: 0,
    failStreak: 0,
    failCode: '',
    backoffUntil: 0,
    noticed: new Set(),
    nextLookAt: 0,
    paceSec: 0,
    lastQuestion: null,
  };
  let timer = null;
  let removeContext = null;
  let removeTool = null;

  const cfg = () => {
    try { return normalizeScreenWatchConfig(readConfig()); } catch { return normalizeScreenWatchConfig({}); }
  };

  /** 失败：记状态、连续失败退避（防重试风暴/刷日志/反复拉起子进程），每种错误第一次弹一个气泡。 */
  function recordError(code, error, hint) {
    const t = now();
    state.lastError = { code, error, hint, at: t };
    state.failStreak = state.failCode === code ? state.failStreak + 1 : 1;
    state.failCode = code;
    if (state.failStreak === 1 || state.failStreak % 10 === 0) {
      pluginLog(`[screen-watch] ${code}：${error}${hint ? `（${hint}）` : ''}${state.failStreak > 1 ? ` ×${state.failStreak}` : ''}`);
    }
    if (state.failStreak >= 3) {
      const c = cfg();
      const delay = Math.min(30 * 60 * 1000, c.firstIntervalSec * 1000 * 2 ** Math.min(6, state.failStreak - 2));
      state.backoffUntil = t + delay;
    }
    if (!state.noticed.has(code)) {
      state.noticed.add(code);
      void Promise.resolve(chat.proactive?.({ text: `⚠️ 看屏幕出错了：${error}。${hint || ''}`.slice(0, 120), purpose: { kind: 'screen-error' }, remember: false })).catch(() => {});
    }
  }

  function recordSuccess() {
    state.failStreak = 0;
    state.failCode = '';
    state.backoffUntil = 0;
    state.lastError = null;
  }

  function freshNotes(c, t = now()) {
    return state.notes.filter((n) => t - n.at < c.noteMaxAgeMin * 60 * 1000);
  }

  function noteLines(c, limit) {
    const t = now();
    return freshNotes(c, t).slice(-limit).map((n) => {
      const sec = Math.max(1, Math.round((t - n.at) / 1000));
      return `${sec < 60 ? `${sec}秒` : `${Math.round(sec / 60)}分钟`}前：${n.text}`;
    });
  }

  async function budgetBlocked() {
    if (!tokenBudget?.block) return false;
    try { return Boolean((await tokenBudget.block('other'))?.blocked); } catch { return false; }
  }

  /** 看一眼。force=true：跳过开关/冷却类闸门（「看一下」按钮、按需）；deliver=false：只返回不发言。 */
  /**
   * 看一眼。force：跳过节奏/冷却类闸门；question：为了回答他的问题而看（必答、算对话、进记忆）；
   * manual：调试路由手动触发，才跳过隐私窗口过滤。
   */
  async function lookOnce({ force = false, deliver = true, question = '', manual = false } = {}) {
    const c = cfg();
    if (state.running) return { ok: false, code: 'screen.busy', error: '上一眼还没看完', hint: '稍等几秒再试' };
    const t0 = now();
    if (!force) {
      const activity = chat.lastActivity?.() ?? {};
      const gate = decideLook(c, state, {
        focus: focusEnabled(),
        budgetBlocked: await budgetBlocked(),
        chatBusy: activity.busy === true,
        lastChatAt: activity.lastChatAt || 0,
      }, t0);
      if (!gate.look) { state.lastSkip = gate.reason; return { ok: true, skipped: gate.reason }; }
    } else if (await budgetBlocked()) {
      return { ok: false, code: 'screen.budget', error: '今天的 token 额度（其他类）已用完', hint: '设置 → Token 额度 里调高「其他」' };
    }

    state.running = true;
    state.lastAttemptAt = t0;
    try {
      const frame = await source.capture();
      if (!frame.ok) { recordError(frame.code, frame.error, frame.hint); return frame; }
      // 截图恢复了：截图侧的连续失败立刻清零（模型侧失败要等模型调用成功才清）。
      if (state.failCode && !['screen.model-failed', 'screen.no-attachments'].includes(state.failCode)) recordSuccess();
      state.lookTimes.push(t0);
      state.lookTimes = recent(state.lookTimes, t0);
      state.lastLookAt = t0;
      if (!manual) {
        // 隐私窗口过滤永远生效；「画面没变就不看」只在后台例行看时生效。
        const gate = decideAfterCapture(c, force ? { ...state, lastThumb: '' } : state, frame);
        if (!gate.ask) {
          if (gate.reason !== 'unchanged') state.lastThumb = '';
          state.lastSkip = gate.reason;
          if (question && deliver) {
            await chat.proactive({ text: '前台是隐私窗口 这个我就不看了', purpose: { kind: 'screen' }, remember: false });
          }
          return { ok: true, skipped: gate.reason, diff: gate.diff };
        }
      }
      state.lastThumb = frame.thumb;

      const system = `${chat.systemPromptForFrontend({ modality: 'text' })}\n\n${buildLookInstruction(c, {
        title: frame.title,
        notes: noteLines(c, 4).map((line) => line),
        forced: force,
        question,
      })}`;
      let reply;
      try {
        reply = await chat.complete({
          system,
          user: '看一眼屏幕，按要求只输出 JSON。',
          images: [{ data: frame.bytes, mediaType: frame.mediaType }],
          effort: c.effort,
          // effort=low 时思考也算在 maxTokens 里；500 会把 JSON 截断成「没给 say」（2026-11-17 实测），留足余量。
          maxTokens: 1500,
          temperature: 0.9,
        });
        chat.recordUsage?.(reply.usage, reply.model);
      } catch (error) {
        const code = error?.code === 'screen.no-attachments' ? 'screen.no-attachments' : 'screen.model-failed';
        const hint = code === 'screen.no-attachments' ? '这个 DSH 版本不支持插件发图；升级 DSH' : '确认 DSH 当前模型支持读图（Claude 都支持；部分 DeepSeek 模型不支持）';
        recordError(code, String(error?.message ?? error).slice(0, 200), hint);
        return { ok: false, code, error: String(error?.message ?? error).slice(0, 200), hint };
      }

      const parsed = parseLookReply(reply.text);
      // 他问了问题、她已经说了「我瞅瞅」：无论如何要补一句，不能让他干等。
      if (question && !parsed.say) {
        const raw = String(reply.text || '').trim();
        parsed.say = !parsed.parsed && raw && raw.length <= 40 && !raw.includes('{') ? raw : '没看清 你再说一遍';
        pluginLog(`[screen-watch] 回答他时模型没给 say（${parsed.parsed ? 'say 为空' : '不是 JSON/被截断'}：${raw.slice(0, 60)}），用兜底句`);
      }
      // 下一眼什么时候看：模型自己定，夹在上下限里。
      state.paceSec = paceSeconds(c, parsed.nextLookSec, state.paceSec || c.firstIntervalSec);
      state.nextLookAt = t0 + state.paceSec * 1000;
      if (parsed.note) {
        state.notes.push({ at: t0, text: frame.title ? `[${frame.title.slice(0, 30)}] ${parsed.note}` : parsed.note });
        state.notes = state.notes.slice(-20);
      }

      let remembered = false;
      if (c.rememberNotable && parsed.memory && parsed.memory.importance >= c.minMemoryImportance) {
        remembered = appendMemoryInboxEvent(activeMemoryPaths(), {
          at: t0,
          platform: 'screen',
          kind: 'private',
          sender: '我',
          isSelf: true,
          private: true,
          direct: true,
          conversationKey: 'screen',
          text: parsed.memory.text,
          title: parsed.memory.title,
          detail: parsed.memory.detail,
          tags: parsed.memory.tags,
          importance: parsed.memory.importance,
          scope: 'pet',
        });
      }

      let said = null;
      if (parsed.say && deliver) {
        const speakGate = force ? { speak: true, reason: 'forced' } : decideSpeak(c, state, { lastProactiveAt: chat.lastActivity?.().lastProactiveAt || 0 }, now());
        if (speakGate.speak) {
          // 回答他问题的那句算对话，进记忆（以后能接着聊）；例行搭话不进，免得刷爆记忆卡。
          const sent = await chat.proactive({ text: parsed.say, purpose: { kind: 'screen', text: parsed.note }, remember: Boolean(question) });
          if (sent?.ok) {
            said = parsed.say;
            state.lastCommentAt = now();
            state.commentTimes = recent([...state.commentTimes, state.lastCommentAt], state.lastCommentAt);
          }
        } else {
          state.lastSkip = `say:${speakGate.reason}`;
        }
      }

      const result = { ok: true, title: frame.title, note: parsed.note, say: parsed.say, said, memory: parsed.memory, remembered, parsed: parsed.parsed, ms: now() - t0 };
      state.lastResult = { ...result, at: t0 };
      recordSuccess();
      if (said || remembered) pluginLog(`[screen-watch] ${said ? `说：${said}` : ''}${said && remembered ? '；' : ''}${remembered ? `记住：${parsed.memory.title || parsed.memory.text.slice(0, 20)}` : ''}`);
      return result;
    } finally {
      state.running = false;
    }
  }

  function contextBlock() {
    const c = cfg();
    if (!c.enabled || !c.notesInPrompt) return '';
    const lines = noteLines(c, c.notesInPrompt);
    if (!lines.length) return '';
    return `【你最近亲眼看到的他的屏幕（旧→新，带时间；这里没有的别编）】\n${lines.join('\n')}`;
  }

  /**
   * 给 dsh-pet 的提示：dsh-pet 的对话加不了工具，所以要现看屏幕时让她先说「等下我看一眼」，
   * 真正的看由 onUserMessage 在后台做，看完把答案当气泡补上。
   */
  function dshPetHint() {
    const c = cfg();
    if (!c.enabled || !c.onDemand) return '';
    return '【看屏幕】他问到他屏幕上的东西时：上面「亲眼看到的」够回答就直接答（说清是多久前看到的）；不够或者他要你现在看，就说「等下我看一眼」之类——你马上会自己截一张看，再补一句回他。别说你看不到他屏幕。';
  }

  /** 让模型判断：回他这句话需不需要现在看一眼屏幕（不带人格，几十个 token）。 */
  async function needsScreen(text) {
    const c = cfg();
    const notes = noteLines(c, 3);
    const reply = await chat.complete({
      system: '你在判断一件事：要回答用户刚说的这句话，需不需要现在看一眼他的电脑屏幕。只回 yes 或 no，不要别的。',
      user: `${notes.length ? `已知（之前看到的）：\n${notes.join('\n')}\n\n` : ''}他刚说：「${String(text).slice(0, 300)}」\n需要现在看他的屏幕吗？`,
      effort: 'off',
      maxTokens: 128,
      temperature: 0,
    });
    chat.recordUsage?.(reply.usage, reply.model);
    return /^\s*(yes|是|需要)/i.test(String(reply.text || ''));
  }

  let questionBusy = false;
  /**
   * dsh-pet 收到他的一句话：后台让模型判断要不要看；要看就为这句话现截一张并回答他。
   * 返回「要不要看」的判断（Promise<boolean>；不适用时 null），dsh-pet 联动据此让她当场只说「我瞅瞅」。
   * 看完的回答通过 onAnswer 交回（联动把它写回 dsh-pet 自己的对话历史）。
   */
  function onUserMessage(text, { onAnswer = null } = {}) {
    const c = cfg();
    const say = String(text || '').trim();
    if (!c.enabled || !c.onDemand || !say || questionBusy) return null;
    questionBusy = true;
    let resolveNeed;
    const decision = new Promise((resolve) => { resolveNeed = resolve; });
    void (async () => {
      try {
        if (await budgetBlocked()) { resolveNeed(false); state.lastSkip = 'question:budget'; pluginLog('[screen-watch] 问题不看：今天 token 额度（其他）已用完'); return; }
        const need = await needsScreen(say);
        resolveNeed(need);
        state.lastQuestion = { at: now(), text: say.slice(0, 60), need };
        pluginLog(`[screen-watch] 他问「${say.slice(0, 30)}」→ 模型判断${need ? '要看屏幕' : '不用看'}`);
        if (!need) { state.lastSkip = 'question:no-need'; return; }
        // 等 dsh-pet 那句「等下我看一眼」先说完，再补答案。
        await new Promise((resolve) => { const t = setTimeout(resolve, 1500); t.unref?.(); });
        for (let i = 0; i < 20 && state.running; i += 1) await new Promise((resolve) => { const t = setTimeout(resolve, 250); t.unref?.(); });
        let result = await lookOnce({ force: true, deliver: true, question: say });
        if (result?.code === 'screen.busy') {
          await new Promise((resolve) => { const t = setTimeout(resolve, 3000); t.unref?.(); });
          result = await lookOnce({ force: true, deliver: true, question: say });
        }
        state.lastQuestion = { ...state.lastQuestion, result: result?.said || result?.skipped || result?.code || (result?.ok ? 'no-say' : 'failed') };
        if (result?.said) { try { onAnswer?.(result.said); } catch {} }
        else if (!result?.skipped) {
          // 她已经说了「我瞅瞅」：没看成也要照实补一句，不能让他干等（隐私窗口那种 skipped 已经自己说过了）。
          const why = result?.code === 'screen.budget' ? '今天额度用完了' : result?.code === 'screen.model-failed' ? '模型那边卡了' : '截图没截上';
          const line = `没看成 ${why} 你再问下`;
          pluginLog(`[screen-watch] 为回答他看了一眼但没成：${result?.code || ''} ${result?.error || ''}，补一句「${line}」`);
          const sent = await chat.proactive({ text: line, purpose: { kind: 'screen' }, remember: false });
          if (sent?.ok) { try { onAnswer?.(line); } catch {} }
        }
      } catch (error) {
        resolveNeed(null);
        recordError('screen.question-failed', String(error?.message ?? error).slice(0, 160), '下次再问一次试试');
      } finally {
        questionBusy = false;
      }
    })();
    return decision;
  }

  /** 聊天里的工具：要不要看屏幕由模型自己决定。隐私窗口在前台时不截图，只告诉模型「没看」。 */
  const lookTool = {
    name: 'look_at_screen',
    description: '看一眼他现在的电脑屏幕（会截一张图给你看）。他问屏幕上的东西、问「这是哪/这是啥/我在玩什么」、或者你真的需要知道他此刻在干嘛时再用；普通闲聊、你已经从「最近瞄到的屏幕」里知道答案时不要用。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '为什么要看（一句话）' } },
    },
    enabled: () => { const c = cfg(); return c.enabled && c.onDemand; },
    async run() {
      const c = cfg();
      if (await budgetBlocked()) return { text: '今天的 token 额度用完了，看不了屏幕。跟他说一声。', isError: true };
      const frame = await source.capture();
      if (!frame.ok) {
        recordError(frame.code, frame.error, frame.hint);
        return { text: `截不到屏幕（${frame.error}）。跟他说你现在看不到，别编。`, isError: true };
      }
      if (titleMatches(frame.title, c.ignoreApps) || (c.watchApps.length && !titleMatches(frame.title, c.watchApps))) {
        state.lastSkip = 'tool:filtered-app';
        return { text: '前台是隐私类窗口（聊天/密码/银行等，或不在允许看的程序里），按规矩没截图。跟他说你没看。' };
      }
      state.lastSkip = 'tool:looked';
      return {
        text: `这是他此刻的屏幕截图。前台窗口：${frame.title || '未知'}。只说你真看到的；看不清就说看不清。`,
        images: [{ data: frame.bytes, mediaType: frame.mediaType }],
      };
    },
  };

  async function tick() {
    try {
      const c = cfg();
      if (!c.enabled) { state.lastSkip = 'disabled'; return; }
      // 2026-11-18 用户：桌宠关着（知更鸟 display=none、surfpet 没连）就不在后台看屏幕 —— 没人看得见她说话，白花 token。
      // 只停后台例行看；桌宠里问她 / 快捷对话附截图这种他主动要的照常。
      let present = true;
      try { present = petPresent() !== false; } catch {}
      if (!present) {
        if (state.lastSkip !== 'no-pet') pluginLog('[screen-watch] 桌宠关着 → 暂停后台看屏幕（省 token；打开桌宠自动恢复）');
        state.lastSkip = 'no-pet';
        return;
      }
      if (state.lastSkip === 'no-pet') { pluginLog('[screen-watch] 桌宠打开了 → 恢复看屏幕'); state.lastSkip = ''; state.nextLookAt = 0; }
      const t = now();
      if (state.backoffUntil && t < state.backoffUntil) { state.lastSkip = 'backoff'; return; }
      if (!state.nextLookAt) state.nextLookAt = t + c.firstIntervalSec * 1000;
      if (t < state.nextLookAt) return;
      await lookOnce({ force: false, deliver: true });
      // 没看成（闸门挡住/画面没变/出错）时保持当前节奏，别每 5 秒撞一次闸门。
      if (state.nextLookAt <= t) state.nextLookAt = t + paceSeconds(c, state.paceSec, c.firstIntervalSec) * 1000;
    } catch (error) {
      recordError('screen.tick-failed', String(error?.message ?? error).slice(0, 200), '下一轮会重试');
    }
  }

  function start() {
    if (timer) return;
    removeContext = chat.addContextSource(contextBlock);
    removeTool = chat.addTool(lookTool);
    timer = setInterval(() => { void tick(); }, 5000);
    timer.unref?.();
    const c = cfg();
    if (c.enabled) pluginLog(`[screen-watch] 已启动：看屏幕节奏由她自己定（${c.minIntervalSec}~${c.maxIntervalSec}s），话量=${c.chattiness}，每小时最多 ${c.maxCommentsPerHour} 句`);
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try { removeContext?.(); } catch {}
    try { removeTool?.(); } catch {}
    try { await source.close?.(); } catch {}
  }

  function status() {
    const c = cfg();
    const t = now();
    return {
      ok: true,
      config: c,
      looksLastHour: recent(state.lookTimes, t).length,
      commentsLastHour: recent(state.commentTimes, t).length,
      lastLookAt: state.lastLookAt,
      lastSkip: state.lastSkip,
      lastResult: state.lastResult,
      lastError: state.lastError,
      failStreak: state.failStreak,
      backoffUntil: state.backoffUntil,
      paceSec: state.paceSec,
      nextLookAt: state.nextLookAt,
      lastQuestion: state.lastQuestion || null,
      notes: freshNotes(c, t).slice(-c.notesInPrompt || -5),
    };
  }

  /** 配置刚被改（菜单切开关/频率）：马上按新节奏来，别等上一个长间隔走完。 */
  function kick() {
    state.nextLookAt = 0;
    state.paceSec = 0;
    state.backoffUntil = 0;
    state.failStreak = 0;
    state.failCode = '';
  }

  return { start, stop, tick, lookOnce, status, contextBlock, lookTool, dshPetHint, onUserMessage, needsScreen, kick, _state: state };
}
