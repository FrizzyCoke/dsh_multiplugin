/**
 * 屏幕截图源（screen-watch 用）。
 *
 * 接口：createScreenSource(...).capture() → { ok, bytes, mediaType, width, height, title, thumb }
 *       失败 → { ok:false, code, error, hint }，不抛。
 * 以后换别的源（游戏内存读数 / 其它截图工具），实现同一个 capture() 接口即可。
 *
 * 当前实现：直接用 stdio 连用户已安装的 Windows-MCP（dsh-windows-mcp 装的 windows-mcp.exe），
 * 调 Snapshot（截图 + 前台窗口标题）。不自己写截屏代码：自写的 PowerShell 截屏 + 前台窗口探测
 * 会被杀软当成间谍软件拦下（2026-11-17 实测 ScriptContainedMaliciousContent），也不应该去绕。
 * 帧只在内存里，不落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const READ_ONLY_EXCLUDES = 'App,PowerShell,FileSystem,Click,Move,Scroll,Type,Shortcut,MultiSelect,MultiEdit,Process,Registry,Clipboard';

function fail(code, error, hint) {
  return { ok: false, code, error, hint };
}

function versionKey(name) {
  return String(name).split('.').map((n) => String(Number(n) || 0).padStart(6, '0')).join('.');
}

/** 找 dsh-windows-mcp 装好的 windows-mcp.exe（取最高版本）。 */
export function findWindowsMcpExe(dshHome) {
  const root = path.join(String(dshHome || ''), 'dsh-windows-mcp', 'toolchain');
  let versions = [];
  try { versions = fs.readdirSync(root).filter((name) => /^\d+(\.\d+)*$/.test(name)); } catch { return ''; }
  versions.sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
  for (const version of versions) {
    const exe = path.join(root, version, 'windows-mcp', 'Scripts', 'windows-mcp.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

/** Windows-MCP 的文本里有时是字面量 "\n"。 */
function normalizeText(text) {
  const s = String(text || '');
  return s.includes('\n') ? s : s.replace(/\\n/g, '\n');
}

/** 从 Snapshot 文本里取前台窗口标题（表格第一行数据的 Name 列）。 */
export function parseFocusedTitle(text) {
  const lines = normalizeText(text).split('\n');
  const at = lines.findIndex((line) => /Focused Window:/.test(line));
  if (at < 0) return '';
  for (let i = at + 1; i < Math.min(lines.length, at + 6); i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*Name\s+Depth/.test(line) || /^[-\s]+$/.test(line)) continue;
    if (/Not listed/i.test(line)) return '';
    return line.replace(/^\s*[◑◐●○◎•]\s*/, '').split(/\s{2,}/)[0].trim();
  }
  return '';
}

/** 解 8 位、非隔行的 RGB/RGBA PNG，采样成 tw×th 灰度缩略图（hex）。不支持的格式返回 ''（当作"变了"）。 */
export function pngThumb(buffer, tw = 32, th = 18) {
  try {
    const b = Buffer.from(buffer);
    if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return '';
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    const depth = b[24];
    const colorType = b[25];
    const interlace = b[28];
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (depth !== 8 || !channels || interlace !== 0 || !width || !height) return '';
    const parts = [];
    for (let off = 8; off + 8 <= b.length;) {
      const len = b.readUInt32BE(off);
      const type = b.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') parts.push(b.subarray(off + 8, off + 8 + len));
      if (type === 'IEND') break;
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(parts));
    const stride = width * channels;
    const img = Buffer.alloc(stride * height);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const out = img.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x += 1) {
        const a = x >= channels ? out[x - channels] : 0;
        const up = prev[x];
        const c = x >= channels ? prev[x - channels] : 0;
        let v = line[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += up;
        else if (filter === 3) v += (a + up) >> 1;
        else if (filter === 4) {
          const p = a + up - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : (pb <= pc ? up : c);
        }
        out[x] = v & 255;
      }
      prev = out;
    }
    let hex = '';
    for (let ty = 0; ty < th; ty += 1) {
      for (let tx = 0; tx < tw; tx += 1) {
        const x0 = Math.floor((tx * width) / tw); const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw));
        const y0 = Math.floor((ty * height) / th); const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th));
        let sum = 0; let n = 0;
        const sx = Math.max(1, Math.floor((x1 - x0) / 4)); const sy = Math.max(1, Math.floor((y1 - y0) / 4));
        for (let y = y0; y < y1; y += sy) {
          for (let x = x0; x < x1; x += sx) {
            const i = y * stride + x * channels;
            sum += 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
            n += 1;
          }
        }
        hex += Math.round(sum / Math.max(1, n)).toString(16).padStart(2, '0');
      }
    }
    return hex;
  } catch {
    return '';
  }
}

