// 私信（专属通道）—— 2026-10-18 主人定：**三条写死在代码里**
//   ① **一天只锁定 1 个收信人**（防刷量；对同一个人发多少条不限 ✓）
//   ② 只发给配置里的 owner.mid（同一个用户，别处发不出去）
//   ④ **带 --share 时占「分享 3 条/天」的额度**（与评论区 @ 共用同一本账 ✓；不带则只是推送，不占额度）
//   ③ 必须互关（relation.attribute === 6），否则拒发
//
// 为什么写死：私信是 B站 风控最凶的接口（判营销/骚扰），而我们要的只是
// "把一条分享私密地送到主人手里"，不是群发工具 ✗ 所以能力越窄越安全 ✓
//
// 用法:
//   node dm.mjs --msg "…" --dry
//   node dm.mjs --msg "…" --go
//   node dm.mjs --status            （看今天额度 + 互关状态）
import { accountBili, biliState, biliStateDir } from '../lib/state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { assertOutboundIdentitySafe } from '../lib/outbound-guard.mjs'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { gate, record } from '../lib/quota-gate.mjs'
import { normalizeLimits } from '../lib/limits.mjs'
import { addPending, chatCapFor, decayedMood, moodLabel, readMood, writeMood } from '../lib/mood.mjs'
import { effectiveMinScore } from '../lib/owner-taste.mjs'
import { loadScores } from '../lib/scores.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const SHARE = !!opt.share       // ④ 分享型：占「分享 3 条/天」额度（与评论区 @ 共用 ✓）
// 分享型的 target 用正文里的 BV 号（"同一视频 7 天一次"才判得准 ✓）；没有就退回 dm:<mid>
const BV = (String(opt.msg ?? "").match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? "";
// ⚠️ SHARE_TARGET 移到 ONLY_TO 定义之后（2026-10-19 修：原先在模块顶层引用 ONLY_TO，触发 TDZ
//    ReferenceError: Cannot access 'ONLY_TO' before initialization → dm.mjs 整个跑不起来，
//    notify 的私信后端也跟着挂 ✗）
const DRY = !!opt.dry
const GO = !!opt.go
if (GO && !assertInteractEnabled('B站私信')) process.exit(3)
const STATUS = !!opt.status
const MSG = String(opt.msg ?? '').trim()
// 2026-10-20（管理员定）：`--to <mid>` = **回复一个给她发过私信的人**（陌生人通道）
//   为什么单独一条路：主人的那条路要互关 + 一天锁定 1 人；陌生人没互关也回得，
//   但只准"回"，不准"主动发" —— 判据是**对方最后一条是找她的**（代码查会话，不靠自觉 ✓）
const TO = String(opt.to ?? '').trim()

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CRED = accountBili('credentials.json')
const QUOTA = biliState('dm-quota.json')
const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'))
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
}
const jget = async (u) => (await fetch(u, { headers: H })).json()
// 私信内容可能是 {"content":"…"} 或纯文本（与 dm-await.mjs 同一份实现）
const parsed = (content) => {
  try { const j = JSON.parse(String(content)); return String(j.content ?? j.text ?? content) } catch { return String(content ?? '') }
}
const loadQ = () => { try { return JSON.parse(fs.readFileSync(QUOTA, 'utf8')) } catch { return {} } }
const saveQ = (o) => { fs.mkdirSync(path.dirname(QUOTA), { recursive: true }); fs.writeFileSync(QUOTA, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')

// ── 写死的三条 ───────────────────────────────────────────────────────
const ONE_TARGET_PER_DAY = true  // ① 一天只锁定 1 个收信人（条数不限 ✓）
const ONLY_TO = OWNER            // ② 只发给主人
const REQUIRE_MUTUAL = true      // ③ 必须互关
// 分享型的 target：优先正文里的 BV（"同一视频 7 天一次"才判得准 ✓），否则退回 dm:<mid>
const SHARE_TARGET = String(opt.target ?? "").trim() || (BV ? ("BV:" + BV) : ("dm:" + String(ONLY_TO)))

async function me() {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
  if (!nav.data?.isLogin) { console.error('✗ 未登录（cookie 失效 ✗）'); process.exit(3) }
  return { mid: String(nav.data.mid), uname: nav.data.uname }
}

async function relation(toMid) {
  const j = await jget(`https://api.bilibili.com/x/relation?fid=${toMid}`)
  if (j.code !== 0) return { ok: false, attribute: -1, why: `关系接口 code=${j.code}` }
  return { ok: true, attribute: Number(j.data?.attribute ?? -1) }
}

async function send(toMid, text) {
  // 出站身份闸（2026-10-23 用户要求：只准自己互认，不许泄露主人和别人的信息）
  // 公开面一旦把主人/别人的 QQ 号或 B站 mid 贴出去就收不回来；提示词只是概率约束，这里是硬拦。
  try {
    assertOutboundIdentitySafe(text, { surface: 'B站 私信' });
  } catch (error) {
    console.error(`\n✗ ${error.message}`);
    process.exit(9);
  }
  const body = new URLSearchParams()
  body.set('msg[sender_uid]', String((await me()).mid))
  body.set('msg[receiver_id]', String(toMid))
  body.set('msg[receiver_type]', '1')
  body.set('msg[msg_type]', '1')
  body.set('msg[msg_status]', '0')
  body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
  body.set('msg[dev_id]', 'WEB-' + crypto.randomUUID().toUpperCase())
  body.set('msg[content]', JSON.stringify({ content: text }))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const j = await r.json().catch(() => ({}))
  return { http: r.status, code: j.code, message: j.message, data: j.data }
}

if (STATUS) {
  const q = loadQ()
  const lockedToday = q.date === today() ? String(q.mid ?? '') : ''
  const rel = await relation(ONLY_TO)
  const meInfo = await me()
  console.log(`账号: ${meInfo.uname}（mid ${meInfo.mid}）`)
  console.log(`专属对象: ${OWNER_NAME}（mid ${ONLY_TO || '未配置'}）`)
  console.log(`今天锁定给: ${lockedToday || '（还没发过）'}${lockedToday && lockedToday !== ONLY_TO ? '  ⚠️ 和当前配置不一致 ✗' : ''}`)
  console.log(`今日已发: ${q.date === today() ? Number(q.count ?? 0) : 0} 条（**条数不限** ✓ 只限收信人 ✓）`)
  console.log(`互关状态: attribute=${rel.attribute} ${rel.attribute === 6 ? '（✓ 互关，可以发）' : '（✗ 不是互关，发不出去）'}`)
  process.exit(0)
}

if (!MSG) { console.error('用法: node dm.mjs --msg "…" [--share --target BV…] --dry|--go   |   --to <mid> --msg "…" --dry|--go   |   --status'); process.exit(2) }

// ══════════════════════════════════════════════════════════════════════════
// 陌生人回复通道（--to <mid>）—— 2026-10-20 加
//   三条硬限制（与主人通道不同，同样写死）：
//     ① **只能回，不能主动发**：会话最后一条必须是对方说的（她自己最后说的 = 已经回过 ✗）
//     ② 同一个人 **一天 3 条**（2026-10-20 管理员从"24 小时 1 条"放宽 ✓）
//     ③ 一天最多 **12 条**（陌生人总量 —— 必须 ≥ 每人上限，否则"每人 3 条"永远用不满 ✗）
//   不要求互关（对方先找的她）；正文 ≤200 字（比主人通道更短）
// ══════════════════════════════════════════════════════════════════════════
if (TO && TO !== OWNER) {
  // 2026-10-20 管理员改：每人每天 3 条（原来是"24 小时 1 条"）
  //   2026-10-21：总量从 12 再放宽到 **30**（总量必须 ≥ 每人上限，否则"每人 3 条"用不满）
  const STRANGER_DAILY = 30        // 一天所有陌生人加起来
  const PER_PERSON_DAILY = 3       // 同一个人一天最多 3 条
  const MAX_LEN = 200
  if (TO === '0' || Number(TO) < 1000) { console.error('✗ 这个 mid 不像真人（系统/官方号不回复）'); process.exit(2) }
  if (MSG.length > MAX_LEN) { console.error(`✗ 回陌生人的私信太长（${MSG.length} > ${MAX_LEN} 字）—— 一两句就够 ✗`); process.exit(2) }
  const meInfo0 = await me()
  if (String(meInfo0.mid) === TO) { console.error('✗ 不能给自己发私信'); process.exit(2) }

  // ① 对方得先找过她（查会话，不查本地缓存 —— 才不会过期 ✓）
  const j = await jget('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web')
  if (j.code !== 0) { console.error(`✗ 查会话失败：code=${j.code} ${j.message ?? ''}`); process.exit(3) }
  const sess = (j.data?.session_list ?? []).find((s) => String(s.talker_id) === TO)
  if (!sess) { console.error(`✗ 她跟 mid ${TO} 没有会话 —— 陌生人通道只能"回"，不能主动发 ✗`); process.exit(4) }
  const last = sess.last_msg ?? {}
  const lastTs = Number(last.timestamp ?? 0)
  if (String(last.sender_uid ?? '') !== TO) {
    console.error('✗ 那个会话最后一条不是对方说的（你已经回过 / 或最后是你自己发的）—— 等对方再说话才回 ✓')
    process.exit(4)
  }
  if (Date.now() / 1000 - lastTs > 48 * 3600) { console.error('✗ 对方那条已经超过 48 小时了 —— 现在回像"突然诈尸"，不回 ✓'); process.exit(4) }

  const q0 = loadQ()
  const replied = (q0.replied && typeof q0.replied === 'object') ? q0.replied : {}
  // 每条回复记一个 ISO 时间戳数组（兼容旧数据：以前存的是**单个字符串**）
  const stampList = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [String(v)] : [])
  const mine = stampList(replied[TO])
  const mineToday = mine.filter((t) => new Date(t).toLocaleDateString('sv-SE') === today()).length
  if (mineToday >= PER_PERSON_DAILY) {
    console.error(`✗ 今天已经回过这个人 ${mineToday} 条了（上限 ${PER_PERSON_DAILY}）—— 剩下的留到明天 ✗`)
    process.exit(4)
  }
  const total = q0.replyDate === today() ? Number(q0.replyTotal ?? 0) : 0
  if (total >= STRANGER_DAILY) { console.error(`✗ 今天已经回了 ${total} 条陌生私信（上限 ${STRANGER_DAILY}）—— 明天的留到明天 ✗`); process.exit(4) }

  const name = String(sess.account_info?.name ?? '')
  console.log(`[dm·回复] ${meInfo0.uname} → ${name || 'mid ' + TO}（${TO}）`)
  console.log(`  对方最后一条：${parsed(last.content).slice(0, 60)}`)
  console.log(`  正文 ${MSG.length} 字：${MSG.slice(0, 80)}${MSG.length > 80 ? '…' : ''}`)
  console.log(`  今天第 ${total + 1}/${STRANGER_DAILY} 条陌生私信 · 这个人今天第 ${mineToday + 1}/${PER_PERSON_DAILY} 条 ✓`)

  if (DRY) { console.log('  [dry] 未发送 ✓ 确认后把 --dry 换成 --go'); process.exit(0) }
  if (!GO) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }

  const rs = await send(TO, MSG)
  if (rs.code !== 0) { console.error(`  ✗ 发送失败：HTTP ${rs.http} code=${rs.code} ${rs.message ?? ''}`); process.exit(1) }
  replied[TO] = [...mine, new Date().toISOString()].slice(-30)   // 只留最近 30 条，别把文件养大
  saveQ({ ...q0, replied, replyDate: today(), replyTotal: total + 1, at: new Date().toISOString() })
  console.log(`  ✓ 已发送（HTTP ${rs.http}）`)
  // 事后报备（不阻塞：失败不影响已发出的私信）
  try {
    execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs'),
      `[回复私信] ${name || TO} 说：${parsed(last.content).slice(0, 60)}\n她回：${MSG.slice(0, 100)}`, '--title', '私信回复报备'],
      { stdio: 'inherit' })
  } catch (e) { console.log(`  [通知] 报备失败（不影响已发出的私信）：${String(e.message).slice(0, 100)}`) }
  process.exit(0)
}

