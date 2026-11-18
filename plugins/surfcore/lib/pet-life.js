/**
 * 桌宠的「生活」（2026-11-18 用户：①心情上脸 ②她睡桌宠也睡 ③她在 B站 干了啥桌宠有反应）。不调模型、不花 token。
 *
 *   ① 心情：B站 那份心情（bili/mood.json）很开心 → 隔一阵跳个舞 / 吐泡泡；很不爽 → 打哈欠、叹气、东张西望。
 *   ② 睡觉：她作息里「不看=睡着」的那个时段（夜里）→ 用 dsh-pet 自己的睡觉（/sleep：入睡→循环→起来，会说梦话）；
 *      时段结束、或她半夜醒来刷 B站、或你找桌宠说话 → /wake。
 *   ③ B站 反应：她刚评了一条 → 记笔记的小动作；刚给你私信分享了视频 → 雀跃庆祝 + 一句「刚给你发了个视频」。
 * 只对显示在桌面上的宠物生效（/pose 不 ok 就什么都不做）；你刚跟桌宠说过话的几分钟内不打扰。
 * 配置：合体层 `petLife { enabled, moodAnims, sleepWithSchedule, biliReactions, bubbleOnShare }`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWindow, windowContains } from '../tools/lib/time-window.mjs';
import { decayedMood } from '../tools/lib/mood.mjs';

export const HAPPY_ANIMS = ['优雅女仆舞', '轻快摇摆舞', '可爱宅舞', '鲸鱼吐泡泡特效', '凭空生花', '蝴蝶蜜蜂环绕头顶开花', '超大伸懒腰'];
export const SULKY_ANIMS = ['哈欠连天', '打瞌睡被惊醒', '工作状态-垂头叹气冒汗', '东张西望'];
export const SHARE_ANIM = '工作状态-雀跃庆祝';
export const COMMENT_ANIM = '轻快记录';

export function normalizePetLifeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled !== false,
    moodAnims: c.moodAnims !== false,
    sleepWithSchedule: c.sleepWithSchedule !== false,
    biliReactions: c.biliReactions !== false,
    bubbleOnShare: c.bubbleOnShare !== false,
    petId: typeof c.petId === 'string' && c.petId ? c.petId : 'main',
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 现在是不是她的「睡着」时段（作息里 quietSkip 的窗口；周末开了周末作息就用周末那套）。 */
export function inSleepWindow(night = {}, d = new Date()) {
  const weekend = (d.getDay() === 0 || d.getDay() === 6) && night?.weekend?.enabled === true && Array.isArray(night.weekend.windows) && night.weekend.windows.length;
  const windows = weekend ? night.weekend.windows : (Array.isArray(night?.windows) ? night.windows : []);
  const m = d.getHours() * 60 + d.getMinutes();
  return windows.some((w) => {
    if (w?.quietSkip !== true) return false;
    const n = normalizeWindow(w);
    return n.ok && windowContains(n, m);
  });
}

/** 她是不是正醒着刷 B站（生物钟刚叫醒她，40 分钟内）。 */
export function scrollingNow(whaleNight = {}, now = Date.now()) {
  if (whaleNight?.action !== 'wake' || whaleNight?.fired !== true) return false;
  const at = new Date(whaleNight.wokeAt ?? 0).getTime();
  return Number.isFinite(at) && now - at < 40 * 60_000;
}

/** 心情 → 要不要播、播哪个（≥5 开心、≤-4 不爽，中间不播；dsh-pet 自己的待机动作照常）。 */
export function moodAnim(value, random = Math.random) {
  const v = Number(value) || 0;
  const pool = v >= 5 ? HAPPY_ANIMS : v <= -4 ? SULKY_ANIMS : null;
  return pool ? pool[Math.floor(random() * pool.length) % pool.length] : null;
}

