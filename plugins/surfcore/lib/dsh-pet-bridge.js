/**
 * dsh-pet 联动：让 dsh-pet（PC2005-cloud/dsh-pet，114 个动画的桌宠）成为 SurfCore 的另一张「脸」。
 *
 * 只走 dsh-pet 公开的扩展点，不改它的代码：
 *   · cordis 服务 `petApi7340.memory.register({ id, recall, capture })`（dsh-pet 的第三方记忆钩子）
 *       recall  → 用 SurfCore 桌宠同一份 system prompt（人格卡 + 记忆卡 + 心事）替换它的人设；
 *                 dsh-pet 自己的动作/表情包指令在 recall 之后才拼，不受影响。
 *       capture → 这一轮问答写进 SurfCore 记忆 inbox（和 surfpet 同一张记忆卡）。
 *   · HTTP `POST /dsh-pet-7340/broadcast`：SurfCore 的主动搭话同时弹在 dsh-pet 上。
 *
 * 配置：合体层 config.json 的 `dshPetBridge`；enabled=false（默认）时完全不注册、不发请求。
 * 回滚：关开关即可；删掉本文件和 index.js 里的接线就回到原样。
 */
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'petApi7340';
const PROVIDER_ID = 'surfcore';
const ROUTE = '/dsh-pet-7340';
const ENSURE_MS = 30 * 1000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeDshPetBridgeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const ids = Array.isArray(c.petIds) ? c.petIds.map((id) => String(id).trim()).filter(Boolean) : [];
  return {
    enabled: c.enabled === true,
    brain: c.brain !== false,
    remember: c.remember !== false,
    mirrorProactive: c.mirrorProactive !== false,
    petIds: ids.length ? ids : ['main'],
    bubbleMs: clampInt(c.bubbleMs, 8000, 2000, 60000),
  };
}

