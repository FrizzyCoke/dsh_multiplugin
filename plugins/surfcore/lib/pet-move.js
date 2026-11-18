/**
 * 桌宠听话挪位置（2026-11-18 用户：「往左走」「过来」她真的会走过去）。
 *
 * 不改 dsh-pet：dsh-pet 的回复里只认它自己的动作名，[动作:往左走] 这种会被它删掉，插件也拿不到。
 * 所以在联动的 recall 里（他刚发消息、她还没回）用一次很小的判断（不带人格，十几个 token 的输出）：
 * 这句是不是让桌宠挪位置、往哪挪 —— 由模型判断，不是关键词规则。要挪就读 /pose 拿当前位置，
 * 算目标后 POST /position（line 模式走过去）。只对显示在桌面上的宠物生效。
 * 配置：合体层 `petMove { enabled }`（默认开）。
 */

const DIRS = ['left', 'right', 'center', 'leftedge', 'rightedge', 'otherside', 'none'];
// 走路用 dsh-pet 自己的跑步动画（它的 moves 里就是这个；起步约 1.75 秒后才开始位移）
export const WALK_ANIM = '螃蟹走路';  // dsh-pet moves.actions 里的走路（近）
export const RUN_ANIM = '原地左转奔跑'; // 跑（远）
export const IDLE_ANIM = '待机呼吸休闲'; // 只转身时播的原地待机
export const WALK_LEAD_MS = 1750;

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

