/**
 * 桌宠听话挪位置（2026-11-18 用户：「往左走」「过来」她真的会走过去）。
 *
 * 不改 dsh-pet：dsh-pet 的回复里只认它自己的动作名，[动作:往左走] 这种会被它删掉，插件也拿不到。
 * 所以在联动的 recall 里（他刚发消息、她还没回）用一次很小的判断（不带人格，十几个 token 的输出）：
 * 这句是不是让桌宠挪位置、往哪挪 —— 由模型判断，不是关键词规则。要挪就读 /pose 拿当前位置，
 * 算目标后 POST /position（line 模式走过去）。只对显示在桌面上的宠物生效。
 * 配置：合体层 `petMove { enabled }`（默认开）。
 */

const DIRS = ['left', 'right', 'center', 'leftedge', 'rightedge', 'none'];

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
  const t = { left: cur - 0.25, right: cur + 0.25, center: 0.5, leftedge: 0.06, rightedge: 0.94 }[dir];
  return Math.round(Math.min(0.95, Math.max(0.05, t ?? cur)) * 1000) / 1000;
}

export const MOVE_CLASSIFIER = [
  '你在判断一句话：他是不是在让桌面宠物（屏幕上的小人）挪位置。只输出一个词：',
  'left（往左/去左边）· right（往右/去右边）· center（过来/到中间/回来）· leftedge（去最左边/靠左边站）· rightedge（去最右边）· none（不是让它挪位置，包括只是聊天、问左右的事）。',
].join('\n');

export function createPetMove({ chat, readConfig, currentDshUrl, pluginLog = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
  const cfg = () => { try { return normalizePetMoveConfig(readConfig()); } catch { return normalizePetMoveConfig({}); } };
  let last = { at: 0, text: '', dir: null, ok: null, error: '' };
  const base = () => String(currentDshUrl() || '').replace(/\/+$/, '');

  async function classify(text) {
    const reply = await chat.complete({ system: MOVE_CLASSIFIER, user: `他说：「${String(text).slice(0, 200)}」`, effort: 'off', maxTokens: 64, temperature: 0 });
    chat.recordUsage?.(reply.usage, reply.model);
    return parseDirection(reply.text);
  }

  async function move(petId, dir) {
    const q = `pet=${encodeURIComponent(petId)}`;
    const pose = await (await fetchImpl(`${base()}/dsh-pet-7340/pose?${q}`, { signal: AbortSignal.timeout(4000) })).json();
    if (pose?.ok !== true) return { ok: false, code: 'petmove.no-desktop', error: pose?.message || '宠物没显示在桌面上' };
    const x = targetX(pose.x, dir);
    const y = Number.isFinite(Number(pose.y)) ? Number(pose.y) : 0.9;
    const duration = Math.round(Math.abs(x - (Number(pose.x) || 0.5)) * 4000) + 400;
    const res = await fetchImpl(`${base()}/dsh-pet-7340/position?${q}&surface=any`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, y, mode: 'line', duration }),
      signal: AbortSignal.timeout(4000),
    });
    const body = await res.json().catch(() => ({}));
    if (body?.ok !== true) return { ok: false, code: 'petmove.rejected', error: `${body?.reason ?? ''} ${body?.message ?? ''}`.trim() || `HTTP ${res.status}` };
    return { ok: true, x, y, duration };
  }

  /** 联动 recall 里调：不阻塞她回话（判断 + 走路在后台）。 */
  function onUserMessage(text, petId = 'main') {
    if (!cfg().enabled || !String(text ?? '').trim()) return;
    void (async () => {
      try {
        const dir = await classify(text);
        last = { at: Date.now(), text: String(text).slice(0, 40), dir, ok: null, error: '' };
        if (!dir) return;
        const r = await move(petId, dir);
        last = { ...last, ok: r.ok, error: r.ok ? '' : `${r.code}: ${r.error}` };
        pluginLog(r.ok ? `[pet-move] 「${last.text}」→ ${dir}，走到 x=${r.x}` : `[pet-move] 「${last.text}」→ ${dir} 没走成（${r.code}）：${r.error}`);
      } catch (error) {
        last = { ...last, ok: false, error: `petmove.failed: ${String(error?.message ?? error).slice(0, 120)}` };
        pluginLog('[pet-move] 失败：', String(error?.message ?? error).slice(0, 120));
      }
    })();
  }

  function status() { return { ok: true, config: cfg(), last }; }
  return { onUserMessage, classify, move, status };
}
