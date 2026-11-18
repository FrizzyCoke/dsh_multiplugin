// SurfCore 快捷对话小助手（独立 Electron 进程，跑在 DSH 自带的 electron.exe 上）。
// 只做两件事：注册系统级快捷键、显示一个置顶小输入框。发送/识别/截图都交给 SurfCore 插件的 pet-api。
// 不改 dsh-pet；dsh-pet 自己的 Ctrl+Shift+L 只在 DSH 窗口里、而且只对网页版宠物生效。
//
// 环境变量（由插件 lib/quick-chat.js 传入）：
//   SURFCORE_HOST_JSON  pet/host.json 路径（baseUrl + token；DSH 端口漂移时插件会重写，所以每次请求现读）
//   SURFCORE_CHAT_KEY   打开对话框的快捷键（Electron accelerator，如 Ctrl+Alt+L）
//   SURFCORE_MIC_KEY    按住说话的键（如 T）：不弹窗，按住 0.25 秒开录，松开发送；只旁听不吞键
//   SURFCORE_PARENT_PID 父进程（DSH）PID：父进程没了就退出，免得孤儿进程占着快捷键
// --selftest：只注册一次快捷键、打印结果、立刻退出（不显示窗口）。
const { app, BrowserWindow, globalShortcut, ipcMain, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SELFTEST = process.argv.includes('--selftest');
const HOST_JSON = process.env.SURFCORE_HOST_JSON || '';
const CHAT_KEY = process.env.SURFCORE_CHAT_KEY || 'Alt+N';
const MIC_KEY = process.env.SURFCORE_MIC_KEY || 'T';
const PARENT_PID = Number(process.env.SURFCORE_PARENT_PID) || 0;

function emit(event) {
  try { process.stdout.write(`${JSON.stringify(event)}\n`); } catch {}
}

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  emit({ event: 'already-running' });
  app.exit(0);
}
// 新的小助手启动了（插件重载等）：旧的让位，新的稍后由插件重启接管。
app.on('second-instance', () => { emit({ event: 'quitting', reason: 'replaced' }); app.quit(); });

app.disableHardwareAcceleration();
// 与 dsh-pet 的桌面窗口同一处理：装了虚拟显示器（ToDesk/远程桌面之类）时 GPU 进程沙箱会初始化崩溃，
// 页面一律 ERR_FAILED。关掉 GPU 沙箱即可；本窗口只显示本地的一个输入框。
app.commandLine.appendSwitch('disable-gpu-sandbox');

function host() {
  const raw = JSON.parse(fs.readFileSync(HOST_JSON, 'utf8'));
  return { base: String(raw.baseUrl || '').replace(/\/+$/, ''), token: String(raw.token || '') };
}

