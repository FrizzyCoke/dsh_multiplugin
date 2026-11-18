/**
 * 快捷对话：系统级快捷键 → 置顶小输入框 → 发给桌宠（同一个大脑和记忆）。
 *
 * 为什么不用 dsh-pet 自带的 Ctrl+Shift+L：那是 DSH 窗口里的应用内快捷键，只在 DSH 窗口有焦点时生效，
 * 而且只打开「网页里的宠物」的对话框（desktop-only 的宠物上按了没反应）。
 *
 * 结构（和 dsh-pet 的桌面窗口同一种做法）：
 *   · quickchat/main.cjs —— 用 DSH 自带的 electron.exe 起的独立小进程：注册系统级快捷键、显示输入框；
 *   · 本模块 —— 管那个进程（起 / 停 / 崩了重启 / 改了快捷键重启 / 杀残留），并提供它调用的两个接口：
 *       send：文字（可附截图）→ dsh-pet /chat（走 dsh-pet 联动 = SurfCore 大脑+记忆，回答在宠物身上）；
 *             dsh-pet 不在时退回 surfpet。
 *       hear：录音 → dsh-pet /voice/hear（DSH 的语音识别；默认 DeepSeek）。
 * 截图走 screen-capture（Windows-MCP），隐私窗口规则与看屏幕一致。
 * 配置：合体层 `quickChat`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScreenWatchConfig } from './screen-watch.js';

const HELPER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'quickchat');

export function normalizeQuickChatConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const key = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  return {
    enabled: c.enabled !== false,
    chatHotkey: key(c.chatHotkey, 'Alt+N'),
    micHotkey: key(c.micHotkey, 'T'),
    speechProvider: key(c.speechProvider, 'deepseek'),
    petId: key(c.petId, 'main'),
  };
}

function titleMatches(title, keywords) {
  const t = String(title || '').toLowerCase();
  return keywords.some((k) => t.includes(String(k).toLowerCase()));
}

export function createQuickChat({
  chat,
  screenSource,
  readConfig,
  readScreenWatch = () => ({}),
  screenWatch = null,
  bridge = null,
  bridgeEnabled = () => false,
  currentDshUrl,
  dshHome,
  stateDir,
  pluginLog = () => {},
  notify = () => {},
  fetchImpl = (...args) => fetch(...args),
  spawnImpl = spawn,
} = {}) {
  const cfg = () => { try { return normalizeQuickChatConfig(readConfig()); } catch { return normalizeQuickChatConfig({}); } };
  let child = null;
  let stopping = false;
  let restartTimer = null;
  let watchTimer = null;
  let failStreak = 0;
  let runningKey = '';
  let lastKeys = null;
  let lastError = '';
  let windowLoaded = false;
  let warnedPage = false;

  const dsh = () => String(currentDshUrl() || '').replace(/\/+$/, '');

  async function dshPet(route, body, timeoutMs) {
    const res = await fetchImpl(`${dsh()}/dsh-pet-7340${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json().catch(() => ({ ok: false, reason: 'bad-response', message: `HTTP ${res.status}` }));
  }

  /** 发一句话给她。返回 { ok, reply, via, note } 或 { ok:false, code, error, hint }。 */
  async function send({ text, withScreen = false } = {}) {
    const say = String(text || '').trim().slice(0, 2000);
    if (!say) return { ok: false, code: 'quickchat.empty', error: '没有内容', hint: '打几个字再发' };
    const c = cfg();
    let attachment;
    let note = '';
    if (withScreen) {
      const frame = await screenSource.capture();
      if (!frame.ok) {
        note = `没附上截图：${frame.error}`;
      } else {
        const sw = normalizeScreenWatchConfig(readScreenWatch());
        if (titleMatches(frame.title, sw.ignoreApps)) note = '前台是隐私窗口，没附截图';
        else {
          const data = Buffer.from(frame.bytes).toString('base64');
          // dsh-pet 限 900k 个 base64 字符（游戏画面常超）；超了就走看屏幕自己的「为回答他而看」：
          // 那条路用 DSH 附件服务直接发图、没有这个上限，回答照样只有一句。
          if (data.length <= 880000) attachment = { mediaType: frame.mediaType, data };
          else if (screenWatch) {
            pluginLog(`[quick-chat] 截图 ${data.length} 字符超过 dsh-pet 上限，改走看屏幕回答`);
            const look = await screenWatch.lookOnce({ force: true, deliver: true, question: say });
            if (look?.said) {
              try { chat.rememberTurn?.({ userText: say, replyText: look.said, at: Date.now() }); } catch {}
              return { ok: true, reply: look.said, via: 'screen-watch', note: '' };
            }
            if (look?.skipped) return { ok: true, reply: '', via: 'screen-watch', note: '前台是隐私窗口，没看' };
            note = `截图太大，单独看也没成：${look?.error || look?.code || '未知'}`;
          } else note = '截图太大没附上';
        }
      }
    }
    if (bridgeEnabled()) {
      // 只有真附上了截图，才跳过联动的「要不要看屏幕」判断（否则又是两条回答）；没附图就照常让模型自己决定。
      if (attachment) bridge?.suppressScreenFor?.(say);
      try {
        const r = await dshPet(`/chat?pet=${encodeURIComponent(c.petId)}&surface=any`, { text: say, ...(attachment ? { attachment } : {}) }, 90000);
        if (r?.ok === true) return { ok: true, reply: String(r.text || ''), via: 'dsh-pet', note };
        pluginLog(`[quick-chat] dsh-pet 没接住（${r?.reason || ''} ${r?.message || ''}），改发给 surfpet`);
      } catch (error) {
        pluginLog('[quick-chat] dsh-pet 不可达，改发给 surfpet：', String(error?.message ?? error).slice(0, 120));
      }
    }
    const r = await chat.chat({ text: say });
    if (!r?.ok) return { ok: false, code: 'quickchat.chat-failed', error: r?.error || '她没回', hint: '确认 DSH 模型可用；桌宠对话没被关掉' };
    try { chat.emit?.({ type: 'reply', text: r.reply?.text || '', modality: 'text', messageId: r.reply?.id }); } catch {}
    return { ok: true, reply: r.reply?.text || '', via: 'surfpet', note: note || (withScreen && attachment ? 'surfpet 不收图，截图没发' : '') };
  }

  /** 语音转文字（DSH 识别；先用配置的识别器，不支持就换另一个）。 */
  async function hear({ audio } = {}) {
    if (typeof audio !== 'string' || !audio) return { ok: false, code: 'quickchat.no-audio', error: '没有录到声音', hint: '再说一次' };
    const first = cfg().speechProvider;
    const order = [first, ...['deepseek', 'dsh'].filter((p) => p !== first)];
    let last = null;
    for (const provider of order) {
      try {
        const r = await dshPet('/voice/hear', { audio, provider }, 45000);
        if (r?.ok === true) return { ok: true, text: String(r.text || ''), provider };
        last = r;
        if (r?.reason !== 'unsupported') break;
      } catch (error) {
        last = { reason: 'network', message: String(error?.message ?? error) };
        break;
      }
    }
    return {
      ok: false,
      code: last?.reason === 'unsupported' ? 'quickchat.stt-unavailable' : 'quickchat.stt-failed',
      error: `语音识别失败：${last?.message || last?.reason || '未知'}`,
      hint: last?.reason === 'unsupported' ? 'DSH 里没有可用的语音识别：在 DSH 配好 DeepSeek 的 key，或装 DSH 语音插件' : '稍后再试；dsh-pet 要在运行',
    };
  }

  // ── 小助手进程 ────────────────────────────────────────────────────────────
  function electronExe() {
    return path.join(dshHome, 'electron', 'electron.exe');
  }

  function onLine(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.event === 'ready') {
      lastKeys = event.keys;
      failStreak = 0;
      const errs = [];
      if (event.keys?.chat && !event.keys.chat.ok) errs.push(`对话键 ${event.keys.chat.key} 被别的程序占用了，换一个吧`);
      if (event.keys?.mic && !event.keys.mic.ok) errs.push(`语音键 ${event.keys.mic.key} 用不了：${event.keys.mic.error || '未知原因'}`);
      if (errs.length) {
        lastError = errs.join('；');
        pluginLog(`[quick-chat] ${lastError}（config.json → quickChat）`);
        notify(`⚠️ ${errs.join('；')}（config.json → quickChat）`.slice(0, 280));
      } else {
        lastError = '';
        pluginLog(`[quick-chat] 快捷键就绪：对话 ${event.keys.chat.key}，按住说话 ${event.keys.mic.key}`);
      }
    } else if (event.event === 'window-loaded') {
      windowLoaded = true;
    } else if (event.event === 'page-error') {
      lastError = `对话框出错：${String(event.message || '').slice(0, 160)}`;
      pluginLog(`[quick-chat] ${lastError}`);
      if (!warnedPage) { warnedPage = true; notify('⚠️ 快捷对话框没打开成功，看 SurfCore 日志 [quick-chat]'); }
    } else if (event.event === 'already-running') {
      pluginLog('[quick-chat] 已有一个小助手在跑（可能是上次留下的），稍后重试');
    }
  }

  function launch() {
    const c = cfg();
    const exe = electronExe();
    if (!fs.existsSync(exe)) {
      lastError = '找不到 DSH 自带的 electron.exe';
      pluginLog(`[quick-chat] ${lastError}：${exe}`);
      return;
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      SURFCORE_HOST_JSON: path.join(stateDir, 'pet', 'host.json'),
      SURFCORE_CHAT_KEY: c.chatHotkey,
      SURFCORE_MIC_KEY: c.micHotkey,
      SURFCORE_PARENT_PID: String(process.pid),
    });
    runningKey = `${c.chatHotkey}|${c.micHotkey}`;
    windowLoaded = false;
    // 残留的旧小助手（插件热重载没走 stop）不用按 PID 去杀：新进程启动时旧的会收到 second-instance 自己退出，
    // 新的报 already-running 退出后 2 秒重启即可接管。
    const proc = spawnImpl(exe, [path.join(HELPER_DIR, 'main.cjs'), `--user-data-dir=${path.join(stateDir, 'quickchat', 'electron-data')}`], {
      cwd: HELPER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child = proc;
    let buf = '';
    proc.stdout?.on('data', (d) => {
      if (child !== proc) return;
      buf += String(d);
      let at;
      while ((at = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, at).trim()); buf = buf.slice(at + 1); }
    });
    proc.on('exit', (code) => {
      if (child !== proc) return; // 被替换/被停掉的旧进程：不影响现在这个
      child = null;
      if (stopping) return;
      failStreak += 1;
      const delay = Math.min(5 * 60 * 1000, 2000 * 2 ** Math.min(7, failStreak - 1));
      if (failStreak === 1 || failStreak % 5 === 0) pluginLog(`[quick-chat] 小助手退出了（code ${code}），${Math.round(delay / 1000)}s 后重启`);
      restartTimer = setTimeout(() => { restartTimer = null; if (!stopping && cfg().enabled) launch(); }, delay);
      restartTimer.unref?.();
    });
  }

  function halt() {
    const c = child;
    child = null;
    if (!c) return;
    try { c.kill(); } catch {} // 进程结束时系统自动释放它的快捷键和键盘旁听
  }

  /** 开关/快捷键改了：关掉或重启小助手。 */
  function reconcile() {
    if (stopping) return;
    const c = cfg();
    if (!c.enabled) { if (child) { pluginLog('[quick-chat] 已关闭'); halt(); } return; }
    if (!child && !restartTimer) { launch(); return; }
    if (child && `${c.chatHotkey}|${c.micHotkey}` !== runningKey) {
      pluginLog('[quick-chat] 快捷键改了，重启小助手');
      const old = child;
      child = null;
      // 等旧的真退出（释放快捷键 + 单实例锁）再起新的。
      old.once('exit', () => { if (!stopping && !child && cfg().enabled) launch(); });
      try { old.kill(); } catch {}
    }
  }

  function start() {
    stopping = false;
    reconcile();
    watchTimer = setInterval(reconcile, 10000);
    watchTimer.unref?.();
  }

  function stop() {
    stopping = true;
    if (watchTimer) clearInterval(watchTimer);
    if (restartTimer) clearTimeout(restartTimer);
    watchTimer = null;
    restartTimer = null;
    halt();
  }

  function status() {
    return { ok: true, config: cfg(), running: Boolean(child), pid: child?.pid || 0, keys: lastKeys, windowLoaded, lastError, failStreak };
  }

  return { start, stop, status, send, hear };
}
