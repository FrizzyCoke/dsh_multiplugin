// Does a screen memory actually reach the prompt she reads? (pet/QQ block = what pet chat injects)
import { fileURLToPath as __f } from 'node:url';
const REPO = __f(new URL('../../../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const mc = await import(`file:///${REPO}/src/memory-card.js?vis=1`);
let fails = 0;
const check = (c, l, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); if (!c) fails += 1; };
const now = Date.now();
const row = (o) => JSON.stringify({ at: new Date(now).toISOString(), platform: 'screen', kind: 'private', sender: '自己', isSelf: true, private: true, direct: true, conversationKey: 'screen', ...o });

const card = mc.createEmptyCard(now);
mc.ingestInboxLines(card, [
  row({ text: '哥们打艾尔登法环拉达恩，二阶段被秒三次，最后靠骨灰过了', title: '艾尔登法环·过拉达恩', detail: '大剑+狼骨灰，打了40分钟', tags: ['艾尔登法环', '拉达恩'], scope: 'pet', importance: 78 }),
  row({ text: '哥们在看LPL决赛，BLG三比一赢了', title: 'LPL决赛·BLG赢', tags: ['LPL'], scope: 'shared', importance: 60 }),
], {}, now);

const qq = mc.renderMemoryCard(card, { platform: 'qq', maxChars: 2200, now });
const bili = mc.renderMemoryCard(card, { platform: 'bili', maxChars: 2000, now });
check(qq.includes('拉达恩'), 'scope=pet screen memory IS in pet/QQ prompt (she can recall it)');
check(qq.includes('狼骨灰') || qq.includes('40分钟'), 'detail text reaches the prompt', '(recall of specifics)');
check(!bili.includes('拉达恩'), 'scope=pet screen memory NOT in Bili prompt (matches no-unification choice)');
check(bili.includes('BLG'), 'scope=shared screen memory IS in Bili prompt (opt-in works)');
console.log('\n--- pet/QQ prompt excerpt ---\n' + qq.split('\n').filter((l) => /拉达恩|BLG|狼骨灰|##/.test(l)).join('\n'));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
