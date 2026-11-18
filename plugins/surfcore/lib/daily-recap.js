/**
 * 一天的回顾（2026-11-18 用户：晚上让她随口说一句今天在 B站 刷到了啥）。
 *
 * 每天本机时间到 `at`（默认 22:30）后，读她今天 B站 这边的事实（评分最高的几条、收藏、出去逛的方向），
 * 用桌宠同一个大脑（人格卡）让她说一两句，像兄弟随口一提；发到桌宠（会镜像到 dsh-pet）。
 *   · 一天最多一次，日期记在 state 文件里（DSH 重启不会重发）；今天没刷就不说。
 *   · 这一句会进桌宠记忆（他接着问「哪个视频」能接上）—— 只有这一句跨到桌宠那边，B站记忆本身不合并。
 *   · 先过 token 额度（其他类）；失败记 lastError，GET /recap/status 能看到。
 * 配置：合体层 `dailyRecap { enabled, at }`。
 */
import fs from 'node:fs';
import path from 'node:path';

export function normalizeDailyRecapConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(c.at ?? '').trim()) ? String(c.at).trim() : '22:30';
  return { enabled: c.enabled !== false, at };
}

const localDate = (d) => d.toLocaleDateString('sv-SE');
const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 今天 B站 这边的事实（纯读文件）。biliDir = 当前角色的 B站 数据目录。 */
export function collectBiliDay(biliDir, date) {
  const scoresAll = readJson(path.join(biliDir, 'scores.json'), {});
  const scores = (Array.isArray(scoresAll?.[date]) ? scoresAll[date] : [])
    .filter((r) => r && Number.isFinite(Number(r.score)))
    .sort((a, b) => Number(b.score) - Number(a.score));
  const favs = (readJson(path.join(biliDir, 'favorites.json'), {})?.items ?? [])
    // at 是 UTC 的 ISO 串：换成本机日期再比（太平洋时间晚上收藏的，UTC 已经是第二天）
    .filter((x) => x && x.at && localDate(new Date(x.at)) === date);
  const explores = (readJson(path.join(biliDir, 'explore-log.json'), {})?.entries ?? [])
    .filter((e) => e?.date === date).map((e) => e.term);
  return {
    date,
    watched: scores.length,
    top: scores.slice(0, 3).map((r) => ({ title: String(r.title ?? r.bv ?? ''), score: Number(r.score), reason: String(r.reason ?? '').slice(0, 60) })),
    favs: favs.slice(0, 3).map((x) => String(x.title ?? x.bv ?? '')),
    explores: [...new Set(explores)].slice(0, 3),
  };
}

export function buildRecapPrompt(facts) {
  const lines = [
    `今天（${facts.date}）你在 B站 刷到的（只用这些，别编）：`,
    ...facts.top.map((t, i) => `${i + 1}. 「${t.title}」你打了 ${t.score}/20${t.reason ? `：${t.reason}` : ''}`),
  ];
  if (facts.favs.length) lines.push(`你收藏了：${facts.favs.map((t) => `「${t}」`).join('、')}`);
  if (facts.explores.length) lines.push(`今天你特意去逛了：${facts.explores.join('、')}`);
  return lines.join('\n');
}

