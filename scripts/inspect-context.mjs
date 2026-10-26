/**
 * 上下文取证 · 看看模型实际收到的 messages 长什么样
 * ─────────────────────────────────────────────
 * 用法：node scripts/inspect-context.mjs [会话key] [发送者id]
 *
 * 只读：拦截 fetch 打印请求体，record:false 不写记忆。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Role } from '../app/src/role.js';
import { Memory } from '../app/src/memory.js';
import { Brain } from '../app/src/brain.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const key = process.argv[2] || 'private:3155265157';
const uid = process.argv[3] || '3155265157';

const role = new Role({ cardPath: path.join(root, 'app/role.md'), maxChars: 12000 });
const memory = new Memory({ dir: path.join(root, 'app/data') });
const brain = new Brain({ apiKey: 'x', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', role, memory });

let captured = null;
globalThis.fetch = async (url, init) => {
  captured = JSON.parse(init.body);
  return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '（模拟回复）' } }] }) };
};

await brain.reply({
  key,
  userId: uid,
  userName: '土豆',
  text: '土豆：还活着吗',
  situation: key.startsWith('group') ? '你在一个 QQ 群里。' : '你在跟 土豆 私聊。',
  record: false,
});

const msgs = captured.messages;
console.log('会话        ' + key);
console.log('messages 条数 ' + msgs.length + '（1 system + ' + (msgs.length - 1) + ' 条对话）');
console.log('');
msgs.forEach((m, i) => {
  const body = m.content;
  console.log('── [' + i + '] ' + m.role + ' · ' + body.length + ' 字符 ──');
  if (m.role === 'system') {
    const idx = body.indexOf('【最近的真实对话');
    console.log('   …角色卡等设定 ' + (idx >= 0 ? idx : body.length) + ' 字符…');
    console.log(idx >= 0 ? body.slice(idx, idx + 400) : '   （没有注入「最近对话」段）');
  } else {
    console.log('   ' + body.slice(0, 300));
  }
  console.log('');
});
