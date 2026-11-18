/**
 * 生物钟的「一天排程」纯逻辑（2026-10-23 用户选 C）。
 *
 * C 的含义：
 *   · 每个有次数的窗口**至少 1 次**（保证覆盖）；
 *   · 全天总次数 ≤ maxWakes（默认 12）；
 *   · 多出来的次数按「该时段最近的内容评分」分给质量更高的窗口；
 *   · 相邻两次苏醒至少隔 minGapMin 分钟（默认 20）；
 *   · skip 只是这个 slot 的「轻醒」，不结束全天；
 *   · 超过窗口 end 的 slot 记为 missed，不补醒。
 *
 * 这个文件只做纯计算，方便单测；whale-night.mjs 负责读写状态和叫醒。
 */

import { normalizeWindow, parseClock, windowContains as sharedWindowContains } from './time-window.mjs'
import { moodSkipShift, moodVideosFactor } from './mood.mjs'

export const DEFAULT_MIN_GAP_MIN = 20

export function hhmmToMin(value) {
  const parsed = parseClock(value, { allow24: true })
  // 保持旧 API：非法值返回 0；真正排程用 normalizeNightWindows 过滤，不会把它当成 0 点窗口。
  return parsed == null ? 0 : parsed
}

export function minToHHMM(min) {
  const n = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

/**
 * 每个窗口可选的「作息性格」（2026-11-18 用户：白天狂刷、夜里睡觉偶尔醒）：
 *   skipChance 这个窗口里每一趟「不看」的概率（缺省用全局 night.skipChance）；
 *   maxVideos  这个窗口里每一趟初筛几条（缺省用全局 night.maxVideos）；
 *   quietSkip  true = 掷到「不看」就真睡着：不叫醒、不写日记、不私信（缺省 false = 轻醒写日记）。
 */
export function windowExtras(raw) {
  const out = {}
  const skip = Number(raw?.skipChance)
  if (raw?.skipChance !== undefined && raw?.skipChance !== null && raw?.skipChance !== '' && Number.isFinite(skip)) out.skipChance = Math.max(0, Math.min(1, skip))
  const videos = Number(raw?.maxVideos)
  if (raw?.maxVideos !== undefined && raw?.maxVideos !== null && raw?.maxVideos !== '' && Number.isFinite(videos)) out.maxVideos = Math.max(1, Math.min(30, Math.round(videos)))
  if (raw?.quietSkip === true) out.quietSkip = true
  return out
}

/** 把配置窗口收敛成 [start,end) 分钟；end <= start 视为跨午夜，end += 1440。 */
export function normalizeNightWindows(windows = []) {
  const list = Array.isArray(windows) && windows.length
    ? windows
    : [{ start: '20:00', end: '24:00', wakes: 1 }]
  const out = []
  for (const raw of list) {
    // whale-night.mjs 传进来的是已经换算成分钟的窗口（start:0,end:1440…）。parseClock 只认 "HH:MM"，
    // 以前这些全被判非法 → 永远退回 20:00–24:00×1（用户设的全天 12 次从没生效，2026-11-18 查出）。
    if (Number.isFinite(raw?.start) && Number.isFinite(raw?.end) && raw.end > raw.start) {
      out.push({
        start: raw.start,
        end: raw.end,
        wrap: raw.wrap ?? raw.end > 1440,
        label: raw.label ?? `${minToHHMM(raw.start)}–${raw.end === 1440 ? '24:00' : minToHHMM(raw.end)}`,
        wakes: Math.max(0, Math.min(12, Math.floor(Number(raw.wakes ?? 1) || 0))),
        ...windowExtras(raw),
      })
      continue
    }
    const normalized = normalizeWindow(raw)
    if (!normalized.ok) continue
    out.push({
      start: normalized.start,
      end: normalized.end,
      wrap: normalized.wrap,
      label: raw?.label ?? normalized.label,
      wakes: normalized.wakes,
      ...windowExtras(raw),
    })
  }
  if (!out.length) {
    const fallback = normalizeWindow({ start: '20:00', end: '24:00', wakes: 1 })
    if (fallback.ok) out.push({ ...fallback, label: fallback.label })
  }
  return out
}

/** 某个分钟是否落在窗口内（支持跨午夜）。 */
export function windowContains(w, min) {
  return sharedWindowContains(w, min)
}

/**
 * 按最近 N 天的评分，算每个窗口的平均内容质量。
 * 没有评分的窗口不返回（调用方按 0 处理）。
 * @param {Record<string, Array<{at?:string, score?:number}>>} scores
 */
export function qualityByWindow(scores = {}, windows = [], { now = Date.now(), days = 30 } = {}) {
  const cutoff = Number(now) - Math.max(1, Number(days) || 30) * 86_400_000
  const acc = new Map()
  for (const rows of Object.values(scores ?? {})) {
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      const at = new Date(row?.at ?? 0).getTime()
      const score = Number(row?.score)
      if (!Number.isFinite(at) || at < cutoff || !Number.isFinite(score)) continue
      const d = new Date(at)
      const minute = d.getHours() * 60 + d.getMinutes()
      const w = windows.find((x) => windowContains(x, minute))
      if (!w) continue
      const cur = acc.get(w.label) ?? { sum: 0, count: 0 }
      cur.sum += score
      cur.count += 1
      acc.set(w.label, cur)
    }
  }
  const out = {}
  for (const [label, { sum, count }] of acc) out[label] = count ? sum / count : 0
  return out
}