/** 周日：最近 7 天（本机日期）的口味变化 —— 评分最高的几条、逛过的方向和战绩、收藏。 */
export function collectBiliWeek(biliDir, endDate) {
  const end = new Date(`${endDate}T12:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => localDate(new Date(end.getTime() - i * 86_400_000)));
  const scoresAll = readJson(path.join(biliDir, 'scores.json'), {});
  const rows = dates.flatMap((d) => (Array.isArray(scoresAll?.[d]) ? scoresAll[d] : []))
    .filter((r) => r && Number.isFinite(Number(r.score)));
  const sorted = [...rows].sort((a, b) => Number(b.score) - Number(a.score));
  const favs = (readJson(path.join(biliDir, 'favorites.json'), {})?.items ?? [])
    .filter((x) => x?.at && dates.includes(localDate(new Date(x.at))));
  const explores = (readJson(path.join(biliDir, 'explore-log.json'), {})?.entries ?? []).filter((e) => dates.includes(e?.date));
  const byTerm = new Map();
  for (const e of explores) {
    const cur = byTerm.get(e.term) ?? { term: e.term, scores: [] };
    for (const bv of e.bvs ?? []) { const hit = rows.find((r) => r.bv === bv); if (hit) cur.scores.push(Number(hit.score)); }
    byTerm.set(e.term, cur);
  }
  return {
    from: dates[6], to: dates[0],
    watched: rows.length,
    avg: rows.length ? Math.round((rows.reduce((s, r) => s + Number(r.score), 0) / rows.length) * 10) / 10 : null,
    top: sorted.slice(0, 3).map((r) => ({ title: String(r.title ?? r.bv ?? ''), score: Number(r.score) })),
    worst: sorted.length > 3 ? { title: String(sorted.at(-1).title ?? sorted.at(-1).bv ?? ''), score: Number(sorted.at(-1).score) } : null,
    explores: [...byTerm.values()].map((t) => ({ term: t.term, avg: t.scores.length ? Math.round((t.scores.reduce((a, b) => a + b, 0) / t.scores.length) * 10) / 10 : null })),
    favs: favs.slice(0, 3).map((x) => String(x.title ?? x.bv ?? '')),
  };
}

export function buildWeeklyPrompt(w) {
  const lines = [`这周（${w.from} ~ ${w.to}）你在 B站 刷的（只用这些，别编）：评了 ${w.watched} 条${w.avg === null ? '' : `，平均 ${w.avg} 分`}`];
  for (const t of w.top) lines.push(`· 最对胃口：「${t.title}」${t.score}/20`);
  if (w.worst) lines.push(`· 最烂：「${w.worst.title}」${w.worst.score}/20`);
  for (const e of w.explores) lines.push(`· 你特意去逛了「${e.term}」${e.avg === null ? '（还没评分）' : `，平均 ${e.avg} 分`}`);
  if (w.favs.length) lines.push(`· 收藏了：${w.favs.map((t) => `「${t}」`).join('、')}`);
  return lines.join('\n');
}

export const WEEKLY_INSTRUCTION = [
  '【现在】周日晚上了，你随口跟他说说这周刷 B站 的口味变化 —— 最近老刷到啥、什么腻了、新迷上了啥。',
  '2~3 句、一共不超过 60 字，像兄弟闲聊，不要周报腔、不要列数字清单。只输出你要说的话。',
].join('\n');

export const RECAP_INSTRUCTION = [
  '【现在】晚上了，你随口跟他提一句今天在 B站 刷到的东西。',
  '挑你最想说的那一条（最离谱 / 最好笑 / 最对胃口），1~2 句、一共不超过 40 字，像兄弟顺嘴一说。',
  '不要总结腔、不要「今天我刷了 X 条」、不要列清单、不要问他要不要看；标题太长就用你自己的话说是啥。',
  '只输出你要说的那句话。',
].join('\n');

export function createDailyRecap({ chat, readConfig, biliDir, stateDir, tokenBudget = null, pluginLog = () => {}, now = () => new Date(), petPresent = () => true } = {}) {
  const stateFile = path.join(stateDir, 'recap', 'state.json');
  let timer = null;
  let running = false;

  const cfg = () => { try { return normalizeDailyRecapConfig(readConfig()); } catch { return normalizeDailyRecapConfig({}); } };
  const readState = () => readJson(stateFile, {});
  function writeState(patch) {
    try {
      const next = { ...readState(), ...patch };
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(tmp, stateFile);
    } catch (error) {
      pluginLog('[daily-recap] 写状态失败：', String(error?.message ?? error).slice(0, 120));
    }
  }

  /** 到点就说一次。force=true 跳过「到点 / 今天说过」（调试路由用）。 */
  async function runOnce({ force = false } = {}) {
    const c = cfg();
    const d = now();
    const date = localDate(d);
    if (!force) {
      if (!c.enabled) return { ok: true, skipped: 'disabled' };
      if (readState().lastDate === date) return { ok: true, skipped: 'done-today' };
      if (d.getHours() * 60 + d.getMinutes() < minutesOf(c.at)) return { ok: true, skipped: 'not-yet' };
    }
    if (running) return { ok: true, skipped: 'running' };
    // 桌宠关着：先不说（不记「今天说过」），等他今晚打开桌宠再说；整晚没开就算了。不花 token。
    if (!force) {
      let present = true;
      try { present = petPresent() !== false; } catch {}
      if (!present) return { ok: true, skipped: 'no-pet' };
    }
    running = true;
    try {
      const dir = typeof biliDir === 'function' ? biliDir() : biliDir;
      // 周日：换成「这周口味变化」（同一个一天一次的记号，周日就不另发日回顾）。
      const weekly = d.getDay() === 0;
      const week = weekly ? collectBiliWeek(dir, date) : null;
      const facts = collectBiliDay(dir, date);
      if (weekly ? !week.watched : !facts.top.length) {
        writeState({ lastDate: date, lastAt: d.toISOString(), lastText: '', lastSkip: 'no-bili-today', lastError: '' });
        pluginLog('[daily-recap] 今天 B站 没刷（没有评分记录），不说了');
        return { ok: true, skipped: 'no-bili-today' };
      }
      if (tokenBudget?.block) {
        let blocked = false;
        try { blocked = Boolean((await tokenBudget.block('other'))?.blocked); } catch {}
        if (blocked) {
          writeState({ lastDate: date, lastAt: d.toISOString(), lastSkip: 'budget', lastError: '' });
          pluginLog('[daily-recap] 今天 token 额度（其他）用完了，回顾跳过');
          return { ok: true, skipped: 'budget' };
        }
      }
      const reply = await chat.complete({
        system: `${chat.systemPromptForFrontend({ modality: 'text' })}\n\n${weekly ? WEEKLY_INSTRUCTION : RECAP_INSTRUCTION}`,
        user: weekly ? buildWeeklyPrompt(week) : buildRecapPrompt(facts),
        effort: 'low',
        maxTokens: 800,
        temperature: 1,
      });
      chat.recordUsage?.(reply.usage, reply.model);
      const text = String(reply.text ?? '').trim().replace(/^["「]|["」]$/g, '').slice(0, 120);
      if (!text) throw Object.assign(new Error('模型没给内容'), { code: 'recap.empty' });
      const sent = await chat.proactive({ text, purpose: { kind: 'recap', text: `B站回顾 ${date}` }, remember: true });
      if (!sent?.ok) throw Object.assign(new Error(sent?.error || '发不出去'), { code: 'recap.deliver-failed' });
      writeState({ lastDate: date, lastAt: d.toISOString(), lastText: text, lastSkip: '', lastError: '' });
      pluginLog(`[daily-recap] 说：${text}`);
      return { ok: true, text, facts };
    } catch (error) {
      const code = error?.code || 'recap.failed';
      const message = String(error?.message ?? error).slice(0, 200);
      // 失败不记 lastDate：下一分钟还会再试；但同一天最多重试到 23:59，第二天自然重来。
      writeState({ lastError: `${code}: ${message}`, lastErrorAt: d.toISOString() });
      pluginLog(`[daily-recap] 失败（${code}）：${message}（设置 → 桌宠 / 模型是否可用）`);
      return { ok: false, code, error: message, hint: '确认 DSH 模型可用、桌宠在线；GET /dsh-surfcore/pet-api/recap/status 看最近一次' };
    } finally {
      running = false;
    }
  }

  let failures = 0;
  async function tick() {
    const r = await runOnce();
    if (r.ok) failures = 0;
    else if ((failures += 1) >= 3) { writeState({ lastDate: localDate(now()), lastSkip: 'gave-up' }); failures = 0; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, 60 * 1000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() { return { ok: true, config: cfg(), state: readState() }; }

  return { start, stop, status, runOnce };
}
