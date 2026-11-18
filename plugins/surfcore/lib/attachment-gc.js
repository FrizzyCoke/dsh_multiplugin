/**
 * 截图自动清理（2026-11-18 用户：存的图要有上限、自动删）。
 *
 * 看屏幕 / 桌宠问屏幕时，截图要先交给 DSH 的附件服务（attachments.saveImages）才能发给模型；
 * DSH 把它永久存在 <DSH_HOME>/attachments/v1/objects/<前两位>/<sha256>，自己从不清理（实测一天 63 张 / 59 MB）。
 *
 * 截图只给那一次模型调用用：调用一结束就删（release）。下面的定期清理是兜底（插件崩了 / 删失败时）。
 * 只删「SurfCore 自己存进去的」：每次存图时算 sha256 记进 state/attachments-ledger.json（账本），只清账本里的；
 * DSH 和你自己的附件永远不碰。删之前再查一遍：DSH 会话日志（zstd）或 dsh-pet 的对话记录里还提到这个 id 的，跳过。
 * 规则：超过 maxAgeDays 天删；总量超过 maxMB 从最旧的删。截图是一次性的（看完就没用了），删了不影响任何功能。
 * 配置：合体层 `attachmentGc { enabled, maxAgeDays, maxMB }`；默认 开 / 2 天 / 50 MB。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function normalizeAttachmentGcConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return { enabled: c.enabled !== false, maxAgeDays: num(c.maxAgeDays, 2, 0.1, 365), maxMB: num(c.maxMB, 50, 1, 10_000) };
}

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function createAttachmentGc({ dshHome, stateDir, readConfig = () => ({}), pluginLog = () => {}, now = () => Date.now() } = {}) {
  const objectsDir = path.join(dshHome, 'attachments', 'v1', 'objects');
  const ledgerFile = path.join(stateDir, 'attachments-ledger.json');
  let timer = null;
  let last = null;

  const cfg = () => { try { return normalizeAttachmentGcConfig(readConfig()); } catch { return normalizeAttachmentGcConfig({}); } };
  const objectPath = (hash) => path.join(objectsDir, hash.slice(0, 2), hash);
  function readLedger() {
    try { const j = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); return j && typeof j.items === 'object' ? j : { version: 1, items: {} }; } catch { return { version: 1, items: {} }; }
  }
  function writeLedger(l) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const tmp = `${ledgerFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
    fs.renameSync(tmp, ledgerFile);
  }

  /** 存图时调：把这张图记成「SurfCore 的」。 */
  function record(bytes) {
    try {
      const hash = sha256Hex(bytes);
      const l = readLedger();
      if (!l.items[hash]) { l.items[hash] = { at: new Date(now()).toISOString(), bytes: bytes.length }; writeLedger(l); }
      return hash;
    } catch (error) {
      pluginLog('[attachment-gc] 记账失败（不影响看屏幕）：', String(error?.message ?? error).slice(0, 100));
      return '';
    }
  }

  /** 存之前查：这张图是不是本来就在 DSH 附件里（别人的同一张）—— 是的话不算我们的。 */
  function exists(bytes) {
    try { return fs.existsSync(objectPath(sha256Hex(bytes))); } catch { return true; }
  }

  /**
   * 模型调用结束：这次带的截图立刻删（截图是看完即弃的，只给这一次调用用；DSH 会话里不会引用它）。
   * 只删账本里有的（也就是存之前不存在、我们自己存进去的）。
   */
  function release(hashes = []) {
    const l = readLedger();
    let n = 0;
    let freed = 0;
    for (const h of hashes) {
      if (!l.items[h]) continue;
      try {
        const p = objectPath(h);
        try { freed += fs.statSync(p).size; } catch {}
        fs.rmSync(p, { force: true });
        delete l.items[h];
        n += 1;
      } catch (error) {
        pluginLog('[attachment-gc] 用完删截图失败（定期清理会兜底）：', String(error?.message ?? error).slice(0, 80));
      }
    }
    if (n) writeLedger(l);
    return { released: n, freedKB: Math.round(freed / 1024) };
  }

  /** 会话日志 + dsh-pet 对话记录里提到的 id（还被用着的，不删）。读不了的会话当作「可能在用」→ 这次整体不删。 */
  function referencedIn(hashes) {
    const want = new Set(hashes);
    const hit = new Set();
    let unreadable = 0;
    const scan = (text) => { for (const h of want) if (text.includes(h)) hit.add(h); };
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl.zstd')) {
          try { scan(zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8')); } catch { unreadable += 1; }
        } else if (e.name.endsWith('.jsonl')) {
          try { scan(fs.readFileSync(p, 'utf8')); } catch { unreadable += 1; }
        }
      }
    };
    if (want.size) {
      walk(path.join(dshHome, 'sessions'));
      try { scan(fs.readFileSync(path.join(dshHome, 'dsh-pet', 'memory.json'), 'utf8')); } catch {}
    }
    return { hit, unreadable };
  }

  /** 清一次。返回 { deleted, freedMB, keptReferenced, remainingMB }。 */
  function sweep({ force = false } = {}) {
    const c = cfg();
    if (!c.enabled && !force) return (last = { ok: true, skipped: 'disabled' });
    const l = readLedger();
    const t = now();
    const rows = Object.entries(l.items).map(([hash, v]) => {
      let size = 0;
      try { size = fs.statSync(objectPath(hash)).size; } catch { size = -1; }
      return { hash, at: new Date(v.at).getTime() || 0, size };
    });
    // 文件已经不在了：账本里也去掉
    for (const r of rows.filter((x) => x.size < 0)) delete l.items[r.hash];
    const live = rows.filter((x) => x.size >= 0).sort((a, b) => a.at - b.at);
    const { hit, unreadable } = referencedIn(live.map((r) => r.hash));
    if (unreadable > 0) {
      writeLedger(l);
      pluginLog(`[attachment-gc] 有 ${unreadable} 个会话日志读不了，这次不删（宁可多留）`);
      return (last = { ok: false, code: 'attachment-gc.sessions-unreadable', error: `${unreadable} 个会话日志读不了`, hint: '多半是 DSH 正在写；下一轮会重试', at: new Date(t).toISOString() });
    }
    const maxAge = c.maxAgeDays * 86_400_000;
    let total = live.reduce((s, r) => s + r.size, 0);
    let deleted = 0;
    let freed = 0;
    for (const r of live) {
      if (hit.has(r.hash)) continue;
      const tooOld = t - r.at > maxAge;
      const overCap = total > c.maxMB * 1024 * 1024;
      if (!tooOld && !overCap) continue;
      try {
        fs.rmSync(objectPath(r.hash), { force: true });
        delete l.items[r.hash];
        deleted += 1; freed += r.size; total -= r.size;
      } catch (error) {
        pluginLog('[attachment-gc] 删不掉：', r.hash.slice(0, 12), String(error?.message ?? error).slice(0, 80));
      }
    }
    writeLedger(l);
    const result = { ok: true, deleted, freedMB: Math.round((freed / 1048576) * 10) / 10, keptReferenced: [...hit].length, remainingMB: Math.round((total / 1048576) * 10) / 10, at: new Date(t).toISOString() };
    if (deleted) pluginLog(`[attachment-gc] 清掉 ${deleted} 张截图（${result.freedMB} MB），还剩 ${result.remainingMB} MB`);
    return (last = result);
  }

  /** 一次性：把已经在 DSH 附件里、且没有任何会话/桌宠记录提到的旧截图记进账本（时间用文件修改时间），之后按规则清。 */
  function adoptUnreferenced({ before = now() } = {}) {
    const l = readLedger();
    const found = [];
    let dirs = [];
    try { dirs = fs.readdirSync(objectsDir); } catch { return { adopted: 0 }; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(objectsDir, d)); } catch { continue; }
      for (const f of files) {
        if (l.items[f]) continue;
        try {
          const st = fs.statSync(path.join(objectsDir, d, f));
          if (st.mtimeMs < before) found.push({ hash: f, at: st.mtime.toISOString() });
        } catch {}
      }
    }
    const { hit, unreadable } = referencedIn(found.map((x) => x.hash));
    if (unreadable) return { adopted: 0, skipped: 'sessions-unreadable' };
    let adopted = 0;
    for (const x of found) if (!hit.has(x.hash)) { l.items[x.hash] = { at: x.at, adopted: true }; adopted += 1; }
    writeLedger(l);
    return { adopted, referenced: hit.size };
  }

  function start() {
    if (timer) return;
    setTimeout(() => { try { sweep(); } catch {} }, 60_000).unref?.();
    timer = setInterval(() => { try { sweep(); } catch {} }, 6 * 3_600_000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() { return { ok: true, config: cfg(), tracked: Object.keys(readLedger().items).length, last }; }

  return { record, exists, release, sweep, adoptUnreferenced, start, stop, status };
}