/**
 * 生成一天 slots。
 * @param {object} opts
 * @param {Array} opts.windows 配置窗口
 * @param {number} opts.maxWakes 全天硬上限（C 默认 12）
 * @param {number} opts.minGapMin 相邻两次苏醒最小间隔（默认 20）
 * @param {number} opts.skipChance “轻醒”概率
 * @param {number} opts.nowMin 当前本地分钟（0~1439）
 * @param {Record<string,number>} opts.quality 每个窗口的历史质量
 * @param {() => number} opts.random
 */
export function buildNightSchedule({
  windows = [],
  maxWakes = 12,
  minGapMin = DEFAULT_MIN_GAP_MIN,
  skipChance = 0.3,
  nowMin = 0,
  quality = {},
  random = Math.random,
} = {}) {
  const wins = normalizeNightWindows(windows)
  const warnings = []
  const cap = Math.max(0, Math.min(12, Math.floor(Number(maxWakes) || 0)))
  const gap = Math.max(0, Math.floor(Number(minGapMin) || 0))
  const now = Number(nowMin) || 0
  const enabled = wins.filter((w) => w.wakes > 0)
  // 已经结束的窗口今天不补；只给还没结束的窗口排（跨午夜窗口保持开放）。
  const open = enabled.filter((w) => (w.wrap ? true : w.end > now))
  if (enabled.length > open.length) {
    warnings.push(`有 ${enabled.length - open.length} 个窗口今天已经结束，不再补醒`)
  }

  // C：先保证每个窗口 1 次；如果窗口数 > cap，只能覆盖前 cap 个，明确警告。
  const baseWins = open.slice(0, cap)
  if (open.length > cap) {
    warnings.push(`窗口数 ${open.length} > 全天上限 ${cap}，无法每窗至少 1 次；只覆盖前 ${cap} 个窗口`)
  }
  const counts = new Map(baseWins.map((w) => [w.label, 1]))
  let remaining = Math.max(0, cap - baseWins.length)

  // 多出来的次数按质量分给容量还够的窗口；质量相同优先晚时段（prime time）。
  const order = [...baseWins].sort((a, b) => {
    const qa = Number(quality[a.label] ?? 0)
    const qb = Number(quality[b.label] ?? 0)
    if (qb !== qa) return qb - qa
    return b.start - a.start
  })
  while (remaining > 0) {
    let picked = false
    for (const w of order) {
      if (remaining <= 0) break
      if ((counts.get(w.label) ?? 0) >= w.wakes) continue
      // 质量优先：同一个高质量窗口先吃满，再轮到下一个。
      while (remaining > 0 && (counts.get(w.label) ?? 0) < w.wakes) {
        counts.set(w.label, (counts.get(w.label) ?? 0) + 1)
        remaining -= 1
      }
      picked = true
    }
    if (!picked) break
  }
  if (remaining > 0) warnings.push(`还有 ${remaining} 个额外名额没有任何窗口容量可放`)

  const slots = []
  let lastAt = -Infinity
  let id = 0
  const sorted = [...baseWins].sort((a, b) => a.start - b.start)
  for (const w of sorted) {
    const count = counts.get(w.label) ?? 0
    if (!count) continue
    const span = Math.max(1, w.end - w.start)
    const seg = Math.max(1, span / Math.max(1, count))
    for (let i = 0; i < count; i += 1) {
      const desired = w.start + i * seg + random() * seg
      let at = Math.max(w.start, desired)
      if (Number.isFinite(lastAt)) at = Math.max(at, lastAt + gap)
      // 已经过了窗口：这个窗口今天不补（C 的“不补醒”）
      if (w.end <= now) continue
      // 现在已在窗口内但点已经过去：现在就叫醒（晚到但在窗口内）
      if (at < now && now < w.end) at = now + 1
      // 放不下：base 必须保；extra 丢掉；两者都记 warning
      if (at >= w.end) {
        if (i === 0) {
          const fallback = Math.max(w.start, Math.min(w.end - 1, Number.isFinite(lastAt) ? lastAt + gap : w.start))
          at = fallback
          if (Number.isFinite(lastAt) && at < lastAt + gap) {
            warnings.push(`${w.label} 的保底 slot 放不下 ${gap} 分钟间隔，已压缩到 ${minToHHMM(at)}`)
          }
        } else {
          warnings.push(`${w.label} 的第 ${i + 1} 次和前面的间隔冲突，已跳过（C 只保每窗至少 1 次）`)
          continue
        }
      }
      if (at < now && now < w.end) at = now + 1
      const p = w.skipChance ?? Number(skipChance ?? 0.3)
      const skip = random() < p
      slots.push({
        id: `s${id += 1}`,
        window: w.label,
        start: w.start,
        end: w.end,
        at,
        atText: minToHHMM(at),
        kind: i === 0 ? 'base' : 'extra',
        index: i,
        action: skip ? 'skip' : 'wake',
        status: 'pending',
        gapMin: gap,
        skipChance: p,
        ...(w.maxVideos ? { maxVideos: w.maxVideos } : {}),
        ...(w.quietSkip ? { quietSkip: true } : {}),
      })
      lastAt = Math.max(lastAt, at)
    }
  }
  slots.sort((a, b) => a.at - b.at)

  if (slots.length < baseWins.length) {
    warnings.push(`本应至少 ${baseWins.length} 次，实际排了 ${slots.length} 次（时间/间隔冲突）`)
  }
  return {
    slots,
    warnings,
    cap,
    minGapMin: gap,
    baseCount: baseWins.length,
    extraCount: Math.max(0, slots.length - baseWins.length),
  }
}

