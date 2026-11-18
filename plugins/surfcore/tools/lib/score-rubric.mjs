/**
 * 打分标尺（2026-11-18 用户：「不能全凭感觉，要按她的口味和记忆打分」）。
 *
 * 以前只有「0~20，每项 0-4」，但五项是什么从没定义过 → 她全凭感觉打，分数决定分享 / 每日动态 / 心情 / 关注，全跟着飘。
 * 现在 20 分拆成 6 项，默认 **13 分由代码算**（权重在 bili.config.json 的 scoring.weights，设置页可调），模型只做两件代码做不了的判断（还都有固定锚点）：
 *
 *   口味 taste   7  代码：她勾的「属于我口味里的哪几类」（只能从配置的 like 里选）× 主人在设置页调的 0~5 权重
 *                       + 标题/标签里字面命中口味词的加分；勾了「不爱看」的 → 整条封顶 dislikeCap（到不了分享线）
 *   他会喜欢 him 2  代码：视频分区 / 标签 对上他自己观看历史里的口味（B站 分区名对分区名）
 *   记忆 memory  2  代码：跟她收藏 / 最近高分 / 逛得好的方向 / 你们的梗 沾边（权重小，免得自我强化）
 *   新鲜 fresh   2  代码：只罚「近似重复」（同一个 UP 的几乎同标题、或标题几乎一样）；从今天逛的方向搜来的不罚
 *   好笑 funny   4  模型 0~4（锚点见 FUNNY_ANCHORS）
 *   上头 hooked  3  模型 0~4：按**她自己的口味**看不看得下去（搬运 / 低质本来就在她爱看里，不扣分）
 *
 * 他对分享的反应不进这里（已经在调分享门槛 ±2，不重复算）。权重可在设置页调（scoring.weights），合计按 20 归一。
 */

// 2026-11-18 用户：他的口味别占太重 → 他会喜欢 4→2，挪给她自己的口味 +1、好笑 +1
export const DEFAULT_WEIGHTS = Object.freeze({ taste: 7, him: 2, memory: 2, fresh: 2, funny: 4, hooked: 3 });
export const FUNNY_ANCHORS = ['0 没笑点', '1 会心一笑', '2 有一两个好笑的点', '3 好几次笑出声', '4 笑到想立刻发给他'];
export const HOOKED_ANCHORS = ['0 看不下去 / 划走了', '1 硬看完', '2 正常看完', '3 看得挺上头', '4 停不下来 / 想再看一遍'];

export function normalizeScoringConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const w = c.weights && typeof c.weights === 'object' ? c.weights : {};
  const weights = {};
  for (const [k, d] of Object.entries(DEFAULT_WEIGHTS)) {
    const n = Number(w[k]);
    weights[k] = Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : d;
  }
  const dislikeCap = Number.isFinite(Number(c.dislikeCap)) ? Math.max(0, Math.min(20, Number(c.dislikeCap))) : 6;
  return { weights, dislikeCap };
}

const lower = (s) => String(s ?? '').toLowerCase();

/** 中文 3~4 字片段 + 英文词，用来比相似度（不用分词）。 */
export function grams(text) {
  const out = new Set();
  const t = lower(text).replace(/【[^】]*】|\[[^\]]*\]/g, ' ');
  for (const m of t.matchAll(/[a-z][a-z0-9]{1,}/g)) out.add(m[0]);
  for (const m of t.matchAll(/[一-龥]{2,}/g)) {
    const run = m[0];
    for (const n of [3, 4]) for (let i = 0; i + n <= run.length; i += 1) out.add(run.slice(i, i + n));
    if (run.length === 2) out.add(run);
  }
  return out;
}

export function similarity(a, b) {
  const A = grams(a); const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

/** 只认配置里有的类别（防止模型自己造一类）。 */
export function pickLabels(raw, allowed = []) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、]/)).map((s) => String(s).trim()).filter(Boolean);
  const byLower = new Map(allowed.map((a) => [lower(a), a]));
  const ok = []; const unknown = [];
  for (const l of list) { const hit = byLower.get(lower(l)); if (hit) { if (!ok.includes(hit)) ok.push(hit); } else unknown.push(l); }
  return { ok, unknown };
}

function weightOf(label, weights = {}) {
  for (const [k, v] of Object.entries(weights ?? {})) if (lower(k) === lower(label)) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 1; }
  return 1;
}

/**
 * 算分（纯函数）。
 * @param video  { title, tname, tags[], desc, mid, kw }
 * @param labels { fits[], dislikes[], funny 0~4, hooked 0~4 }   ← 模型给的
 * @param ctx    { like[], dislike[], prefWeights{}, ownerTaste[{tag,count}], favorites[], highTitles[], goodExplore[], jokes[], recent[{title,mid,at}], exploreToday[] }
 * @returns { total, items{taste,him,memory,fresh,funny,hooked}, capped, notes[] }
 */
