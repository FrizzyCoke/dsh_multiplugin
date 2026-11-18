/**
 * dsh-pet 右键菜单开关：用 dsh-pet 的第三方菜单接口（/dsh-pet-7340/menu/*，本机无鉴权）。
 *   · 看屏幕 开/关
 *   · 看屏幕频率 高/中/低（一组预设：看多勤、说多少）
 *   · 现在看一眼
 * dsh-pet 的菜单只有文字标签，没有勾选框，所以标签自带状态（● 当前 / ○ 可选），点了就改配置、重注册。
 * 菜单表存在 dsh-pet 内存里，DSH 重启即清空：轮询拿到 unknown-owner 就重新注册。
 * dshPetBridge 关掉时菜单一起撤掉（两只桌宠都回原样）。
 */
const OWNER = 'surfcore';
const ROUTE = '/dsh-pet-7340';
const POLL_WAIT_MS = 10000;

export const SCREEN_PRESETS = {
  high: { name: '高频', note: '常看常说', patch: { minIntervalSec: 10, maxIntervalSec: 60, firstIntervalSec: 15, chattiness: 'chatty', maxCommentsPerHour: 30, commentCooldownSec: 45, maxLooksPerHour: 240 } },
  mid: { name: '中频', note: '有事才说', patch: { minIntervalSec: 15, maxIntervalSec: 600, firstIntervalSec: 30, chattiness: 'normal', maxCommentsPerHour: 6, commentCooldownSec: 180, maxLooksPerHour: 60 } },
  low: { name: '低频', note: '偶尔看看', patch: { minIntervalSec: 60, maxIntervalSec: 1800, firstIntervalSec: 120, chattiness: 'quiet', maxCommentsPerHour: 3, commentCooldownSec: 600, maxLooksPerHour: 20 } },
};

/** 当前配置符合哪个预设；手调过参数就是 custom。 */
export function currentPreset(screenWatch) {
  const sw = screenWatch || {};
  for (const [key, preset] of Object.entries(SCREEN_PRESETS)) {
    if (Object.entries(preset.patch).every(([k, v]) => sw[k] === v)) return key;
  }
  return 'custom';
}

/** 由当前配置生成菜单：labels（≤32 字、唯一）+ 每个标签对应的动作。 */
export function buildMenu(screenWatch) {
  const on = screenWatch?.enabled === true;
  const actions = new Map();
  actions.set(on ? '看屏幕：开 ✓（点我关）' : '看屏幕：关（点我开）', { type: 'toggle', enable: !on });
  if (on) {
    const cur = currentPreset(screenWatch);
    for (const [key, preset] of Object.entries(SCREEN_PRESETS)) {
      actions.set(`${cur === key ? '●' : '○'} ${preset.name}（${preset.note}）`, { type: 'preset', key });
    }
    actions.set('现在看一眼', { type: 'look' });
  }
  return { labels: [...actions.keys()], actions };
}

export function createDshPetMenu({
  readScreenWatch,
  saveScreenWatch,
  bridgeEnabled = () => true,
  currentDshUrl,
  onChanged = () => {},
  onLookNow = () => {},
  notify = () => {},
  pluginLog = () => {},
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
} = {}) {
  let running = false;
  let registeredKey = '';
  let actions = new Map();
  let failStreak = 0;
  let lastError = '';
  let lastClick = null;
  let abort = null;

  const base = () => String(currentDshUrl() || '').replace(/\/+$/, '');

  async function call(path, init = {}) {
    abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), (init.waitMs || 0) + 8000);
    try {
      const res = await fetchImpl(`${base()}${ROUTE}${path}`, { ...init, signal: abort.signal });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function register() {
    const menu = buildMenu(readScreenWatch());
    const key = menu.labels.join('|');
    if (key === registeredKey) return true;
    const r = await call('/menu/item', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: OWNER, labels: menu.labels, target: 'both' }) });
    if (r.body?.ok !== true) throw new Error(`注册菜单失败：${r.body?.reason || r.status} ${r.body?.message || ''}`.trim());
    actions = menu.actions;
    registeredKey = key;
    return true;
  }

  async function unregister() {
    if (!registeredKey) return;
    registeredKey = '';
    try { await call(`/menu/item?owner=${OWNER}`, { method: 'DELETE' }); } catch {}
  }

  async function handle(label) {
    const action = actions.get(label);
    if (!action) return;
    lastClick = { label, at: Date.now() };
    if (action.type === 'toggle') {
      saveScreenWatch({ enabled: action.enable });
      const preset = SCREEN_PRESETS[currentPreset(readScreenWatch())];
      notify(action.enable ? `看屏幕开了${preset ? `（${preset.name}）` : ''}` : '看屏幕关了');
      pluginLog(`[dsh-pet-menu] 看屏幕 → ${action.enable ? '开' : '关'}`);
    } else if (action.type === 'preset') {
      const preset = SCREEN_PRESETS[action.key];
      saveScreenWatch({ ...preset.patch });
      notify(`切到${preset.name}：${preset.note}`);
      pluginLog(`[dsh-pet-menu] 看屏幕频率 → ${preset.name}`);
    } else if (action.type === 'look') {
      onLookNow();
      return;
    }
    onChanged();
  }

  async function loop() {
    while (running) {
      try {
        if (!bridgeEnabled()) { await unregister(); await sleep(5000); continue; }
        await register();
        const r = await call(`/menu/events?owner=${OWNER}&wait=${POLL_WAIT_MS}`, { waitMs: POLL_WAIT_MS });
        if (r.body?.ok !== true) {
          // DSH / dsh-pet 重启后菜单表清空：重注册即可。
          if (r.body?.reason === 'unknown-owner' || r.status === 404) { registeredKey = ''; continue; }
          throw new Error(`读菜单点击失败：${r.body?.reason || r.status}`);
        }
        failStreak = 0;
        lastError = '';
        for (const [label, pet] of Object.entries(r.body.events || {})) {
          if (pet) await handle(label);
        }
      } catch (error) {
        if (!running) break;
        failStreak += 1;
        registeredKey = '';
        const message = String(error?.message ?? error).slice(0, 160);
        if (failStreak === 1 || failStreak % 20 === 0) pluginLog(`[dsh-pet-menu] ${message}（dsh-pet 没开？会自动重试）`);
        lastError = message;
        await sleep(Math.min(60000, 2000 * 2 ** Math.min(5, failStreak - 1)));
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    void loop();
  }

  async function stop() {
    running = false;
    try { abort?.abort(); } catch {}
    await unregister();
  }

  function status() {
    return { running, registered: Boolean(registeredKey), labels: registeredKey ? registeredKey.split('|') : [], lastClick, lastError, failStreak };
  }

  return { start, stop, status, register, handle };
}