export function createPetMove({ chat, readConfig, currentDshUrl, pluginLog = () => {}, fetchImpl = (...a) => fetch(...a), pollMs = 500, leadWaitMs = 2200, onTone = null, toneEnabled = () => false } = {}) {
  const cfg = () => { try { return normalizePetMoveConfig(readConfig()); } catch { return normalizePetMoveConfig({}); } };
  let last = { at: 0, text: '', dir: null, ok: null, error: '' };
  const base = () => String(currentDshUrl() || '').replace(/\/+$/, '');

  async function classify(text) {
    const reply = await chat.complete({ system: MOVE_CLASSIFIER, user: `他说：「${String(text).slice(0, 200)}」`, effort: 'off', maxTokens: 64, temperature: 0 });
    chat.recordUsage?.(reply.usage, reply.model);
    const words = String(reply.text ?? '').trim().split(/\s+/);
    return { dir: parseDirection(words[0]), tone: parseTone(words.slice(1).join(' ')) };
  }

  // 2026-11-18 用户：要用 dsh-pet 自带的走路，不是平移；还要能打断她正在做的动作。
  // dsh-pet 的规则（runtime/electron-helper/events.js applyAnimLeaf → sprite.onMenuAction → tryMove）：
  //   /anim 给一个「走位动作名」+ facing → 先转向、再按它自己的走路动画真走一段（方向 = 朝向，距离它自己定）。
  //   正在走 / 被抛着时它会回 busy 不理 → 先发一个原地 instant 的 /position：moveToCenter 会 stopMove/stopThrow 打断。
  async function call(route, q, body) {
    const res = await fetchImpl(`${base()}/dsh-pet-7340${route}?${q}${body ? '&surface=any' : ''}`, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(4000),
    });
    return res.json().catch(() => ({}));
  }

  /**
   * 等她这一步走完。真机实测（2026-11-18）：起步约 2 秒原地不动，之后慢慢挪 6 秒多 ——
   * 所以先等过起步，再要位置连续 3 次不变（约 1.5 秒）才算到；最多等 20 秒。
   */
  async function settle(q, startX) {
    if (leadWaitMs > 0) await new Promise((r) => setTimeout(r, leadWaitMs));
    let last = startX;
    let still = 0;
    for (let i = 0; i < 40; i += 1) {
      if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
      const p = await call('/pose', q);
      if (p?.ok !== true) return last;
      const x = Number(p.x);
      if (Number.isFinite(x) && Math.abs(x - last) < 0.002) { still += 1; if (still >= 3) return x; } else still = 0;
      if (Number.isFinite(x)) last = x;
    }
    return last;
  }

  async function move(petId, dir) {
    const q = `pet=${encodeURIComponent(petId)}`;
    const pose = await call('/pose', q);
    if (pose?.ok !== true) return { ok: false, code: 'petmove.no-desktop', error: pose?.message || '宠物没显示在桌面上' };
    const from = Number.isFinite(Number(pose.x)) ? Number(pose.x) : 0.5;
    const y = Number.isFinite(Number(pose.y)) ? Number(pose.y) : 0.9;
    const target = targetX(from, dir);
    // 「往左 / 往右 / 往那边一点」走一步就行；「到中间 / 到最边上」朝目标多走几步
    const steps = ['left', 'right', 'otherside'].includes(dir) ? 1 : 4;
    // ① 打断她手上的动作（原地 instant，不动位置）
    const stop = await call('/position', q, { x: from, y, mode: 'instant' });
    if (stop?.ok !== true) return { ok: false, code: 'petmove.rejected', error: `${stop?.reason ?? ''} ${stop?.message ?? ''}`.trim() || '打断不了当前动作' };
    let cur = from;
    let walked = 0;
    for (let i = 0; i < steps; i += 1) {
      if (steps > 1 && Math.abs(target - cur) < 0.05) break;
      const goLeft = steps === 1 ? (dir === 'left' || (dir === 'otherside' && from >= 0.5)) : target < cur;
      // 「往左一点」走；「往那边去 / 到中间 / 到边上」还远就跑
      const far = steps === 1 ? dir === 'otherside' : Math.abs(target - cur) > 0.2;
      // ② 转向 + 用它自带的走路动画真走（远就跑、近就走）
      const r = await call('/anim', q, { name: far ? RUN_ANIM : WALK_ANIM, facing: goLeft ? 'left' : 'right' });
      if (r?.ok !== true) return { ok: walked > 0, code: 'petmove.rejected', error: `${r?.reason ?? ''} ${r?.message ?? ''}`.trim() || '走不了', x: cur };
      walked += 1;
      const next = await settle(q, cur);
      if (Math.abs(next - cur) < 0.005) break; // 走不动了（到边了）
      cur = next;
    }
    return { ok: true, x: Math.round(cur * 1000) / 1000, steps: walked, facing: cur < from ? 'left' : 'right' };
  }

  /** 联动 recall 里调：不阻塞她回话（判断 + 走路在后台）。 */
  /**
   * 2026-11-18（用户：「用它自带的走路，不是你的输入」）：
   * 走不再由插件驱动。dsh-pet 回话末尾的 [动作:X] 会被它自己播（writePet anim → onMenuAction），
   * X 是走位动作（螃蟹走路 / 原地左转奔跑）时它会 tryMove —— 用自带的走路动画、朝当前朝向真走。
   * 所以这里只做两件事：① 在她回话之前判断要不要挪、往哪挪（顺带语气）；② 要挪就先把她转到那个方向（只转身、不位移）。
   * 走哪个动作交给联动在 recall 里写进她的 system（她回话时自己带上 [动作:…]）。
   * @returns {Promise<{ dir: string|null, action: string|null, facing: string|null, tone: string }>}
   */
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
      const q = `pet=${encodeURIComponent(petId)}`;
      const pose = await call('/pose', q);
      if (pose?.ok !== true) { last = { ...last, ok: false, error: 'petmove.no-desktop' }; return { ...none, tone }; }
      const from = Number.isFinite(Number(pose.x)) ? Number(pose.x) : 0.5;
      const target = targetX(from, dir);
      const facing = dir === 'left' || dir === 'leftedge' || (dir !== 'right' && dir !== 'rightedge' && target < from) ? 'left' : 'right';
      // 「往左 / 往右」走；「往那边去 / 走开点」跑；「到中间 / 到边上」远就跑、近就走
      const action = dir === 'otherside' ? RUN_ANIM : (dir === 'left' || dir === 'right') ? WALK_ANIM : (Math.abs(target - from) > 0.2 ? RUN_ANIM : WALK_ANIM);
      // 只转身：播一下原地待机并带上朝向（dsh-pet 的 /anim 会先设 facing 再播）；走由她回话的 [动作] 触发
      if (pose.facing !== facing) await call('/anim', q, { name: IDLE_ANIM, facing });
      last = { ...last, ok: true, facing, action };
      pluginLog(`[pet-move] 「${last.text}」→ ${dir}：转向 ${facing}，让她回话带 [动作:${action}]（dsh-pet 自己走）`);
      return { dir, action, facing, tone };
    } catch (error) {
      last = { ...last, ok: false, error: `petmove.failed: ${String(error?.message ?? error).slice(0, 120)}` };
      pluginLog('[pet-move] 判断失败：', String(error?.message ?? error).slice(0, 120));
      return none;
    }
  }

  /** 兼容旧调用：只判断 + 转身 + 语气（不再自己走）。 */
  function onUserMessage(text, petId = 'main') { void decide(text, petId); }

  function status() { return { ok: true, config: cfg(), last }; }
  return { decide, onUserMessage, classify, move, status };
}