/** 取下一个 pending slot；过期 slot 标 missed；窗口内已过点的改成“现在叫醒”。 */
export function nextPendingSlot(schedule, nowMin) {
  const now = Number(nowMin) || 0
  for (const slot of schedule?.slots ?? []) {
    if (slot.status !== 'pending') continue
    if (Number(slot.end) <= now) {
      slot.status = 'missed'
      slot.missedAt = now
      continue
    }
    if (Number(slot.at) < now && now < Number(slot.end)) {
      slot.at = now + 1
      slot.atText = minToHHMM(slot.at)
      slot.late = true
    }
    if (Number(slot.at) >= Number(slot.end)) {
      slot.status = 'missed'
      slot.missedAt = now
      continue
    }
    return slot
  }
  return null
}

export function markScheduleSlot(schedule, id, status, nowMin = Date.now()) {
  const slot = (schedule?.slots ?? []).find((x) => x.id === id)
  if (!slot) return null
  slot.status = status
  if (status === 'fired' || status === 'skipped') slot.doneAt = nowMin
  if (status === 'missed') slot.missedAt = nowMin
  return slot
}

// ── 精力 / 心情（2026-11-18 用户：像真人 —— 刷久了会累，累了更容易不刷、刷得少）─────────
// 只按「今天真刷过的趟」算：一天从 start 开始，每真刷一趟扣 maxVideos×costPerVideo，两趟之间每小时回 recoverPerHour。
// 轻醒 / 睡着 / 错过 都不扣。纯函数，方便单测。
export const ENERGY_DEFAULTS = Object.freeze({ enabled: true, strength: 0.5, costPerVideo: 2.2, recoverPerHour: 10, start: 100 })