/** 去掉 JSONC 注释（尊重字符串里的 // 和 /*）。 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
    out += ch;
  }
  return out;
}

export function createDshPetBridge({ ctx, chat, readConfig, currentDshUrl, dshPetUserRoot, pluginLog = () => {}, onUserMessage = null, extraSystem = null, onMoveIntent = null } = {}) {
  let unregister = null;
  let removeFrontend = null;
  let timer = null;
  let lastError = '';
  let lastRecallAt = 0;
  let lastCaptureAt = 0;
  let lastMirrorAt = 0;
  let announced = false;

  const cfg = () => {
    try { return normalizeDshPetBridgeConfig(readConfig()); } catch { return normalizeDshPetBridgeConfig({}); }
  };

  function service() {
    try {
      if (typeof ctx?.get === 'function') return ctx.get(SERVICE, false) || undefined;
    } catch {}
    try { return ctx?.[SERVICE]; } catch { return undefined; }
  }

  function fail(code, message) {
    lastError = `${code}: ${message}`;
    pluginLog(`[dsh-pet-bridge] ${code}：${message}`);
  }

  /** dsh-pet 用户配置里这些宠物是否在显示（display=none 时弹气泡没人看得见）。 */
  function visiblePetIds() {
    const want = cfg().petIds;
    try {
      const raw = fs.readFileSync(path.join(dshPetUserRoot, 'main-config.jsonc'), 'utf8');
      const parsed = JSON.parse(stripJsonComments(raw));
      const pets = Array.isArray(parsed?.pets) ? parsed.pets : [];
      return want.filter((id) => {
        const pet = pets.find((p) => String(p?.id ?? '') === id);
        return !pet || String(pet.display ?? '') !== 'none';
      });
    } catch {
      return want;
    }
  }

  /**
   * 把她「看完屏幕补的那句」写回 dsh-pet 自己的对话历史（memory.json），
   * 否则 dsh-pet 那边只记得她说过「我瞅瞅」，下一句接不上。尽力而为，失败只记日志。
   */
  function recordReply(petId, text) {
    const file = path.join(dshPetUserRoot, 'memory.json');
    try {
      const mem = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      let entry = null;
      for (const bucket of Object.values(mem)) {
        if (bucket && typeof bucket === 'object' && bucket[petId] && Array.isArray(bucket[petId].messages)) { entry = bucket[petId]; break; }
      }
      if (!entry) return false;
      entry.messages.push({ role: 'assistant', content: String(text), ts: Date.now() });
      const tmp = `${file}.surfcore-tmp`;
      fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      pluginLog('[dsh-pet-bridge] 写回 dsh-pet 对话历史失败：', String(error?.message ?? error).slice(0, 120));
      return false;
    }
  }

  // 快捷对话框发来的句子已经决定好带不带截图：对这一句（按原文、20 秒内）跳过「要不要看屏幕」的后台判断。
  const suppressed = new Map();
  function suppressScreenFor(text, ttlMs = 20000) {
    const key = String(text || '').trim();
    if (key) suppressed.set(key, Date.now() + ttlMs);
  }
  function takeSuppressed(text) {
    const key = String(text || '').trim();
    const until = suppressed.get(key);
    for (const [k, t] of suppressed) if (t < Date.now()) suppressed.delete(k);
    if (until && until >= Date.now()) { suppressed.delete(key); return true; }
    return false;
  }

  async function recall({ petId, system, userText } = {}) {
    const c = cfg();
    if (!c.enabled || !c.brain || !c.petIds.includes(String(petId))) return undefined;
    const base = chat.systemPromptForFrontend({ modality: 'text' });
    if (!base) return undefined;
    lastRecallAt = Date.now();
    // 要不要现看屏幕由模型判断（screen-watch 后台）；dsh-pet 只给 recall 1.5 秒，这里最多等 1 秒拿判断：
    //   要看 → 这一句只说「我瞅瞅」，看完的答案随后补上；不用看 → 正常聊；没等到 → 退回「等下我看一眼」的提示。
    let need = null;
    // 挪位置（lib/pet-move.js）：在她回话之前判断（和看屏幕的判断并行，最多等 1.1 秒）。
    // 要挪就让她回话末尾带 dsh-pet 自带的走位动作，由 dsh-pet 自己走（插件不发任何位移指令）。
    const recallStart = Date.now();
    let movePromise = null;
    try { movePromise = onMoveIntent ? Promise.resolve(onMoveIntent(String(userText ?? ''), String(petId))).catch(() => null) : null; } catch {}
    const skipScreen = takeSuppressed(userText);
    try {
      const decision = skipScreen ? null : onUserMessage?.(String(userText ?? ''), { onAnswer: (answer) => recordReply(String(petId), answer) });
      if (decision) need = await Promise.race([decision, new Promise((resolve) => { const t = setTimeout(() => resolve(null), 1000); t.unref?.(); })]);
    } catch {}
    if (skipScreen) need = false;
    let extra = '';
    if (need === true) {
      extra = '【现在】他要你看他的屏幕，你已经在截图看了。这一句只回「我瞅瞅」或同样意思的两三个字（比如「我看看」「瞅一眼」），别的什么都不要说——看完你会自己把答案补上。';
    } else if (need === null) {
      try { extra = String(extraSystem?.() || '').trim(); } catch {}
    }
    let moveHint = '';
    if (movePromise) {
      const decided = await Promise.race([movePromise, new Promise((resolve) => { const t = setTimeout(() => resolve(null), Math.max(0, 1300 - (Date.now() - recallStart))); t.unref?.(); })]);
      if (decided?.action) {
        moveHint = `\n\n【挪位置】他让你挪地方，你已经转过身准备走了。只回一两个字表示收到，比如「好」「行」「ok」「嗯」，**别复述他说的方向或内容**；回复最后一行写 [动作:${decided.action}]（就是你走过去的动作，必须写）。`;
      }
    }
    return { system: `${base}${extra ? `\n\n${extra}` : ''}${moveHint}\n\n【桌宠环境（dsh-pet 动画桌宠）】\n${String(system ?? '').trim()}` };
  }

  async function capture({ petId, userText, replyText, ts } = {}) {
    const c = cfg();
    if (!c.enabled || !c.remember || !c.petIds.includes(String(petId))) return;
    const written = chat.rememberTurn({ userText, replyText, at: Number(ts) || Date.now() });
    if (written > 0) lastCaptureAt = Date.now();
  }

  async function broadcast(text) {
    const c = cfg();
    if (!c.enabled || !c.mirrorProactive) return { ok: false, code: 'disabled' };
    const base = String(currentDshUrl() || '').replace(/\/+$/, '');
    if (!base) { fail('dsh-pet-bridge.no-dsh-url', '找不到 DSH 地址，主动搭话没发到 dsh-pet'); return { ok: false, code: 'no-dsh-url' }; }
    const ids = visiblePetIds();
    if (!ids.length) return { ok: false, code: 'not-visible' };
    let sent = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`${base}${ROUTE}/broadcast?pet=${encodeURIComponent(id)}&surface=any`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: String(text).slice(0, 300), duration: c.bubbleMs }),
          signal: AbortSignal.timeout(5000),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body?.ok === true) sent += 1;
        else fail('dsh-pet-bridge.broadcast-rejected', `pet=${id} HTTP ${res.status} ${body?.reason ?? ''} ${body?.message ?? ''}`.trim());
      } catch (error) {
        fail('dsh-pet-bridge.broadcast-failed', `pet=${id} ${String(error?.message ?? error).slice(0, 120)}（dsh-pet 没装/没启用？）`);
      }
    }
    if (sent) lastMirrorAt = Date.now();
    return { ok: sent > 0, sent };
  }

  function registered() {
    const api = service();
    try { return Boolean(api?.memory?.list?.().external?.includes(PROVIDER_ID)); } catch { return false; }
  }

  /** dsh-pet 可能比我们晚加载、也可能被热重载（它的模块状态会清空），所以定期补注册。 */
  function ensure() {
    const c = cfg();
    if (!c.enabled) {
      if (unregister) { try { unregister(); } catch {} unregister = null; announced = false; pluginLog('[dsh-pet-bridge] 已关闭：dsh-pet 回到它自己的大脑'); }
      return;
    }
    const api = service();
    if (!api?.memory?.register) return;
    if (registered()) return;
    try {
      unregister = api.memory.register({ id: PROVIDER_ID, recall, capture });
      lastError = '';
      if (!announced) pluginLog(`[dsh-pet-bridge] 已接管 dsh-pet 对话（大脑=${c.brain ? 'SurfCore' : '原生'}，记忆=${c.remember ? '写入 SurfCore' : '不写'}，主动搭话镜像=${c.mirrorProactive ? '开' : '关'}，pets=${c.petIds.join(',')}）`);
      announced = true;
    } catch (error) {
      fail('dsh-pet-bridge.register-failed', String(error?.message ?? error));
    }
  }

  function start() {
    if (timer) return;
    removeFrontend = chat.addFrontend({
      id: 'dsh-pet',
      online: () => { const c = cfg(); return c.enabled && c.mirrorProactive && Boolean(service()) && visiblePetIds().length > 0; },
      onProactive: ({ text }) => { void broadcast(text); },
    });
    ensure();
    timer = setInterval(ensure, ENSURE_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try { removeFrontend?.(); } catch {}
    removeFrontend = null;
    try { unregister?.(); } catch {}
    unregister = null;
    announced = false;
  }

  function status() {
    const c = cfg();
    return {
      ...c,
      serviceFound: Boolean(service()),
      registered: registered(),
      visiblePets: visiblePetIds(),
      lastRecallAt,
      lastCaptureAt,
      lastMirrorAt,
      lastError,
    };
  }

  return { start, stop, ensure, status, broadcast, recall, capture, recordReply, suppressScreenFor };
}
