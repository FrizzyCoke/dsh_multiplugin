/**
 * 统一的「产生的文件都有上限」（2026-11-18 用户：所有产生的文件都要能自动删或封顶，像记忆卡一样）。
 *
 * 一张表管所有会一直长的文件，谁写的都不管：
 *   · lines   只追加的日志 / jsonl：超过 maxKB 就只留最后 keepLines 行（原子替换）。
 *   · diary   她每趟都要读的日记：超过 maxKB 把旧的那部分挪进 <名>.archive.md（档案本身也封顶），
 *             她读的那本只留最近的 —— 省磁盘也省 token，最近的一条不丢。
 *   · dirs    按天生成的快照 / 备份 / 语音：只留最新 keepNewest 个，且（若设）keepDays 天内的都留。
 * 已经自己封顶的不在这里重复管：plugin.log（2MB 轮换）、桌宠聊天（200 条）、记忆收件箱（轮换）、
 * B站视频缓存 shots（1 天 / 100MB）、截图（attachment-gc：用完即删 + 2 天 / 50MB 兜底）、
 * scores（14 天）、explore（60）、mood（60）、jokes（30）、watched-together（200）、feed-picks（60 天）。
 * 记忆卡本身有它自己的上限（memory-card 维护），这里不碰；记忆「全量档案」给一个很宽的上限（20MB）。
 * 启动 2 分钟后跑一次，之后每 6 小时；GET /housekeeping/status 看最近一次。
 */
import fs from 'node:fs';
import path from 'node:path';

const KB = 1024;

/** 规则表（相对路径里的 {char} = 当前角色目录，{surf} = <DSH_HOME>/surfcore）。 */
export function defaultRules() {
  return [
    { kind: 'lines', file: '{surf}/context-telemetry-plugin.jsonl', maxKB: 1024, keepLines: 3000 },
    { kind: 'lines', file: '{surf}/bridge-supervisor.log', maxKB: 1024, keepLines: 3000 },
    { kind: 'lines', file: '{char}/bili/dm-tick-err.log', maxKB: 256, keepLines: 500 },
    { kind: 'lines', file: '{char}/bili/whale-log.jsonl', maxKB: 1024, keepLines: 4000 },
    { kind: 'lines', file: '{char}/bili/watch-history.jsonl', maxKB: 2048, keepLines: 3000 },
    { kind: 'lines', file: '{char}/bili/commented-videos.md', maxKB: 1024, keepLines: 4000 },
    { kind: 'lines', file: '{char}/memory/memory-card-full.jsonl', maxKB: 20 * 1024, keepLines: 60000 },
    { kind: 'diary', file: '{char}/bili/whale-diary.md', maxKB: 48, keepKB: 32, archiveMaxKB: 1024 },
    { kind: 'diary', file: '{char}/bili/whale-diary-private.md', maxKB: 48, keepKB: 32, archiveMaxKB: 1024 },
    { kind: 'dirs', dir: '{char}/snapshots', match: /^auto-/, keepNewest: 7 },
    { kind: 'dirs', dir: '{surf}/backups', keepNewest: 40, keepDays: 14 },
    { kind: 'dirs', dir: '{surf}/pet/voice', keepNewest: 60, keepDays: 3 },
  ];
}

function resolve(p, { surf, char }) {
  return p.replace('{surf}', surf).replace('{char}', char);
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.hk.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** 只留最后 keepLines 行（文件没超 maxKB 不动）。返回省下的字节。 */
export function trimLines(file, { maxKB, keepLines }) {
  let st;
  try { st = fs.statSync(file); } catch { return 0; }
  if (st.size <= maxKB * KB) return 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const tail = lines.slice(-(keepLines + 1)).join('\n');
  atomicWrite(file, tail);
  return st.size - Buffer.byteLength(tail);
}

/**
 * 日记：超过 maxKB 时，从开头挪走旧的、只留最后 keepKB（在段落/标题边界切，不切半句），
 * 挪走的追加到 <名>.archive.md；档案超过 archiveMaxKB 再只留它的后半段。返回 { moved, freed }。
 */
export function trimDiary(file, { maxKB, keepKB, archiveMaxKB }) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { moved: 0, freed: 0 }; }
  const size = Buffer.byteLength(text);
  if (size <= maxKB * KB) return { moved: 0, freed: 0 };
  // 从「保留 keepKB」的位置往后找最近的段落起点（空行或 # 标题）
  const buf = Buffer.from(text);
  let cut = buf.subarray(0, Math.max(0, buf.length - keepKB * KB)).toString('utf8').length;
  const m = /\n(?=#)|\n\n/g;
  m.lastIndex = cut;
  const hit = m.exec(text);
  if (hit) cut = hit.index + 1;
  const old = text.slice(0, cut);
  const keep = text.slice(cut).replace(/^\n+/, '');
  const archive = file.replace(/\.md$/, '.archive.md');
  fs.appendFileSync(archive, old.endsWith('\n') ? old : `${old}\n`);
  trimLines(archive, { maxKB: archiveMaxKB, keepLines: Math.max(200, Math.floor((archiveMaxKB * KB) / 2 / 80)) });
  atomicWrite(file, `<!-- 更早的日记在 ${path.basename(archive)}（自动挪过去的，省得每次都读很长） -->\n${keep}`);
  return { moved: Buffer.byteLength(old), freed: size - Buffer.byteLength(keep) };
}

