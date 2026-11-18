// 记忆写入 MCP server（stdio）：让「看屏幕 / 看游戏」等独立会话把观察写进当前角色的记忆卡。
//
// 只做一件事：往当前角色的 memory-inbox.jsonl 追加一行 platform='screen' 的事件。
// 不直接写 memory-card.json —— 插件是记忆卡唯一写者（每 10 分钟摄取 inbox），
// 这里只 append，和桥接 / 桌宠写 inbox 的方式一致，不存在并发覆盖。
// scope 默认 pet：和桌宠记忆一样，QQ / 桌宠读得到，不进 B站。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendMemoryInboxEvent } from './memory-card.js';
import { activeMemoryPaths } from './character-persona.js';

const server = new McpServer({ name: 'memory-write', version: '0.1.0' });

server.tool(
  'memory_write',
  '把你刚看到/经历的一件事写进长期记忆（10 分钟内并入记忆卡，之后聊天时能想起来）。'
    + '写具体：游戏名、角色/Boss 名、发生了什么、他的反应、你的感受。'
    + '只写真实看到的，不编；一件事写一次，不要每张截图都写。',
  {
    text: z.string().min(4).max(500).describe('这件事本身，具体到能回忆细节。例："哥们打艾尔登法环拉达恩，二阶段被秒三次，最后靠骨灰过了"'),
    title: z.string().max(80).optional().describe('短标题，方便扫一眼。例："艾尔登法环·过拉达恩"'),
    detail: z.string().max(500).optional().describe('补充细节：装备、关卡、比分、时长、他说的话等'),
    tags: z.array(z.string().max(24)).max(10).optional().describe('检索关键词，例：["艾尔登法环","拉达恩","boss","过关"]'),
    scope: z.enum(['pet', 'qq', 'shared']).optional().describe('谁能读到：pet=桌宠和QQ（默认）；shared=也给B站'),
    importance: z.number().int().min(1).max(100).optional().describe('1-100，不填自动评分。精彩时刻/第一次 70+，日常 30-50'),
  },
  async ({ text, title, detail, tags, scope, importance }) => {
    const paths = activeMemoryPaths();
    const ok = appendMemoryInboxEvent(paths, {
      at: Date.now(),
      platform: 'screen',
      kind: 'private',
      sender: '自己',
      isSelf: true,
      private: true,
      direct: true,
      conversationKey: 'screen',
      text,
      title,
      detail,
      tags,
      scope,
      importance,
    });
    if (!ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          code: 'memory-write.append-failed',
          error: '写入记忆 inbox 失败（内容为空/被脱敏清空，或目录不可写）',
          hint: '换个说法重写一次；仍失败请检查 DSH_HOME 指向的 surfcore 目录是否存在',
        }) }],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, note: '已记下，10 分钟内并入记忆卡' }) }] };
  },
);

await server.connect(new StdioServerTransport());