// ── 闸门（写死，不接受参数覆盖）──────────────────────────────────────
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空 —— 私信只发给主人，没配就不发'); process.exit(2) }
if (MSG.length > 300) { console.error(`✗ 私信太长（${MSG.length} > 300 字），退化成刷屏了 ✗`); process.exit(2) }

// ⑤ 闲聊（--chat，2026-11-18 主人定「多在 B站 跟我聊」）：单独一本账，share.chatDaily 句/天（写死在代码里拦，
//    在任何网络请求之前拦，连 --dry 也拦）。
const CHAT = !!opt.chat
const CHAT_DAILY = Math.max(0, Math.min(50, Math.floor(Number(config().share?.chatDaily ?? 0) || 0)))
// 心情（2026-11-18）：不爽时主动闲聊更少（一半 / 两成），开心也不会超过 chatDaily；永远不因为不爽多发。
const MOOD_FILE = biliState('mood.json')
const MOOD_NOW = decayedMood(readMood(MOOD_FILE), Date.now(), config().mood ?? {})
const CHAT_CAP = CHAT_DAILY === 0 ? 0 : chatCapFor(MOOD_NOW, CHAT_DAILY, config().mood ?? {})
// ⑥ 主人通道总上限（2026-11-18 用户定：自动私信我一天最多 10 条，分享/闲聊/报备都算）。
const OWNER_CAP = normalizeLimits(config().limits).ownerDmDaily
// --reply：回主人刚发来的私信，不占上限（上限只管她主动找他）。必须是主人 30 分钟内真发过消息（插件私信监听记的），
//   否则拒 —— 防止把主动私信伪装成回复。
const REPLY = !!opt.reply
if (REPLY) {
  if (CHAT || SHARE) { console.error('✗ [dm.reply-mixed] --reply 不能和 --chat / --share 一起用'); process.exit(2) }
  let lastAt = 0
  try { lastAt = new Date(JSON.parse(fs.readFileSync(biliState('owner-last-dm.json'), 'utf8')).at).getTime() } catch {}
  if (!Number.isFinite(lastAt) || Date.now() - lastAt > 30 * 60 * 1000) {
    console.error('✗ [dm.reply-no-recent] 主人 30 分钟内没给你发过私信 —— 这不是回复；主动找他就去掉 --reply（占每天上限）')
    process.exit(4)
  }
}
{
  const q0 = loadQ()
  const sentToday = q0.date === today() ? Number(q0.count ?? 0) - Number(q0.replyCountDate === today() ? q0.replyCount ?? 0 : 0) : 0
  if (!REPLY && sentToday >= OWNER_CAP) {
    console.error(`✗ [dm.owner-cap] 今天已经私信主人 ${sentToday}/${OWNER_CAP} 条了 —— 到上限了，剩下的写进日记、明天再说 ✗（上限在设置页「B站 → 额度」里调）`)
    process.exit(4)
  }
}
if (CHAT) {
  const q0 = loadQ()
  const usedChat = q0.chatDate === today() ? Number(q0.chatCount ?? 0) : 0
  if (SHARE) { console.error('✗ [dm.chat-and-share] --chat 和 --share 不能同时用 —— 分享走 --share，闲聊走 --chat'); process.exit(2) }
  if (CHAT_CAP === 0) { console.error('✗ [dm.chat-disabled] 闲聊私信没开（share.chatDaily=0）—— 主人在设置页「B站 → 分享」里调'); process.exit(4) }
  if (usedChat >= CHAT_CAP) { console.error(`✗ [dm.chat-cap] 今天已经找他聊了 ${usedChat}/${CHAT_CAP} 句${CHAT_CAP < CHAT_DAILY ? `（心情 ${MOOD_NOW}：${moodLabel(MOOD_NOW, config().mood ?? {})}，所以比平时 ${CHAT_DAILY} 句少）` : ''} —— 剩下的留到明天，别刷屏 ✗`); process.exit(4) }
}
// ⑦ 分享要真到线（2026-11-18）：以前私信分享在代码里不查分，只靠提示；现在查她给这条视频打的分，
//    门槛跟着他对分享的反应走（owner-taste.mjs：回得多降、老不理升，最多 ±2）。
const SHARE_BV = (String(SHARE_TARGET).match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? ''
if (SHARE) {
  const base = Number(config().share?.minScore ?? 13)
  const eff = effectiveMinScore(base, readMood(MOOD_FILE))
  let best = null
  for (const rows of Object.values(loadScores())) for (const r of Array.isArray(rows) ? rows : []) if (r?.bv === SHARE_BV && (best === null || Number(r.score) > best)) best = Number(r.score)
  if (!SHARE_BV) { console.error('✗ [dm.share-no-video] 分享要带视频：--target BV号（或正文里有 BV 链接）'); process.exit(2) }
  if (best === null) { console.error(`✗ [dm.share-unscored] ${SHARE_BV} 还没评分 —— 先 \`score ${SHARE_BV} --fits "…" --funny 0-4 --hooked 0-4 --reason "…"\` 再分享`); process.exit(4) }
  if (best < eff.minScore) { console.error(`✗ [dm.share-score] 这条你打了 ${best} 分，现在的分享门槛是 ${eff.minScore}${eff.offset ? `（平时 ${base}，按他最近对分享的反应调过）` : ''} —— 不够格，别发`); process.exit(4) }
}

const meInfo = await me()
if (String(meInfo.mid) === ONLY_TO) { console.error('✗ 不能给自己发私信'); process.exit(2) }

const rel = await relation(ONLY_TO)
if (!rel.ok) { console.error(`✗ ${rel.why}`); process.exit(3) }
if (REQUIRE_MUTUAL && rel.attribute !== 6) {
  console.error(`✗ 未互关（attribute=${rel.attribute}）—— 私信通道要求双方互相关注 ✓`)
  console.error(`   解决：用她这个号去关注 ${OWNER_NAME}（mid ${ONLY_TO}），再跑一次 ✓`)
  process.exit(4)
}

const q = loadQ()
const used = q.date === today() ? Number(q.count ?? 0) : 0
// ① 一天只锁定 1 个收信人（条数不限 ✓）：如果今天已经发给过别人 → 拒
if (ONE_TARGET_PER_DAY && q.date === today() && q.mid && String(q.mid) !== ONLY_TO) {
  console.error(`✗ 今天已经锁定给 mid ${q.mid} 了 —— 一天只能锁定 1 个收信人（防刷量 ✗）`)
  process.exit(4)
}

console.log(`[dm] ${meInfo.uname} → ${OWNER_NAME}（mid ${ONLY_TO}）`)
console.log(`  正文 ${MSG.length} 字：${MSG.slice(0, 80)}${MSG.length > 80 ? '…' : ''}`)
console.log(`  互关 ✓  ·  今天第 ${used + 1}/${OWNER_CAP} 条（锁定给 ${OWNER_NAME} ✓）`)

if (DRY) { console.log('  [dry] 未发送 ✓ 确认后把 --dry 换成 --go'); process.exit(0) }
if (!GO) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }

