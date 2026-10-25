/**
 * companion · 命令行入口
 * ─────────────────────────────────────────────────────────────
 * 把各层拼起来跑：
 *
 *   OneBot(收消息) → Waker(要不要醒) → Brain(生成回复)
 *                                        ↓
 *                                   Humanizer(怎么发)
 *                                        ↓
 *                                   OneBot(发消息)
 *
 * 用法：
 *   node src/index.js --config ./config.json
 *   node src/index.js --config ./config.json --dry-run   只打印，不真发
 *   node src/index.js --check                            只检查角色卡
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from './memory.js';
import { Role, PRIVATE_RULES } from './role.js';
import { Brain } from './brain.js';
import { Humanizer } from './humanize.js';
import { Waker } from './wake.js';
import { OneBot } from './transport-onebot.js';
import { Guard } from './guard.js';
import { Proactive } from './proactive.js';
import { ConversationState, SerialQueue } from './conversation-state.js';
import { SocialMemory } from './social-memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 预设的模型后端。填 custom 就全靠 config.json 自己写。 */
const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama:   { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: 'ollama' },
  openai:   { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));

  const provider = cfg.provider || 'deepseek';
  const preset = PROVIDERS[provider] || {};

  return {
    provider,
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || preset.apiKey || '',
    baseUrl: cfg.baseUrl || preset.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || preset.model || 'deepseek-chat',
    engine: cfg.engine || 'pi',
    pi: cfg.pi || {},
    socialMemory: cfg.socialMemory !== false,

    roleCard: rel(cfg.roleCard, 'role.md'),
    privateRoleCard: cfg.privateRoleCard ? rel(cfg.privateRoleCard) : path.join(__dirname, '..', 'role.private.md'),
    roleMaxChars: cfg.roleMaxChars || 12000,
    dataDir: rel(cfg.dataDir, 'data'),

    onebot: {
      wsUrl: cfg.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: cfg.onebot?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: cfg.onebot?.accessToken || '',
    },

    names: cfg.names || [],
    keywords: cfg.keywords || [],
    ownerIds: (cfg.ownerIds || []).map(String),

    wake: {
      probability: cfg.wake?.probability ?? 0.05,
      groupAtOnly: cfg.wake?.groupAtOnly !== false,
      privateWindowMs: cfg.wake?.privateWindowMs ?? 1500,
      groupWindowMs: cfg.wake?.groupWindowMs ?? 6000,
    },

    humanize: cfg.humanize || {},
    guard: cfg.guard || {},
    proactive: cfg.proactive || {},
    dryRun: process.argv.includes('--dry-run'),
  };
}

// ── 主程序 ────────────────────────────────────────────────────
async function main() {
  const cfgIdx = process.argv.indexOf('--config');
  const cfg = loadConfig(cfgIdx >= 0 ? process.argv[cfgIdx + 1] : null);

  console.log('════════ companion ════════');
  console.log('  后端      ' + cfg.provider + ' · ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  会话引擎  ' + cfg.engine);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  私聊卡    ' + cfg.privateRoleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + cfg.onebot.wsUrl);
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('');

  const memory = new Memory({ dir: cfg.dataDir });
  const role = new Role({ cardPath: cfg.roleCard, maxChars: cfg.roleMaxChars });
  const privateRole = new Role({ cardPath: cfg.privateRoleCard, maxChars: cfg.roleMaxChars, baseRules: PRIVATE_RULES });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (!privateRole.read()) throw new Error('私聊角色卡读不到：' + cfg.privateRoleCard);
  const privateLint = privateRole.lint();
  if (!privateLint.ok) privateLint.warn.forEach(w => console.log('⚠️ 私聊角色卡：' + w));
  if (process.argv.includes('--check')) { console.log('检查完毕。'); return; }
  // 本地端点（ollama / mock）不需要 key，远程的缺 key 就一定会失败
  const localBrain = /127\.0\.0\.1|localhost/.test(cfg.baseUrl);
  if (!cfg.apiKey && !localBrain) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  if (!['pi', 'legacy'].includes(cfg.engine)) throw new Error('engine 必须为 pi 或 legacy');
  const brain = new Brain({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, role, privateRole, memory, engine: cfg.engine, pi: cfg.pi });
  const conversations = new ConversationState({ dir: path.join(cfg.dataDir, 'conversations') });
  const socialMemory = cfg.socialMemory ? new SocialMemory({ dir: path.join(cfg.dataDir, 'social-memory') }) : undefined;
  const turns = new SerialQueue();
  const human = new Humanizer(cfg.humanize);
  const guard = new Guard(cfg.guard);
  const waker = new Waker({
    names: cfg.names,
    keywords: cfg.keywords,
    ownerIds: cfg.ownerIds,
    probability: cfg.wake.probability,
    batchWindowMs: cfg.wake.groupWindowMs,
  });

  /** @type {Map<string, NodeJS.Timeout>} 每个会话的合并定时器 */
  const pending = new Map();

  const bot = new OneBot({
    ...cfg.onebot,
    onRequest: (ev) => {
      if (ev.request_type === 'friend') {
        console.log('[申请] 好友申请来自 ' + ev.user_id + '，等待管理员在 QQ 手动处理');
      } else if (ev.request_type === 'group' && ev.sub_type === 'invite') {
        console.log('[申请] 群邀请（群 ' + ev.group_id + ' 邀请人 ' + ev.user_id + '），等待管理员在 QQ 手动处理');
      } else {
        console.log('[申请] ' + (ev.request_type || '') + ' 来自 ' + ev.user_id + '（没处理）');
      }
    },
    onMessage: (msg) => {
      // 先保留聊天现场，再判定唤醒；重复推送不重复回应。
      try {
        const entry = conversations.append(msg);
        if (!entry) return;
        msg.conversationSeq = entry.seq;
      }
      catch (e) { console.error('[消息缓存失败] ' + e.message); return; }
      // 第一次见到这个会话 → 给个默认策略
      if (!waker.configs.has(msg.key)) {
        waker.setConfig(msg.key, msg.isGroup
          ? {
              mode: 'diving',
              atMention: true,
              nameMention: !cfg.wake.groupAtOnly,
              question: !cfg.wake.groupAtOnly,
              poke: true,
              probability: cfg.wake.groupAtOnly ? 0 : cfg.wake.probability,
            }
          : { mode: 'active', anyMessage: true });   // 私聊每条都理
      }

      const verdict = waker.shouldWake(msg);
      const isOwner = cfg.ownerIds.includes(msg.userId);
      if (!verdict.wake && !isOwner) {
        if (msg.isGroup) console.log('[静音] ' + msg.name + '：' + msg.text.slice(0, 40));
        return;
      }
      console.log('[醒·' + (verdict.reason || 'owner') + '] ' + msg.name + '：' + msg.text.slice(0, 60));

      // 合并窗口：等人把话说完
      const win = msg.isGroup ? cfg.wake.groupWindowMs : cfg.wake.privateWindowMs;
      clearTimeout(pending.get(msg.key));
      const batch = waker.batch(msg);
      const dispatch = (items) => turns.run(() => handleTurn({ bot, brain, human, memory, waker, guard, conversations, socialMemory }, items, cfg))
        .catch((e) => console.error('[出错] ' + (e?.message || e)));
      if (batch.ready) { pending.delete(msg.key); void dispatch(batch.batch); return; }
      pending.set(msg.key, setTimeout(() => {
        pending.delete(msg.key);
        const items = waker.flush(msg.key);
        if (!items.length) return;
        void dispatch(items);
      }, win));
    },
  });

  const proactive = new Proactive({
    brain, memory, bot, guard, human, conversations,
    ownerId: cfg.ownerIds[0],
    cfg: cfg.proactive,
  });
  proactive.start();

  process.on('unhandledRejection', (e) => console.error('[未处理] ' + (e?.message || e)));
  process.on('SIGINT', () => { console.log('\n再见。'); process.exit(0); });

  console.log('在跑了。Ctrl+C 退出。\n');
}