/** 两张灰度缩略图（hex）的平均差异 0~1；任一为空或长度不同返回 1（当作变了）。 */
export function thumbDiff(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || x.length !== y.length || x.length % 2) return 1;
  let sum = 0;
  for (let i = 0; i < x.length; i += 2) {
    sum += Math.abs(parseInt(x.slice(i, i + 2), 16) - parseInt(y.slice(i, i + 2), 16));
  }
  return sum / (x.length / 2) / 255;
}

/**
 * Windows-MCP 截图源：懒连接、复用一个 stdio 子进程，出错断开下次重连。
 * @param {{ dshHome: string, exe?: () => string, scale?: () => number, log?: Function, connect?: Function }} opts
 *   connect 仅供测试注入（返回带 callTool/close 的 client）。
 */
export function createScreenSource({ dshHome, exe = () => '', scale = () => 0.5, log = () => {}, connect = null } = {}) {
  let client = null;
  let connecting = null;
  let usedScale = 0;

  async function open() {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      if (connect) return connect();
      const command = String(exe() || '').trim() || findWindowsMcpExe(dshHome);
      if (!command || !fs.existsSync(command)) {
        const error = new Error('找不到 windows-mcp.exe');
        error.code = 'screen.windows-mcp-missing';
        throw error;
      }
      usedScale = Math.max(0.2, Math.min(1, Number(scale()) || 0.5));
      const transport = new StdioClientTransport({
        command,
        args: ['serve', '--exclude-tools', READ_ONLY_EXCLUDES],
        env: { ...process.env, ANONYMIZED_TELEMETRY: 'false', WINDOWS_MCP_DISABLE_FLASH: '1', WINDOWS_MCP_SCREENSHOT_SCALE: String(usedScale) },
        stderr: 'ignore',
      });
      const c = new Client({ name: 'surfcore-screen-watch', version: '1' });
      await c.connect(transport);
      log(`[screen-watch] 已连接 Windows-MCP（缩放 ${usedScale}）`);
      return c;
    })();
    try {
      client = await connecting;
      return client;
    } finally {
      connecting = null;
    }
  }

  async function close() {
    const c = client;
    client = null;
    try { await c?.close?.(); } catch {}
  }

  async function capture() {
    let c;
    try {
      c = await open();
    } catch (error) {
      if (error?.code === 'screen.windows-mcp-missing') {
        return fail('screen.windows-mcp-missing', '没装 Windows-MCP，看不到屏幕', 'DSH → 设置 → 桌面（Desktop）里安装 Windows-MCP 依赖，或在 screenWatch.windowsMcpExe 填 windows-mcp.exe 路径');
      }
      return fail('screen.connect-failed', `连不上 Windows-MCP：${String(error?.message ?? error).slice(0, 160)}`, '重启 DSH；仍失败就在 DSH 设置 → 桌面 里重装 Windows-MCP');
    }
    // 缩放改了要重连才生效。
    if (!connect && Math.abs((Number(scale()) || 0.5) - usedScale) > 1e-6) {
      await close();
      return capture();
    }
    let result;
    try {
      result = await c.callTool({
        name: 'Snapshot',
        arguments: { use_vision: true, use_ui_tree: true, use_annotation: false, use_dom: false },
      });
    } catch (error) {
      await close();
      return fail('screen.capture-failed', `截图失败：${String(error?.message ?? error).slice(0, 160)}`, '下一轮会自动重连；一直失败就重启 DSH');
    }
    const parts = Array.isArray(result?.content) ? result.content : [];
    const image = parts.find((p) => p?.type === 'image' && p.data);
    const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
    if (result?.isError || !image) {
      return fail('screen.no-image', `截图没返回图片${result?.isError ? `：${String(text).slice(0, 120)}` : ''}`, '锁屏、UAC 弹窗或全屏独占游戏会截不到；游戏可改成无边框窗口');
    }
    const bytes = Buffer.from(image.data, 'base64');
    const width = bytes.length > 24 ? bytes.readUInt32BE(16) : 0;
    const height = bytes.length > 24 ? bytes.readUInt32BE(20) : 0;
    return {
      ok: true,
      bytes,
      mediaType: image.mimeType || 'image/png',
      width,
      height,
      title: parseFocusedTitle(text),
      thumb: pngThumb(bytes),
    };
  }

  return { capture, close };
}
