// E2E: spawn the real mcp-memory-write server over stdio with an isolated DSH_HOME,
// call the tool, then run the real ingester on the inbox and check the record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath as __f } from 'node:url';
const REPO = __f(new URL('../../../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const sdk = `file:///${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-e2e-'));
// fake active character so activeMemoryPaths() resolves like on the real machine
const charId = 'char-e2etest';
const charDir = path.join(tmpHome, 'surfcore', 'characters', charId);
fs.mkdirSync(path.join(charDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'surfcore', 'characters', 'current.json'),
  JSON.stringify({ version: 1, id: charId, name: 'e2e', epoch: 1, dir: charDir }));
fs.writeFileSync(path.join(tmpHome, 'surfcore', 'characters', 'index.json'),
  JSON.stringify({ version: 1, currentId: charId, epoch: 1, characters: [{ version: 1, id: charId, name: 'e2e', persona: 'persona.md', memory: 'memory', bili: 'bili' }] }));

let fails = 0;
const check = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) fails += 1; };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${REPO}/src/mcp-memory-write.js`],
  env: { DSH_HOME: tmpHome, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '' },
});
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
check(tools.length === 1 && tools[0].name === 'memory_write', 'tools/list exposes exactly memory_write', tools.map((t) => t.name).join(','));

const good = await client.callTool({ name: 'memory_write', arguments: {
  text: '哥们打艾尔登法环拉达恩，二阶段被秒三次，最后靠骨灰过了',
  title: '艾尔登法环·过拉达恩',
  detail: '用的是大剑+狼骨灰，打了大概40分钟，过了之后他喊了一声卧槽终于',
  tags: ['艾尔登法环', '拉达恩', 'boss', '过关'],
  importance: 78,
} });
check(!good.isError && /"ok":true/.test(good.content[0].text), 'valid call succeeds', good.content[0].text);

const minimal = await client.callTool({ name: 'memory_write', arguments: { text: '他在看英雄联盟比赛' } });
check(!minimal.isError, 'minimal call (text only) succeeds');

const bad = await client.callTool({ name: 'memory_write', arguments: { text: 'x' } });
check(bad.isError === true, 'too-short text rejected by schema', String(bad.content?.[0]?.text ?? '').slice(0, 80));

const badScope = await client.callTool({ name: 'memory_write', arguments: { text: '合法长度的文本', scope: 'bili' } });
check(badScope.isError === true, 'scope=bili rejected (pet/qq/shared only)');

await client.close();

const inbox = path.join(charDir, 'memory', 'memory-inbox.jsonl');
check(fs.existsSync(inbox), 'inbox written under ACTIVE character dir', inbox);
const lines = fs.readFileSync(inbox, 'utf8').trim().split('\n');
check(lines.length === 2, 'exactly 2 inbox lines (bad calls wrote nothing)', `got ${lines.length}`);
const row = JSON.parse(lines[0]);
check(row.platform === 'screen' && row.title === '艾尔登法环·过拉达恩' && row.tags.length === 4 && row.importance === 78 && row.scope === 'pet' && row.detail.includes('狼骨灰'),
  'inbox row keeps platform/title/detail/tags/importance/scope');

// run the real ingester
process.env.DSH_HOME = tmpHome;
const mc = await import(`file:///${REPO}/src/memory-card.js?e2e=1`);
const card = mc.createEmptyCard();
const res = mc.ingestInboxLines(card, lines, {});
const recs = card.records.filter((r) => r.source === 'screen-watch');
check(recs.length === 2, 'ingester creates 2 screen-watch records', JSON.stringify(res));
const r = recs.find((x) => x.title.includes('拉达恩'));
check(!!r && r.importance === 78 && r.scope === 'pet' && r.platform === 'pet' && r.tags.includes('screen') && r.tags.includes('拉达恩') && r.detail.includes('狼骨灰'),
  'record has title/detail/tags/importance, scope=pet', r ? JSON.stringify({ title: r.title, imp: r.importance, scope: r.scope, platform: r.platform, tags: r.tags, clarity: r.clarity }) : '');
const auto = recs.find((x) => x.text.includes('英雄联盟'));
check(!!auto && auto.title.startsWith('看屏幕：') && auto.importance >= 1, 'minimal record gets auto title + auto score', auto ? `${auto.title} / ${auto.importance}` : '');

// re-ingesting the same lines must not duplicate
const before = card.records.length;
mc.ingestInboxLines(card, lines, {});
check(card.records.length === before, 're-ingest is idempotent (no duplicates)');

// regression: pet + qq rows still go through their old branches
const legacy = [
  JSON.stringify({ at: new Date().toISOString(), platform: 'pet', kind: 'private', sender: '主人', isOwner: true, private: true, text: '今天好累啊' }),
  JSON.stringify({ at: new Date().toISOString(), platform: 'qq', kind: 'group', sender: '群友A', senderId: '1', text: '有人打瓦吗今晚' }),
];
mc.ingestInboxLines(card, legacy, {});
check(card.records.some((x) => x.source === 'pet-owner'), 'pet rows still -> pet-owner (unchanged)');
check(card.records.some((x) => x.source === 'qq-group'), 'qq rows still -> qq-group (unchanged)');

// bili injection must not include screen (scope=pet) memories
const out = mc.renderMemoryCard ? mc.renderMemoryCard(card, {}) : null;
const biliText = typeof out === 'object' && out ? JSON.stringify(out.promptBili ?? out.bili ?? '') : '';
if (biliText) check(!biliText.includes('拉达恩'), 'scope=pet screen memory NOT in Bili prompt');

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