export function computeScore(video = {}, labels = {}, ctx = {}, cfg = normalizeScoringConfig()) {
  const W = cfg.weights;
  const sumW = Object.values(W).reduce((a, b) => a + b, 0) || 20;
  const scale = 20 / sumW;
  const notes = [];
  const text = `${video.title ?? ''} ${(video.tags ?? []).join(' ')} ${video.tname ?? ''}`;
  const low = lower(text);

  // 口味：她勾的类别 × 权重 + 字面命中加分（每个 0.5，最多 1）；2 个权重点 = 满
  const fits = pickLabels(labels.fits, ctx.like ?? []).ok;
  const fitW = fits.reduce((s, l) => s + weightOf(l, ctx.prefWeights) / 1, 0);
  const literal = (ctx.like ?? []).filter((l) => l && low.includes(lower(l))).length;
  const tasteFrac = Math.min(1, (fitW + Math.min(1, literal * 0.5)) / 2);
  if (fits.length) notes.push(`口味：${fits.join('/')}`);

  // 不爱看：她勾的，或标题/标签里字面出现 → 封顶
  const dis = [...new Set([...pickLabels(labels.dislikes, ctx.dislike ?? []).ok, ...(ctx.dislike ?? []).filter((d) => d && low.includes(lower(d)))])];
  if (dis.length) notes.push(`不爱看：${dis.join('/')}`);

  // 他会喜欢：分区 / 标签 对上他观看历史的口味（前 3 名满分，其余 0.7；标签再沾边 +0.3）
  const taste = (ctx.ownerTaste ?? []).map((t) => lower(t.tag));
  const tnameIdx = taste.indexOf(lower(video.tname));
  let him = tnameIdx >= 0 ? (tnameIdx < 3 ? 1 : 0.7) : 0;
  if ((video.tags ?? []).some((t) => taste.includes(lower(t)))) him = Math.min(1, him + 0.3);
  if (him > 0) notes.push('他的口味');

  // 记忆：跟收藏 / 最近高分 / 逛得好的方向 / 梗 沾边（3 处满）
  const memTexts = [...(ctx.favorites ?? []), ...(ctx.highTitles ?? []), ...(ctx.goodExplore ?? []), ...(ctx.jokes ?? [])];
  const memHits = memTexts.filter((m) => m && (similarity(video.title, m) >= 0.34 || low.includes(lower(m)))).length;
  const memory = Math.min(1, memHits / 3);

  // 新鲜：只罚近似重复；今天逛的方向搜来的不罚
  let fresh = 1;
  const fromExplore = video.kw && (ctx.exploreToday ?? []).some((e) => lower(e) === lower(video.kw));
  if (!fromExplore) {
    for (const r of ctx.recent ?? []) {
      const sim = similarity(video.title, r.title);
      if (sim >= 0.7 || (video.mid && r.mid === video.mid && sim >= 0.45)) { fresh = 0; notes.push('近似重复'); break; }
    }
  }

  const clamp4 = (v) => Math.max(0, Math.min(4, Math.round(Number(v) || 0)));
  const items = {
    taste: tasteFrac * W.taste * scale,
    him: him * W.him * scale,
    memory: memory * W.memory * scale,
    fresh: fresh * W.fresh * scale,
    funny: (clamp4(labels.funny) / 4) * W.funny * scale,
    hooked: (clamp4(labels.hooked) / 4) * W.hooked * scale,
  };
  let total = Object.values(items).reduce((a, b) => a + b, 0);
  const capped = dis.length > 0 && total > cfg.dislikeCap;
  if (capped) total = cfg.dislikeCap;
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    total: Math.max(0, Math.min(20, Math.round(total))),
    items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, round1(v)])),
    capped,
    fits,
    dislikes: dis,
    notes,
  };
}

export function rubricPromptLines(cfg, like = [], dislike = []) {
  const W = normalizeScoringConfig(cfg).weights;
  return [
    `   打分（\`score <BV> --fits "…" --funny 0-4 --hooked 0-4 --reason "…"\`）：总分 20，**${W.taste + W.him + W.memory + W.fresh} 分由代码按你的口味 / 他的口味 / 你的记忆 / 新不新鲜算**，你只给这几样：`,
    `   · --fits：这条属于你口味里的哪几类（只能从这里选：${like.join('、') || '（未设置）'}）；一类都不像就不写`,
    `   · --dislike：沾了你不爱看的哪类（${dislike.join('、') || '无'}）—— 沾了整条封顶，到不了分享线`,
    `   · --funny 0-4：${FUNNY_ANCHORS.join(' / ')}`,
    `   · --hooked 0-4：按**你自己的口味**看不看得下去：${HOOKED_ANCHORS.join(' / ')}（搬运、低质本来就是你爱看的，不扣分）`,
  ];
}