async function api(route, body) {
  try {
    const h = host();
    const res = await fetch(`${h.base}/dsh-surfcore/pet-api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pet-token': h.token },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(90000),
    });
    return await res.json().catch(() => ({ ok: false, code: 'quickchat.bad-response', error: `HTTP ${res.status}` }));
  } catch (error) {
    return { ok: false, code: 'quickchat.unreachable', error: String(error?.message || error), hint: '确认 DSH 和 SurfCore 在运行' };
  }
}

let win = null;
let shownAt = 0;

function placeWindow() {
  const point = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const [w, h] = win.getSize();
  win.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height - h - 120));
}

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 168,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 窗口隐藏时也要能录音
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('did-fail-load', (_e, code, desc, url) => emit({ event: 'page-error', message: `load failed ${code} ${desc} ${url}` }));
  win.webContents.on('render-process-gone', (_e, details) => emit({ event: 'page-error', message: `renderer gone: ${details?.reason}` }));
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = typeof level === 'number' ? level : event?.level;
    if (lvl === 3 || lvl === 'error') emit({ event: 'page-error', message: String(message || event?.message || '').slice(0, 300) });
  });
  win.webContents.on('preload-error', (_e, file, error) => emit({ event: 'page-error', message: `preload ${path.basename(file)}: ${error?.message || error}` }));
  win.loadFile(path.join(__dirname, 'index.html'))
    .then(() => emit({ event: 'window-loaded' }))
    .catch((error) => emit({ event: 'page-error', message: `loadFile: ${error?.message || error}` }));
  win.on('blur', () => {
    // 点到别处就收起（录音中除外，避免游戏里点一下就把录音打断）。
    if (win?.isVisible() && Date.now() - shownAt > 400) win.webContents.send('qc:blur');
  });
}

function show(mode) {
  if (!win) return;
  if (!win.isVisible()) {
    placeWindow();
    shownAt = Date.now();
    win.show();
  }
  win.focus();
  win.webContents.send('qc:mode', mode);
}

function hide() {
  if (win?.isVisible()) win.hide();
}

// ── 按住说话（不弹窗）：用 uiohook 只「旁听」这个键，不吞键（T 照样能打字、游戏里照样生效）。
// 按住超过 HOLD_MS 才开录，所以平时打字敲 t 不会触发；松开 → 停止并发送。录音在隐藏的窗口里做。
const HOLD_MS = 250;
function parseKey(accel) {
  const parts = String(accel).split('+').map((p) => p.trim()).filter(Boolean);
  const main = parts.pop() || '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { main, alt: mods.has('alt'), ctrl: mods.has('ctrl') || mods.has('control'), shift: mods.has('shift') };
}
function startPttHook() {
  let uio;
  try { uio = require('uiohook-napi'); } catch (error) {
    return { ok: false, error: `缺少 uiohook-napi（在 quickchat 目录运行 npm install）：${String(error?.message || error).slice(0, 120)}` };
  }
  const spec = parseKey(MIC_KEY);
  const code = uio.UiohookKey[spec.main.length === 1 ? spec.main.toUpperCase() : spec.main];
  if (code === undefined) return { ok: false, error: `不认识的按键：${MIC_KEY}` };
  let down = false;
  let recording = false;
  let holdTimer = null;
  uio.uIOhook.on('keydown', (e) => {
    if (e.keycode !== code || down) return; // 按住时的自动重复忽略
    // 只要求配置里写了的修饰键按着；多按的不管（游戏里按着 Shift 跑 / Ctrl 蹲 也能说话）。
    if ((spec.alt && !e.altKey) || (spec.ctrl && !e.ctrlKey) || (spec.shift && !e.shiftKey)) return;
    down = true;
    holdTimer = setTimeout(() => { holdTimer = null; recording = true; win?.webContents.send('qc:ptt', 'start'); }, HOLD_MS);
  });
  uio.uIOhook.on('keyup', (e) => {
    if (e.keycode !== code || !down) return;
    down = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; return; } // 只是敲了一下：不录
    if (recording) { recording = false; win?.webContents.send('qc:ptt', 'stop'); }
  });
  try { uio.uIOhook.start(); } catch (error) { return { ok: false, error: `键盘旁听启动失败：${error?.message || error}` }; }
  app.on('will-quit', () => { try { uio.uIOhook.stop(); } catch {} });
  return { ok: true };
}

function registerKeys() {
  const result = {};
  let ok = false;
  try { ok = globalShortcut.register(CHAT_KEY, () => (win?.isVisible() && win.isFocused() ? hide() : show('text'))); } catch { ok = false; }
  result.chat = { key: CHAT_KEY, ok };
  const ptt = startPttHook();
  result.mic = { key: MIC_KEY, ok: ptt.ok, mode: 'hold', ...(ptt.ok ? {} : { error: ptt.error }) };
  return result;
}

app.whenReady().then(() => {
  if (SELFTEST) {
    const keys = registerKeys();
    emit({ event: 'selftest', electron: process.versions.electron, keys });
    globalShortcut.unregisterAll();
    app.exit(0);
    return;
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  createWindow();
  const keys = registerKeys();
  emit({ event: 'ready', keys });

  ipcMain.handle('qc:send', (_e, payload) => api('/quickchat/send', payload));
  ipcMain.handle('qc:hear', (_e, payload) => api('/quickchat/hear', payload));
  ipcMain.on('qc:hide', () => hide());
  ipcMain.on('qc:show-error', () => show('error')); // 语音失败时才弹出来给你看原因

  // 父进程（DSH）没了就退出；stdin 断开也退出（插件重载时会关掉 stdin）。
  const quit = (reason) => { emit({ event: 'quitting', reason }); app.quit(); };
  if (PARENT_PID) {
    setInterval(() => {
      try { process.kill(PARENT_PID, 0); } catch { quit('parent-gone'); }
    }, 3000).unref();
  }
  // 注意：Windows 上 Electron 主进程的 stdin 一启动就 end，不能拿它判断父进程是否还在（会自己秒退）。
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