/** 目录里只留最新 keepNewest 个（keepDays 天内的也留）。返回删掉的条数。 */
export function pruneDir(dir, { match = null, keepNewest = 7, keepDays = 0 }, now = Date.now()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  const items = entries
    .filter((e) => !match || match.test(e.name))
    .map((e) => { const p = path.join(dir, e.name); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch {} return { p, m }; })
    .sort((a, b) => b.m - a.m);
  let removed = 0;
  items.forEach((it, i) => {
    if (i < keepNewest) return;
    if (keepDays > 0 && now - it.m < keepDays * 86_400_000) return;
    try { fs.rmSync(it.p, { recursive: true, force: true }); removed += 1; } catch {}
  });
  return removed;
}

export function createHousekeeping({ surfDir, charDir, readConfig = () => ({}), pluginLog = () => {}, rules = defaultRules(), now = () => Date.now() } = {}) {
  let timer = null;
  let last = null;
  const enabled = () => { try { return readConfig()?.enabled !== false; } catch { return true; } };

  function run() {
    if (!enabled()) return (last = { ok: true, skipped: 'disabled' });
    const ctx = { surf: surfDir, char: typeof charDir === 'function' ? charDir() : charDir };
    const done = [];
    const errors = [];
    let freed = 0;
    for (const r of rules) {
      try {
        if (r.kind === 'lines') {
          const n = trimLines(resolve(r.file, ctx), r);
          if (n > 0) { freed += n; done.push(`${path.basename(r.file)} 截到最后 ${r.keepLines} 行`); }
        } else if (r.kind === 'diary') {
          const d = trimDiary(resolve(r.file, ctx), r);
          if (d.moved > 0) { freed += d.freed; done.push(`${path.basename(r.file)} 旧的 ${Math.round(d.moved / KB)}KB 挪进档案`); }
        } else if (r.kind === 'dirs') {
          const n = pruneDir(resolve(r.dir, ctx), r, now());
          if (n > 0) done.push(`${path.basename(r.dir)} 删了 ${n} 个旧的`);
        } else {
          throw new Error(`不认识的规则类型 ${r.kind}`);
        }
      } catch (error) {
        errors.push(`${r.file ?? r.dir}: ${String(error?.message ?? error).slice(0, 80)}`);
      }
    }
    last = { ok: errors.length === 0, at: new Date(now()).toISOString(), freedKB: Math.round(freed / KB), done, errors };
    if (!last.ok) Object.assign(last, { code: 'housekeeping.partial', hint: '下一轮会重试；一直失败就看 plugin.log [housekeeping]' });
    if (done.length) pluginLog(`[housekeeping] ${done.join('；')}（省 ${last.freedKB}KB）`);
    if (errors.length) pluginLog(`[housekeeping] 有 ${errors.length} 项没清成：${errors.join(' | ')}`);
    return last;
  }

  function start() {
    if (timer) return;
    setTimeout(() => { try { run(); } catch {} }, 120_000).unref?.();
    timer = setInterval(() => { try { run(); } catch {} }, 6 * 3_600_000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() { return { ok: true, enabled: enabled(), rules: rules.map((r) => ({ kind: r.kind, target: r.file ?? r.dir, ...(r.maxKB ? { maxKB: r.maxKB } : {}), ...(r.keepNewest ? { keepNewest: r.keepNewest } : {}) })), last }; }
  return { run, start, stop, status };
}
