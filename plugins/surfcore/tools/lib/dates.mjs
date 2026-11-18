/**
 * 他说过的日子（2026-11-18 用户：记住生日 / 考试之类，到那天说一句）。
 * 存在当前角色 bili/dates.json；她在私信里听到就 `dates add`（必须是他 48 小时内真私信过 = 有出处）。
 * 到期提醒：B站唤醒提示（今天 / 明天）+ 桌宠的 system prompt（同一份）。一年一次的（生日）每年都提醒。
 */
import fs from 'node:fs'
import path from 'node:path'

export const MAX_DATES = 50

export function readDates(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j?.items) ? j.items : [] } catch { return [] }
}
export function writeDates(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, items: items.slice(-MAX_DATES) }, null, 2)}\n`)
  fs.renameSync(`${file}.tmp`, file)
}

/** 'YYYY-MM-DD' 或 'MM-DD'（一年一次）→ { when, yearly } 或 null。 */
export function parseWhen(raw, { yearly = false } = {}) {
  const s = String(raw ?? '').trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (d.getMonth() !== Number(m[2]) - 1) return null
    return { when: d.toLocaleDateString('sv-SE'), yearly: Boolean(yearly) }
  }
  m = /^(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) {
    const mm = Number(m[1]); const dd = Number(m[2])
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
    return { when: `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, yearly: true }
  }
  return null
}

/** 今天 / 明天到期的（本机日期）。 */
export function dueDates(items = [], now = new Date()) {
  const fmt = (d) => d.toLocaleDateString('sv-SE')
  const today = fmt(now)
  const tomorrow = fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const md = (s) => s.slice(5)
  const out = []
  for (const it of items) {
    const w = String(it.when ?? '')
    const hit = (day) => (it.yearly ? (w.length === 5 ? w : md(w)) === md(day) : w === day)
    if (hit(today)) out.push({ ...it, due: 'today' })
    else if (hit(tomorrow)) out.push({ ...it, due: 'tomorrow' })
  }
  return out
}

export function dueLines(items = [], now = new Date()) {
  const due = dueDates(items, now)
  if (!due.length) return []
  return [
    '【他说过的日子】',
    ...due.map((d) => `   · ${d.due === 'today' ? '今天' : '明天'}是他说过的「${d.what}」${d.yearly ? '（每年这天）' : ''}`),
    '   → 记得的话像兄弟那样提一句（"明天考试了吧 稳住"），别像日历提醒；他没提过细节就别编',
  ]
}