/** quota.json 的 log 里，since 之后她新发的（分享优先）。 */
export function newBiliEvents(quota = {}, since = 0) {
  const log = Array.isArray(quota?.log) ? quota.log : [];
  return log
    .filter((r) => new Date(r?.at ?? 0).getTime() > since)
    .map((r) => ({ at: new Date(r.at).getTime(), kind: r.share ? 'share' : r.type === 'comment' ? 'comment' : 'other' }))
    .filter((e) => e.kind !== 'other');
}

export function createPetLife({
  readConfig,
  readNight = () => ({}),
  biliDir,
  currentDshUrl,
  lastChatAt = () => 0,
  broadcast = async () => ({ ok: false }),
  pluginLog = () => {},
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const cfg = () => { try { return normalizePetLifeConfig(readConfig()); } catch { return normalizePetLifeConfig({}); } };
  const state = { sleeping: false, sleptAt: 0, lastMoodAnimAt: now(), nextMoodGapMs: 30 * 60_000, lastEventAt: now(), last: '' };
  let timer = null;
  let busy = false;
  const base = () => String(currentDshUrl() || '').replace(/\/+$/, '');
  const dir = () => (typeof biliDir === 'function' ? biliDir() : biliDir);

  async function call(route, body) {
    const res = await fetchImpl(`${base()}/dsh-pet-7340${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(4000),
    });
    return res.json().catch(() => ({ ok: false }));
  }

  async function tick() {
    const c = cfg();
    if (!c.enabled || busy) return;
    busy = true;
    try {
      const q = `pet=${encodeURIComponent(c.petId)}`;
      const pose = await call(`/pose?${q}`);
      if (pose?.ok !== true) { state.last = 'not-on-desktop'; return; }
      const t = now();
      const talkedRecently = t - (Number(lastChatAt()) || 0) < 10 * 60_000;

      // ② 睡觉
      if (c.sleepWithSchedule) {
        const night = readNight() ?? {};
        const shouldSleep = inSleepWindow(night, new Date(t)) && !scrollingNow(readJson(path.join(dir(), 'whale-night.json'), {}), t) && !talkedRecently;
        if (shouldSleep && (!state.sleeping || t - state.sleptAt > 30 * 60_000)) {
          const r = await call(`/sleep?${q}`, {});
          if (r?.ok) { if (!state.sleeping) pluginLog('[pet-life] 她睡了（作息里的睡觉时段）'); state.sleeping = true; state.sleptAt = t; }
        } else if (!shouldSleep && state.sleeping) {
          const r = await call(`/wake?${q}`, {});
          if (r?.ok) { state.sleeping = false; pluginLog('[pet-life] 她醒了'); }
        }
      }
      if (state.sleeping) return;

      // ③ B站 反应（分享优先，一次只演一个）
      if (c.biliReactions) {
        const events = newBiliEvents(readJson(path.join(dir(), 'quota.json'), {}), state.lastEventAt);
        if (events.length) {
          state.lastEventAt = Math.max(...events.map((e) => e.at));
          const share = events.find((e) => e.kind === 'share');
          await call(`/anim?${q}`, { name: share ? SHARE_ANIM : COMMENT_ANIM });
          if (share && c.bubbleOnShare) await broadcast('刚给你发了个视频 去B站看');
          state.last = share ? 'bili-share' : 'bili-comment';
          return;
        }
      }

      // ① 心情（隔 25~45 分钟看一次，你刚说过话不打扰）
      if (c.moodAnims && !talkedRecently && t - state.lastMoodAnimAt >= state.nextMoodGapMs) {
        state.lastMoodAnimAt = t;
        state.nextMoodGapMs = (25 + Math.floor(random() * 21)) * 60_000;
        const value = decayedMood(readJson(path.join(dir(), 'mood.json'), {}), t);
        const name = moodAnim(value, random);
        if (name) { await call(`/anim?${q}`, { name }); state.last = `mood:${name}`; }
      }
    } catch (error) {
      state.last = `error: ${String(error?.message ?? error).slice(0, 80)}`;
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, 60_000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() { return { ok: true, config: cfg(), sleeping: state.sleeping, last: state.last }; }
  return { start, stop, tick, status, _state: state };
}
