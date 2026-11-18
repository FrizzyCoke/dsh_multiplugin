/**
 * 专注模式（2026-11-18 用户：「做个专注模式，不弹东西、不配图」）。
 *
 * 只管「她自己主动冒出来的」：你主动找她（桌宠对话 / 快捷对话 / 按菜单）照常回。
 *   · SurfCore 这边：用同一个专注开关（pet/focus.json，pet-chat 已有）——主动搭话、看屏幕、桌宠气泡镜像、
 *     B站分享气泡 / 心情动画、晚间回顾、B站 桌面通知 都看这个开关（各模块里判断）。
 *   · dsh-pet 这边：它自己的碎碎念（含配图）、对话配图、工作状态气泡 由它的配置开关控制。
 *     开专注时把这几项记下原值、改成关；关专注时原样恢复。直接改它的 main-config.jsonc：
 *     它的碎碎念计时器每轮都重读配置，所以**不用重启桌宠**（走它的保存接口会重启桌宠窗口）。
 *     原值存在 state/focus-dshpet.json；SurfCore 中途重启也能在启动时对上（开着就补关、关着就补恢复）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DSHPET_TOP_KEYS = ['whisperImageEnabled', 'chatImageEnabled'];
export const DSHPET_PET_KEYS = ['whisperEnabled', 'workStatusEnabled'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.focus.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 把 dsh-pet 配置里那几项改成「专注」（全关），返回原值快照。纯函数。 */
export function quietConfig(cfg = {}) {
  const snap = { top: {}, pets: {} };
  const next = { ...cfg };
  for (const k of DSHPET_TOP_KEYS) { snap.top[k] = cfg[k]; next[k] = false; }
  next.pets = (Array.isArray(cfg.pets) ? cfg.pets : []).map((p) => {
    const id = String(p?.id ?? '');
    snap.pets[id] = Object.fromEntries(DSHPET_PET_KEYS.map((k) => [k, p?.[k]]));
    return { ...p, ...Object.fromEntries(DSHPET_PET_KEYS.map((k) => [k, false])) };
  });
  return { next, snap };
}

/** 按快照恢复（只动那几项；快照里是 undefined 的就删掉该键，回到 dsh-pet 默认）。纯函数。 */
export function restoreConfig(cfg = {}, snap = {}) {
  const next = { ...cfg };
  for (const k of DSHPET_TOP_KEYS) {
    if (snap.top?.[k] === undefined) delete next[k]; else next[k] = snap.top[k];
  }
  next.pets = (Array.isArray(cfg.pets) ? cfg.pets : []).map((p) => {
    const saved = snap.pets?.[String(p?.id ?? '')];
    if (!saved) return p;
    const out = { ...p };
    for (const k of DSHPET_PET_KEYS) { if (saved[k] === undefined) delete out[k]; else out[k] = saved[k]; }
    return out;
  });
  return next;
}

export function createFocusMode({ chat, dshPetConfigPath, stateDir, backupDir = '', pluginLog = () => {} } = {}) {
  const snapFile = path.join(stateDir, 'focus-dshpet.json');
  let lastError = '';

  function quietDshPet() {
    if (fs.existsSync(snapFile)) return { ok: true, already: true };  // 已经是专注态（原值早就存好了，别覆盖）
    const cfg = readJson(dshPetConfigPath, null);
    if (!cfg) return { ok: false, code: 'focus.dshpet-config', error: '读不到 dsh-pet 的配置', hint: 'dsh-pet 没装或配置损坏；SurfCore 这边的专注照样生效' };
    if (backupDir) { try { fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(dshPetConfigPath, path.join(backupDir, `dsh-pet-config-before-focus-${new Date().toISOString().slice(0, 10)}.jsonc`)); } catch {} }
    const { next, snap } = quietConfig(cfg);
    writeAtomic(snapFile, { at: new Date().toISOString(), snap });
    writeAtomic(dshPetConfigPath, next);
    return { ok: true };
  }

  function restoreDshPet() {
    const saved = readJson(snapFile, null);
    if (!saved) return { ok: true, already: true };
    const cfg = readJson(dshPetConfigPath, null);
    if (!cfg) return { ok: false, code: 'focus.dshpet-config', error: '读不到 dsh-pet 的配置，恢复不了', hint: '原值还在 state/focus-dshpet.json，修好 dsh-pet 后再关一次专注' };
    writeAtomic(dshPetConfigPath, restoreConfig(cfg, saved.snap));
    try { fs.renameSync(snapFile, `${snapFile}.restored`); } catch {}
    return { ok: true };
  }

  function enabled() {
    try { return chat.focusEnabled() === true; } catch { return false; }
  }

  /** 开 / 关专注。返回 { ok, enabled, dshPet } —— dsh-pet 那边失败也不挡 SurfCore 这边。 */
  function set(on, source = 'menu') {
    chat.setFocus(on === true, source);
    let r;
    try { r = on ? quietDshPet() : restoreDshPet(); } catch (error) { r = { ok: false, code: 'focus.dshpet-write', error: String(error?.message ?? error).slice(0, 120), hint: '检查 dsh-pet 配置文件权限' }; }
    lastError = r.ok ? '' : `${r.code}: ${r.error}`;
    pluginLog(`[focus] 专注模式 → ${on ? '开' : '关'}${r.ok ? '' : `（dsh-pet 那边没改成：${r.error}）`}`);
    return { ok: true, enabled: on === true, dshPet: r };
  }

  /** 启动时对齐：专注开着但 dsh-pet 没改 → 补改；关着但还留着快照 → 补恢复。 */
  function reconcile() {
    const on = enabled();
    const has = fs.existsSync(snapFile);
    if (on && !has) return set(true, 'reconcile');
    if (!on && has) return set(false, 'reconcile');
    return { ok: true, enabled: on };
  }

  function status() { return { ok: true, enabled: enabled(), dshPetQuieted: fs.existsSync(snapFile), lastError }; }
  return { set, enabled, reconcile, status };
}
