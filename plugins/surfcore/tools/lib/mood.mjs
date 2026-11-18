/**
 * 心情（2026-11-18 用户：心情一直在变 —— 刷到好视频 / 他发了好笑的 / 他回我了 → 开心，多刷多聊；
 * 刷到垃圾 / 他一直不理我 → 不爽，少刷少说）。
 *
 * 只有这一个状态（B站这边，当前角色的 bili/mood.json），所有功能都读它，谁也不另存一份：
 *   value  -10 ~ +10，0 = 平常；随时间向 0 回落（半衰期 halfLifeHours）。
 *   来源：
 *     · 她自己对他私信内容的判断（mood note，模型定 ±1~2，代码夹住）；
 *     · 视频内容（score.mjs：高分 +1、很烂 -1）；
 *     · 互动（插件私信监听）：他回了她主动发的私信 +1；她主动发的过了几小时没回、且他明明在线（今天找过她）-1。
 *   限速：一小时内累计变化最多 ±maxPerHour，防止一阵刷屏把心情打到底。
 * 影响（都在已有硬上限之内，只会往少里调，永远不会因为不爽去追着他发消息）：
 *   · 刷视频：不刷概率 / 每趟条数（applyEnergyToSlot 里一起掷，一趟只定一次）；
 *   · 主动私信：有效「闲聊上限」= chatDaily × 系数（不爽时更少；开心时就是 chatDaily，不会更多）；
 *   · 说话的劲头：进唤醒/私信提示，叮嘱别把心情说出来、不许抱怨「你怎么不理我」。
 */
import fs from 'node:fs'
import path from 'node:path'

export const MOOD_DEFAULTS = Object.freeze({ enabled: true, halfLifeHours: 4, maxPerHour: 4, maxStep: 2, ignoreAfterHours: 3, ignorePenaltyDaily: 3 })
const CLAMP = 10

export function normalizeMoodConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
  return {
    enabled: c.enabled !== false,
    halfLifeHours: num(c.halfLifeHours, MOOD_DEFAULTS.halfLifeHours, 0.5, 48),
    maxPerHour: num(c.maxPerHour, MOOD_DEFAULTS.maxPerHour, 1, 20),
    maxStep: num(c.maxStep, MOOD_DEFAULTS.maxStep, 1, 5),
    ignoreAfterHours: num(c.ignoreAfterHours, MOOD_DEFAULTS.ignoreAfterHours, 0.5, 24),
    ignorePenaltyDaily: num(c.ignorePenaltyDaily, MOOD_DEFAULTS.ignorePenaltyDaily, 0, 10),
  }
}

const clamp = (v) => Math.max(-CLAMP, Math.min(CLAMP, v))

/** 到 now 为止回落后的心情。 */
export function decayedMood(state = {}, now = Date.now(), cfg = {}) {
  const c = normalizeMoodConfig(cfg)
  const v = Number(state?.value) || 0
  const at = new Date(state?.at ?? now).getTime()
  const hours = Math.max(0, (now - (Number.isFinite(at) ? at : now)) / 3_600_000)
  return Math.round(clamp(v * 0.5 ** (hours / c.halfLifeHours)) * 100) / 100
}

/**
 * 记一次心情变化（纯函数，返回新状态 + 实际变了多少）。
 * kind：dm（他私信的内容）/ video / reply（他回了）/ ignored（没理）/ manual
 */
export function applyMood(state = {}, delta, { now = Date.now(), why = '', kind = 'manual', cfg = {} } = {}) {
  const c = normalizeMoodConfig(cfg)
  const events = Array.isArray(state?.events) ? state.events : []
  if (!c.enabled) return { state: { ...state }, applied: 0, value: decayedMood(state, now, c) }
  let d = Math.max(-c.maxStep, Math.min(c.maxStep, Number(delta) || 0))
  // 一小时内累计变化（绝对值）最多 maxPerHour
  const hourAgo = now - 3_600_000
  const used = events.filter((e) => new Date(e.at).getTime() >= hourAgo).reduce((s, e) => s + Math.abs(Number(e.applied) || 0), 0)
  const room = Math.max(0, c.maxPerHour - used)
  d = Math.sign(d) * Math.min(Math.abs(d), room)
  const before = decayedMood(state, now, c)
  const value = clamp(before + d)
  const applied = Math.round((value - before) * 100) / 100
  const event = { at: new Date(now).toISOString(), kind, delta: Number(delta) || 0, applied, why: String(why).slice(0, 80) }
  return { state: { ...state, value, at: new Date(now).toISOString(), events: [...events, event].slice(-60) }, applied, value }
}

export function moodLabel(v) {
  const n = Number(v) || 0
  if (n >= 5) return '很开心'
  if (n >= 2) return '心情不错'
  if (n > -2) return '平常'
  if (n > -5) return '有点不爽'
  return '闷闷不乐'
}