/** 处理一轮（可能是合并后的多条） */
export async function handleTurn({ bot, brain, human, memory, waker, guard, conversations, socialMemory }, items, cfg) {
  const last = items[items.length - 1];
  const key = last.key;
  if (cfg.engine === 'pi' && last.conversationSeq !== undefined &&
      last.conversationSeq <= conversations?.read(key).readThroughSeq) {
    console.log('   （触发消息已由前一轮工具处理，跳过重复回合）');
    return;
  }
  const text = Waker.joinBatch(items);
  const images = items.flatMap((i) => i.images || []).slice(0, 3);   // 一批最多喂 3 张，防炸请求体

  const situation = last.isGroup
    ? '你在一个 QQ 群里。下面是群里刚连着说的几句话，最后一条是最新的。'
    : '你在跟 ' + last.name + ' 私聊。';

  const snapshot = conversations?.snapshot(key, { throughSeq: last.conversationSeq ?? Infinity });
  let qq;
  if (cfg.engine === 'pi' && conversations) {
    const { createQQTools } = await import('./qq-tools.js');
    qq = createQQTools({ key, store: conversations, snapshot, bot, human, guard, dryRun: cfg.dryRun, socialMemory,
      actor: { userId: last.userId, name: last.name, seq: last.conversationSeq } });
  }
  const { text: out } = await brain.reply({ key, userId: last.userId, userName: last.name, text, situation, images, snapshot, qq });
  if (qq) {
    console.log(cfg.dryRun ? '   [干跑] 计划发送 ' + qq.plannedMessages.length + ' 条' : '   工具实际发出 ' + qq.sentMessages.length + ' 条；已读确认=' + qq.closed);
    if (qq.sentMessages.length) { waker.wake(key); memory.touch(last.userId, { name: last.name }); }
    return; // 普通 assistant 文本不再自动转发，也不自动确认已读。
  }
  if (!out) { console.log('   （没说话）'); return; }

  if (cfg.dryRun) { console.log('   [干跑] 会说：' + out); return; }

  // 输入态要不要报：由风控层决定真人感，避免一分钟报上百次
  const wantTyping = guard.shouldType(out);

  let delivered = true;
  const r = await human.say(out, {
    setTyping: (on) => (wantTyping ? bot.setTyping(key, on) : undefined),
    send: async (m) => {
      const gate = guard.allow();
      if (!gate.ok) { delivered = false; console.log('   [限速] ' + gate.reason + '，这条没发出去'); return false; }
      const res = await bot.send(key, m);
      if (res?.ok !== true) {
        delivered = false;
        guard.fail();
        console.log('   [发送失败] ' + (res?.error || '未知错误'));
        return false;
      } else {
        guard.ok();
        conversations?.append({ key, isSelf: true, text: m, userId: bot.selfId, name: '自己' });
        return true;
      }
    },
  });
  if (delivered && snapshot) conversations.markRead(key, snapshot.throughSeq);
  console.log('   发出 ' + r.sent + ' 条：' + r.parts.slice(0, r.sent).map((p) => p.slice(0, 18)).join(' | '));
  waker.wake(key);
  memory.touch(last.userId, { name: last.name });
}

// 直接跑才启动；被 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('启动失败：' + (e?.stack || e)); process.exit(1); });
}
