/**
 * 桌宠听话挪位置（2026-11-18 用户：「往左走」她真的走过去，用 dsh-pet 自带的走路动画）。
 *
 * 在联动的 recall 里（他刚发消息、她还没回）做一次很小的判断（十几个 token 的输出）：要不要挪、往哪挪、他这句的语气。
 * 只算方向和用哪个走位动作；真正走路由联动在她回完话之后（capture）发 /anim {走位动作, facing}，
 * dsh-pet 自带的 tryMove 接管（见 lib/dsh-pet-bridge.js walkAfterReply）。
 * 配置：合体层 `petMove { enabled }`（默认开）。
 */

const DIRS = ['left', 'right', 'center', 'leftedge', 'rightedge', 'otherside', 'none'];
// dsh-pet moves.actions 里的走位动作：近的走、远的跑
export const WALK_ANIM = '螃蟹走路';
export const RUN_ANIM = '原地左转奔跑';

export function normalizePetMoveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return { enabled: c.enabled !== false };
}

export function parseDirection(text) {
  const w = String(text ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return DIRS.includes(w) && w !== 'none' ? w : null;
}

/** 0~1 坐标：往左/右挪四分之一屏，或到中间/两边。 */
export function targetX(x, dir) {
  const cur = Number.isFinite(Number(x)) ? Number(x) : 0.5;
  const t = { left: cur - 0.25, right: cur + 0.25, center: 0.5, leftedge: 0.06, rightedge: 0.94, otherside: cur < 0.5 ? cur + 0.3 : cur - 0.3 }[dir];
  return Math.round(Math.min(0.95, Math.max(0.05, t ?? cur)) * 1000) / 1000;
}

// 2026-11-18：同一次判断顺便看他这句的语气（影响她的心情），不多调一次模型。
export const TONES = { funny: 2, warm: 1, neutral: 0, blame: -1, rude: -2 };
export function parseTone(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find((w) => w in TONES) ?? 'neutral';
}
export const MOVE_CLASSIFIER = [
  '你在判断他对桌面宠物（屏幕上的小人）说的一句话。只输出两个英文词，空格隔开：',
  '第一个：要不要它挪位置 —— left（往左/去左边）· right（往右/去右边）· center（过来/到中间/回来）· leftedge（去最左边/靠左边站）· rightedge（去最右边）· otherside（往那边走 / 走开点 / 别挡着 —— 让它挪但没说方向）· none（不是让它挪位置，包括只是聊天、问左右的事）。',
  '第二个：他这句的语气 —— funny（逗她 / 玩梗 / 好笑）· warm（夸她 / 关心 / 亲近）· neutral（普通聊天、问事）· blame（怪她 / 嫌弃 / 说她不好）· rude（骂她 / 很冲 / 羞辱）。',
  '例：「往左走」→ left neutral；「你真笨」→ none blame；「哈哈哈你太逗了」→ none funny。',
].join('\n');

export function createPetMove({ chat, readConfig, currentDshUrl, pluginLog = () => {}, fetchImpl = (...a) => fetch(...a), onTone = null, toneEnabled = () => false } = {}) {
  const cfg = () => { try { return normalizePetMoveConfig(readConfig()); } catch { return normalizePetMoveConfig({}); } };
  let last = { at: 0, text: '', dir: null, ok: null, error: '' };
  const base = () => String(currentDshUrl() || '').replace(/\/+$/, '');

  async function classify(text) {
    const reply = await chat.complete({ system: MOVE_CLASSIFIER, user: `他说：「${String(text).slice(0, 200)}」`, effort: 'off', maxTokens: 64, temperature: 0 });
    chat.recordUsage?.(reply.usage, reply.model);
    const words = String(reply.text ?? '').trim().split(/\s+/);
    return { dir: parseDirection(words[0]), tone: parseTone(words.slice(1).join(' ')) };
  }

  async function readPose(petId) {
    const res = await fetchImpl(`${base()}/dsh-pet-7340/pose?pet=${encodeURIComponent(petId)}`, { signal: AbortSignal.timeout(4000) });
    return res.json().catch(() => ({}));
  }

  /** @returns {Promise<{ dir: string|null, action: string|null, facing: string|null, tone: string }>} */
  async function decide(text, petId = 'main') {
    const none = { dir: null, action: null, facing: null, tone: 'neutral' };
    const moveOn = cfg().enabled;
    let toneOn = false;
    try { toneOn = toneEnabled() === true; } catch {}
    if ((!moveOn && !toneOn) || !String(text ?? '').trim()) return none;
    try {
      const { dir: rawDir, tone } = await classify(text);
      const dir = moveOn ? rawDir : null;
      last = { at: Date.now(), text: String(text).slice(0, 40), dir, tone, ok: null, error: '' };
      if (toneOn && tone !== 'neutral') { try { onTone?.(tone, TONES[tone], text); } catch {} }
      if (!dir) return { ...none, tone };
      const pose = await readPose(petId);
      if (pose?.ok !== true) { last = { ...last, ok: false, error: 'petmove.no-desktop' }; return { ...none, tone }; }
      const from = Number.isFinite(Number(pose.x)) ? Number(pose.x) : 0.5;
      const target = targetX(from, dir);
      const facing = dir === 'left' || dir === 'leftedge' || (dir !== 'right' && dir !== 'rightedge' && target < from) ? 'left' : 'right';
      // 「往左 / 往右」走；「往那边去 / 走开点」跑；「到中间 / 到边上」远就跑、近就走
      const action = dir === 'otherside' ? RUN_ANIM : (dir === 'left' || dir === 'right') ? WALK_ANIM : (Math.abs(target - from) > 0.2 ? RUN_ANIM : WALK_ANIM);
      // 不在回话前转身（她回话的动作会把它盖掉）：等她回完，联动在 capture 里发走位动作 + 朝向（dsh-pet 自带的 tryMove 真走）
      last = { ...last, ok: true, facing, action };
      pluginLog(`[pet-move] 「${last.text}」→ ${dir}：她回完话就朝 ${facing} 走（[动作:${action}]，dsh-pet 自带的走路）`);
      return { dir, action, facing, tone };
    } catch (error) {
      last = { ...last, ok: false, error: `petmove.failed: ${String(error?.message ?? error).slice(0, 120)}` };
      pluginLog('[pet-move] 判断失败：', String(error?.message ?? error).slice(0, 120));
      return none;
    }
  }

  function status() { return { ok: true, config: cfg(), last }; }
  return { decide, classify, status };
}