/** 心情对「不刷」概率的额外调整：不爽更容易不刷（最多 +30%），开心略少（最多 -10%，不低于 0）。 */
export function moodSkipShift(v) {
  const n = Number(v) || 0
  return n < 0 ? (-n / CLAMP) * 0.3 : -(n / CLAMP) * 0.1
}

/** 心情对每趟条数的系数：0.75 ~ 1.25。 */
export function moodVideosFactor(v) {
  return 1 + ((Number(v) || 0) / CLAMP) * 0.25
}

/** 有效闲聊上限：只会往少里调（不爽 → 一半 / 两成），永远不超过 chatDaily。 */
export function chatCapFor(v, chatDaily) {
  const cap = Math.max(0, Math.floor(Number(chatDaily) || 0))
  const n = Number(v) || 0
  if (cap === 0) return 0
  if (n <= -5) return Math.max(1, Math.ceil(cap * 0.2))
  if (n <= -2) return Math.max(1, Math.ceil(cap * 0.5))
  return cap
}

/** 给提示用的一句：怎么刷、怎么说（并叮嘱别说出来、不许抱怨没人理）。 */
export function moodGuidance(v) {
  const label = moodLabel(v)
  const how = {
    很开心: '心情很好：多刷几条，看到好笑的就想找他分享，说话带劲',
    心情不错: '心情不错：照常刷，话可以多一点',
    平常: '平常心',
    有点不爽: '有点不爽：话少一点、短一点，少主动找他；可以有点小脾气，但别阴阳怪气',
    闷闷不乐: '闷闷不乐：少刷少说，不主动找他；他来找你就正常回，最多冷淡一点',
  }[label]
  return { label, how }
}

// ── 文件读写（当前角色的 bili/mood.json）──────────────────────────────────
export function readMood(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { value: 0, at: new Date().toISOString(), events: [], pending: [] } }
}
export function writeMood(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/** 她主动给他发了一条（闲聊/分享）→ 记下来等他回。 */
export function addPending(state = {}, { now = Date.now(), kind = 'chat', target = '' } = {}) {
  // 还在等的都留；有结果的（回了 / 没理）留最近 14 天，给「他对分享的反应」统计用（owner-taste.mjs）。
  const since = now - 14 * 86_400_000
  const pending = (Array.isArray(state.pending) ? state.pending : [])
    .filter((p) => (!p.answered && !p.expired) || new Date(p.at).getTime() >= since)
    .slice(-60)
  return { ...state, pending: [...pending, { at: new Date(now).toISOString(), kind, ...(target ? { target } : {}) }] }
}

/** 他发私信来了：她之前主动发的、还没回的都算「回了」→ +1（一次）。 */
export function ownerReplied(state = {}, { now = Date.now(), cfg = {} } = {}) {
  const pending = Array.isArray(state.pending) ? state.pending : []
  const open = pending.filter((p) => !p.answered && !p.expired)
  const next = { ...state, pending: pending.map((p) => (!p.answered && !p.expired ? { ...p, answered: true } : p)), ownerLastAt: new Date(now).toISOString() }
  if (!open.length) return { state: next, applied: 0 }
  const r = applyMood(next, 1, { now, why: '他回我了', kind: 'reply', cfg })
  return { state: r.state, applied: r.applied }
}

/**
 * 没理她：她主动发的过了 ignoreAfterHours 还没回 → -1。
 * 不冤枉他：他今天（24 小时内）没找过她就当他不在（可能在忙/睡觉），不扣；发出时间在 0~8 点的不算；
 * 一天最多扣 ignorePenaltyDaily。
 */
export function checkIgnored(state = {}, { now = Date.now(), cfg = {} } = {}) {
  const c = normalizeMoodConfig(cfg)
  const pending = Array.isArray(state.pending) ? state.pending : []
  const ownerLast = new Date(state.ownerLastAt ?? 0).getTime()
  const around = Number.isFinite(ownerLast) && now - ownerLast <= 24 * 3_600_000
  const today = new Date(now).toLocaleDateString('sv-SE')
  let penalty = state.ignoreDate === today ? Number(state.ignorePenalty ?? 0) : 0
  let next = { ...state, pending: [...pending] }
  let applied = 0
  next.pending = pending.map((p) => {
    if (p.answered || p.expired) return p
    const at = new Date(p.at).getTime()
    if (now - at < c.ignoreAfterHours * 3_600_000) return p
    const hour = new Date(at).getHours()
    const counts = around && hour >= 8 && penalty < c.ignorePenaltyDaily
    if (counts) penalty += 1
    return { ...p, expired: true, ignoredCounted: counts }
  })
  const counted = next.pending.filter((p, i) => p.ignoredCounted && !pending[i].expired).length
  if (counted > 0) {
    const r = applyMood(next, -counted, { now, why: `发了 ${counted} 条他没回`, kind: 'ignored', cfg })
    next = r.state
    applied = r.applied
  }
  return { state: { ...next, ignoreDate: today, ignorePenalty: penalty }, applied }
}
