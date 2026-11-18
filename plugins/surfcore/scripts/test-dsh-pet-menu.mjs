// dsh-pet 右键菜单开关：离线测试。假 dsh-pet 菜单服务按其源码语义（整体覆盖注册 / 点击闩锁 / 读即清空 / unknown-owner）。
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const m = await import(`file:///${REPO}/plugins/surfcore/lib/dsh-pet-menu.js`);
let fails = 0;
const check = (c, l, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); if (!c) fails += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pure ──
const off = m.buildMenu({ enabled: false });
check(off.labels.length === 1 && off.labels[0].includes('关'), 'off: only the "turn on" item');
const on = m.buildMenu({ enabled: true, ...m.SCREEN_PRESETS.mid.patch });
check(on.labels.length === 5, 'on: toggle + 3 presets + look now', on.labels.join(' | '));
check(on.labels.every((l) => l.length <= 32 && !/[\x00-\x1f]/.test(l)) && new Set(on.labels).size === on.labels.length, 'labels valid for dsh-pet (≤32 chars, unique)');
check(on.labels.some((l) => l.startsWith('●') && l.includes('中频')), 'current preset marked ●');
check(m.currentPreset({ ...m.SCREEN_PRESETS.mid.patch, maxCommentsPerHour: 99 }) === 'custom', 'hand-tuned → custom (no preset ticked)');

// ── fake dsh-pet menu server ──
const owners = new Map();
let waiters = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/dsh-pet-7340/menu/item' && req.method === 'POST') {
      const b = JSON.parse(body); owners.set(b.owner, new Map(b.labels.map((l) => [l, null]))); return send(200, { ok: true });
    }
    if (url.pathname === '/dsh-pet-7340/menu/item' && req.method === 'DELETE') { owners.delete(url.searchParams.get('owner')); return send(200, { ok: true }); }
    if (url.pathname === '/dsh-pet-7340/menu/events') {
      const owner = url.searchParams.get('owner');
      if (!owners.has(owner)) return send(404, { ok: false, reason: 'unknown-owner' });
      const fired = () => [...owners.get(owner)?.values() ?? []].some(Boolean);
      if (!fired()) await new Promise((r) => { const t = setTimeout(r, Math.min(Number(url.searchParams.get('wait')) || 0, 300)); waiters.push(() => { clearTimeout(t); r(); }); });
      const items = owners.get(owner); if (!items) return send(404, { ok: false, reason: 'unknown-owner' });
      const out = {}; for (const [l, p] of items) { out[l] = p; items.set(l, null); }
      return send(200, { ok: true, events: out });
    }
    send(404, { ok: false });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const click = (owner, label) => { const items = owners.get(owner); if (items?.has(label)) { items.set(label, 'main'); waiters.splice(0).forEach((w) => w()); return true; } return false; };

let sw = { enabled: false, ...m.SCREEN_PRESETS.mid.patch };
const saved = []; const notes = []; let looks = 0; let changed = 0; let bridgeOn = true;
const menu = m.createDshPetMenu({
  readScreenWatch: () => sw,
  saveScreenWatch: (patch) => { saved.push(patch); sw = { ...sw, ...patch }; },
  bridgeEnabled: () => bridgeOn,
  currentDshUrl: () => base,
  onChanged: () => { changed += 1; },
  onLookNow: () => { looks += 1; },
  notify: (t) => notes.push(t),
  sleep: (ms) => sleep(Math.min(ms, 50)),
});
menu.start();
await sleep(150);
check(owners.get('surfcore')?.size === 1, 'registers on start (off state: 1 item)');

click('surfcore', [...owners.get('surfcore').keys()][0]);
await sleep(300);
check(sw.enabled === true && notes.at(-1)?.includes('开了'), 'click "开" → screen mode on + bubble', notes.at(-1));
check(owners.get('surfcore')?.size === 5 && changed === 1, 'menu re-registered with presets after enabling');

const highLabel = [...owners.get('surfcore').keys()].find((l) => l.includes('高频'));
click('surfcore', highLabel); await sleep(300);
check(sw.chattiness === 'chatty' && sw.maxIntervalSec === 60 && notes.at(-1).includes('高频'), 'click 高频 → preset applied', JSON.stringify(saved.at(-1)));
check([...owners.get('surfcore').keys()].some((l) => l.startsWith('●') && l.includes('高频')), 'menu now shows ● 高频');

click('surfcore', '现在看一眼'); await sleep(300);
check(looks === 1, '现在看一眼 → one look');

owners.clear(); await sleep(500);
check(owners.get('surfcore')?.size === 5, 'dsh-pet restarted (menu wiped) → re-registers automatically');

bridgeOn = false; await sleep(500);
check(!owners.has('surfcore'), 'bridge switched off → menu removed from the pet');
bridgeOn = true; await sleep(500);
check(owners.has('surfcore'), 'bridge back on → menu back');

await menu.stop();
await sleep(100);
check(!owners.has('surfcore'), 'plugin stop → menu removed');
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
