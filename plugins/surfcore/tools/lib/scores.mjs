// 当天"评分账"（2026-10-21 加，为「每天一条动态」服务）
//
// 为什么单独一个文件：分享只看第一名且过没过线；动态要的是**当天评分最高的那条**，
//   哪怕它没到分享阈值（13）—— 所以得把每次打分都记下来，而不是只记发出去的。
//
// 数据：~/.dsh/surfcore/bili/scores.json
//   { "2026-10-21": [ { bv, score, reason, title, at } ] }
// 同一天同一个 BV 重复打分 → 取**最高分**（不重复堆条目 ✓）
import { accountBili, biliState, biliStateDir } from './state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const FILE = biliState('scores.json')
export const today = () => new Date().toLocaleDateString('sv-SE')

export function loadScores() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} }
}

export function saveScores(all) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2) + '\n')
  } catch {}
}

/** 她给这条视频记过的最高分（近 14 天）；没评过 → null。分享类命令都用这个，不信传进来的数。 */
export function recordedScore(bv) {
  let best = null
  for (const rows of Object.values(loadScores())) for (const r of Array.isArray(rows) ? rows : []) if (r?.bv === bv && (best === null || Number(r.score) > best)) best = Number(r.score)
  return best
}

/** 记一次打分（同 BV 同日取最高） */
export function recordScore({ bv, score, reason = '', title = '', up = '', mid = '', items = null, fits = null, dislikes = null, tname = '' }) {
  // 2026-11-18：分项（标尺 lib/score-rubric.mjs）一起存，score 仍是总分（老读者不受影响）
  const detail = { ...(items ? { items } : {}), ...(fits ? { fits } : {}), ...(dislikes?.length ? { dislikes } : {}), ...(tname ? { tname: String(tname).slice(0, 20) } : {}) }
  const all = loadScores()
  const day = today()
  const list = Array.isArray(all[day]) ? all[day] : []
  const prev = list.find((x) => x.bv === bv)
  if (prev) {
    if (Number(score) > Number(prev.score ?? 0)) Object.assign(prev, { score: Number(score), reason, at: new Date().toISOString(), ...detail })
    if (mid && !prev.mid) Object.assign(prev, { mid: String(mid), up: String(up ?? '').slice(0, 40) })
  } else {
    list.push({ bv, score: Number(score), reason: String(reason ?? '').slice(0, 120), title: String(title ?? '').slice(0, 120), ...(mid ? { mid: String(mid), up: String(up ?? '').slice(0, 40) } : {}), ...detail, at: new Date().toISOString() })
  }
  all[day] = list
  // 只留最近 14 天，别把文件养大
  const keep = Object.keys(all).sort().slice(-14)
  const trimmed = {}
  for (const k of keep) trimmed[k] = all[k]
  saveScores(trimmed)
  return trimmed[day]
}

/** 今天的全部评分（按分数从高到低） */
export function todayScores() {
  const list = loadScores()[today()]
  return Array.isArray(list) ? [...list].sort((a, b) => Number(b.score) - Number(a.score)) : []
}

/** 今天评分最高的那条（没有就 null） */
export function bestToday() {
  return todayScores()[0] ?? null
}
