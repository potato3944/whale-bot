/**
 * 提示词体积测量 · 算一轮对话到底吃多少 token
 * ─────────────────────────────────────────────
 * 用法：node scripts/measure-prompt.mjs [会话key] [发送者id]
 *   默认按群聊场景估：group:123456 / 3155265157
 *
 * 只读不写，不动 data/。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Role } from '../app/src/role.js';
import { Memory } from '../app/src/memory.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const key = process.argv[2] || 'group:123456';
const uid = process.argv[3] || '3155265157';

const role = new Role({ cardPath: path.join(root, 'app/role.md'), maxChars: 12000 });
const memory = new Memory({ dir: path.join(root, 'app/data') });

const situation = key.startsWith('group')
  ? '你在一个 QQ 群里。下面是群里刚连着说的几句话，最后一条是最新的。'
  : '你在跟 ' + uid + ' 私聊。';

const memLine = memory.renderPerson(uid);
const recent = memory.renderRecent(20, { excludeWhere: key });
const sys = role.build({ situation, memory: memLine, recent });
const userText = '群友A：小鲸鱼你今天怎么这么安静';

/** 粗估：1 汉字 ≈ 1 token，其余字符 ≈ 3.2 字符/token */
function estTokens(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 3.2);
}

const noCard = new Role({ cardPath: path.join(root, 'app/__no_such_card__.md'), maxChars: 12000 });
const baseRulesLen = noCard.build({}).length;
const cardLen = role.read().length;
const rows = [
  ['角色卡（role.md）', cardLen],
  ['基本规矩 BASE_RULES', baseRulesLen],
  ['个人记忆 renderPerson', memLine.length],
  ['近期对话 renderRecent', recent.length],
  ['处境 situation', situation.length],
  ['本轮用户输入', userText.length],
];

console.log('会话      ' + key);
console.log('system    ' + sys.length + ' 字符');
console.log('合计输入  ≈ ' + estTokens(sys + userText) + ' tokens');
console.log('');
for (const [name, len] of rows) {
  const bar = '█'.repeat(Math.max(1, Math.round(len / 300)));
  console.log(name.padEnd(22) + String(len).padStart(6) + ' 字符  ' + bar);
}
console.log('');
console.log('估算输出 ≈ 60~150 tokens（拟人化后 1~3 条短句）');