const chatUsed = CHAT && q.chatDate === today() ? Number(q.chatCount ?? 0) : 0
// ④ 分享型先过闸（日上限 / 同一视频 7 天一次 / 评分卡 …由 quota 统一管 ✓）
if (SHARE) {
  const ok = gate({ type: 'dm', target: SHARE_TARGET, auto: true, share: true })
  if (!ok) { console.error('✗ 分享额度不允许（见上面的 [限额闸] 输出）'); process.exit(4) }
}
const r = await send(ONLY_TO, MSG)
if (r.code === 0) {
  // 2026-10-20 修：原先整体覆盖会把陌生人通道的 replied / replyDate / replyTotal 抹掉
  //   （每次发主人私信后，陌生人的「24 小时 1 条」「一天 5 条」就被清零 → 形同虚设 ✗）
  //   改为保留已有字段，只更新主人通道自己的计数 ✓
  saveQ({
    ...q, date: today(), count: used + 1, mid: ONLY_TO, at: new Date().toISOString(),
    ...(CHAT ? { chatDate: today(), chatCount: chatUsed + 1 } : {}),
    ...(REPLY ? { replyCountDate: today(), replyCount: (q.replyCountDate === today() ? Number(q.replyCount ?? 0) : 0) + 1 } : {}),
  })
  if (SHARE) record({ type: 'dm', target: SHARE_TARGET, note: MSG.slice(0, 40), auto: true, share: true })
  // 她主动找他的（闲聊 / 分享）记下来等他回：回了心情 +1，几小时没回且他明明在线 -1（插件私信监听结算）。
  if (CHAT || SHARE) { try { writeMood(MOOD_FILE, addPending(readMood(MOOD_FILE), { kind: CHAT ? 'chat' : 'share', target: SHARE ? SHARE_BV : '' })) } catch {} }
  console.log(`  ✓ 已发送（HTTP ${r.http}）${SHARE ? ' · 已记入分享额度 ✓' : CHAT ? ` · 闲聊 ${chatUsed + 1}/${CHAT_CAP} ✓` : ' · 推送不占额度 ✓'}`)
  process.exit(0)
}
console.error(`  ✗ 发送失败：HTTP ${r.http} code=${r.code} ${r.message ?? ''}`)
process.exit(1)