export function normalizeEnergy(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
  return {
    enabled: c.enabled !== false,
    strength: num(c.strength, ENERGY_DEFAULTS.strength, 0, 1),
    costPerVideo: num(c.costPerVideo, ENERGY_DEFAULTS.costPerVideo, 0, 10),
    recoverPerHour: num(c.recoverPerHour, ENERGY_DEFAULTS.recoverPerHour, 0, 100),
    start: num(c.start, ENERGY_DEFAULTS.start, 0, 100),
  }
}

/** 到 nowMin 为止的精力（0~100）。 */
export function energyAt(slots = [], nowMin = 0, opts = {}) {
  const o = normalizeEnergy(opts)
  let e = o.start
  let t = 0
  const done = (Array.isArray(slots) ? slots : [])
    .filter((s) => s && s.status === 'fired' && s.action === 'wake')
    .map((s) => ({ at: Number(s.doneAt ?? s.at), videos: Number(s.maxVideos) || 5 }))
    .filter((s) => Number.isFinite(s.at) && s.at <= nowMin)
    .sort((a, b) => a.at - b.at)
  for (const s of done) {
    e = Math.min(100, e + ((s.at - t) / 60) * o.recoverPerHour)
    e = Math.max(0, e - s.videos * o.costPerVideo)
    t = s.at
  }
  e = Math.min(100, e + ((nowMin - t) / 60) * o.recoverPerHour)
  return Math.round(e)
}

export function moodOf(energy) {
  const e = Number(energy)
  if (e >= 75) return '来劲'
  if (e >= 50) return '正常'
  if (e >= 25) return '有点累'
  return '累瘫'
}

/** 累了「额外」不刷的概率（叠在窗口本身的不看概率之外）：精力 ≥60 不加；越累越高，最多 strength。 */
export function tiredSkipChance(energy, strength = ENERGY_DEFAULTS.strength) {
  const e = Number(energy)
  if (!Number.isFinite(e) || e >= 60) return 0
  return Math.min(0.95, ((60 - e) / 60) * Math.max(0, Math.min(1, Number(strength) || 0)))
}

/** 累了少刷几条：精力 ≥50 照原数；更低按比例减，最少 3 条。 */
export function tiredVideos(videos, energy) {
  const v = Math.max(1, Math.round(Number(videos) || 5))
  const e = Number(energy)
  if (!Number.isFinite(e) || e >= 50) return v
  return Math.max(Math.min(3, v), Math.round(v * (0.4 + (e / 50) * 0.6)))
}

/** 固定种子的 0~1 随机数：同一天同一趟只掷一次，重算计划结果不变。 */
export function seededRandom(seed) {
  let h = 2166136261
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/**
 * 轮到这一趟时按当下精力定一次（只定一次，写回 slot）：累了可能改成「不刷」（安静地不刷，不私信），或少刷几条。
 * 返回被改写的 slot。
 */
export function applyEnergyToSlot(schedule, slot, { date = '', nowMin = 0, energy: energyCfg = {}, defaultVideos = 5, moodValue = 0 } = {}) {
  if (!slot || slot.energyApplied) return slot
  const o = normalizeEnergy(energyCfg)
  const e = energyAt(schedule?.slots ?? [], Math.max(Number(slot.at) || 0, Number(nowMin) || 0), o)
  const mv = Number(moodValue) || 0
  slot.energy = e
  slot.mood = moodOf(e)
  slot.moodValue = mv
  slot.energyApplied = true
  if (slot.action !== 'wake') return slot
  // 累（精力）+ 不爽（心情）都会让她更可能不刷；开心略少不刷。同一个种子，一趟只掷一次。
  const tiredP = o.enabled ? tiredSkipChance(e, o.strength) : 0
  const p = Math.max(0, Math.min(0.95, tiredP + (mv < 0 ? moodSkipShift(mv) : 0)))
  if (p > 0 && seededRandom(`${date}|${slot.id}|tired`) < p) {
    slot.action = 'skip'
    slot.tired = tiredP > 0
    slot.sulky = mv < 0
    slot.quietSkip = true
    return slot
  }
  let videos = slot.maxVideos ?? defaultVideos
  if (o.enabled && e < 50) videos = tiredVideos(videos, e)
  if (mv !== 0) videos = Math.max(1, Math.min(30, Math.round(videos * moodVideosFactor(mv))))
  if (videos !== (slot.maxVideos ?? defaultVideos)) slot.maxVideos = videos
  return slot
}
