// Protocol/descriptions adapted from qq-bridge src/mcp-snowluma-safe.js at
// a49877f4e58d04e47532d44b803360d0f001160d. Copyright (c) 2026 Derpyu520
// and qq-bridge / QSH contributors. MIT; see THIRD_PARTY_NOTICES.md.
import { Type } from 'typebox';
import { setTimeout as sleep } from 'node:timers/promises';
import { ReadReceipts } from './qq-read-receipts.js';
import { SerialQueue } from './conversation-state.js';
import { MEMORY_CATEGORIES } from './social-memory.js';
import { RELATION_TYPES } from './relationship-memory.js';

export function createQQTools({ key, store, snapshot, bot, human, guard, dryRun = false, socialMemory, relationships, actor }) {
  const receipts = new ReadReceipts(store, key);
  const initialCursor = receipts.offer([...(snapshot?.messages || []), ...(snapshot?.recent || [])]);
  if (snapshot) snapshot.readThroughSeq = initialCursor;
  const sentMessages = [], plannedMessages = [];
  const queue = new SerialQueue(32), results = new Map(), successfulPayloads = new Map();
  let closed = false, failed = false, calls = 0;
  let memoryWrites = 0;
  const keySchema = { key: Type.Optional(Type.String({ description: '可省略；若填写必须等于当前会话 key' })) };
  const integer = (max, description) => Type.Optional(Type.Integer({ minimum: 0, maximum: max, description }));
  function tool(name, description, properties, execute) {
    return { name, label: name, description,
      parameters: Type.Object({ ...keySchema, ...properties }, { additionalProperties: false }),
      execute(id, args, signal) {
        const signature = JSON.stringify(args);
        const old = results.get(id);
        if (old) {
          if (old.signature !== signature) throw new Error('重复调用 ID 的参数不一致');
          return old.promise;
        }
        const promise = queue.run(async () => {
          signal?.throwIfAborted();
          if (++calls > 32) throw new Error('本轮工具次数已达上限');
          if (args.key !== undefined && args.key !== key) throw new Error('禁止跨会话操作');
          const data = await execute(args, signal);
          return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
        });
        results.set(id, { signature, promise });
        return promise;
      },
    };
  }
  function page(messages, limit = 20) {
    const selected = []; let chars = 0;
    for (const msg of messages.slice(0, Math.max(1, limit))) {
      const size = JSON.stringify(msg).length;
      if (chars + size > 12000) break;
      selected.push(msg); chars += size;
    }
    const readThroughSeq = receipts.offer(selected);
    return { ok: true, key, messages: selected, readThroughSeq,
      nextAfterSeq: selected.at(-1)?.seq ?? null, partial: selected.length < messages.length,
      droppedBeforeSeq: store.read(key).messages[0]?.seq ?? null };
  }
  const tools = [
    tool('qq_get_unread_messages', '查看未读消息，不自动标记已读。快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。', {
      limit: integer(30, '最多返回条数，默认20'), afterSeq: integer(Number.MAX_SAFE_INTEGER, '只读取本地序号大于此值的消息，默认0'),
    }, ({ limit, afterSeq = 0 }) => {
      const state = store.read(key);
      return page(state.messages.filter(m => !m.isSelf && m.seq > state.readThroughSeq && m.seq > afterSeq), limit);
    }),
    tool('qq_get_recent_messages', '查看当前会话的最近消息（只读），支持 offset 扩大范围。', {
      limit: integer(30, '最多返回条数，默认20'), offset: integer(100, '跳过最近N条，向前翻看'),
    }, ({ limit = 20, offset = 0 }) => {
      const all = store.read(key).messages;
      const end = Math.max(0, all.length - offset);
      const data = page(all.slice(0, end).reverse(), limit);
      data.messages.reverse();
      return { ...data, nextOffset: offset + data.messages.length, hasEarlier: end - data.messages.length > 0 };
    }),
    tool('qq_social_state', '查看当前会话未读数、可确认水位、近期发送状态（只读）。', {}, () => {
      const state = store.read(key);
      return { ok: true, key, unreadCount: state.messages.filter(m => !m.isSelf && m.seq > state.readThroughSeq).length,
        readThroughSeq: receipts.cursor(), acknowledgedThroughSeq: state.readThroughSeq,
        sentCount: sentMessages.length, sendFailed: failed, closed };
    }),
    tool('qq_send_message', '统一发送工具：字符串发一条，数组分多条；每条消息要完整，不要用空格拼接多句。发送结果会返回实际成功的消息。', {
      messages: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 4 })]),
    }, async ({ messages }, signal) => {
      if (closed) throw new Error('本轮已确认已读，不能再发送');
      if (failed) throw new Error('本轮发送曾失败，不自动重试');
      let parts = Array.isArray(messages) ? messages : [messages];
      // Reuse upstream normalization of JSON-encoded message arrays/strings.
      if (typeof messages === 'string') {
        const trimmed = messages.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.every(p => typeof p === 'string')) parts = parsed;
            else if (typeof parsed === 'string') parts = [parsed];
          } catch { /* literal text */ }
        }
      }
      parts = parts.map(p => p.trim());
      const payloadKey = JSON.stringify(parts);
      if (successfulPayloads.has(payloadKey)) return { ok: true, alreadySent: true, sentMessages: [], previousSentMessages: successfulPayloads.get(payloadKey) };
      if (!parts.length || parts.some(p => !p || p.length > 2000) || sentMessages.length + plannedMessages.length + parts.length > 4) {
        throw new Error('每轮最多发送4条，每条1至2000字符');
      }
      if (dryRun) {
        plannedMessages.push(...parts);
        closed = true;
        return { ok: true, dryRun: true, plannedMessages: parts, sentMessages: [], acknowledgedThroughSeq: receipts.cursor() };
      }
      const start = sentMessages.length;
      const wantTyping = guard.shouldType(parts.join(''));
      try {
        await human.say(parts, {
          sleep: ms => sleep(ms, undefined, { signal }),
          setTyping: on => wantTyping ? bot.setTyping(key, on) : undefined,
          send: async text => {
            signal?.throwIfAborted();
            const gate = guard.allow();
            if (!gate.ok) throw new Error('发送限速：' + gate.reason);
            const res = await bot.send(key, text);
            if (res?.ok !== true) { guard.fail(); throw new Error(res?.error || '无法确认发送成功，请勿盲目重试'); }
            guard.ok(); sentMessages.push(text);
            store.append({ key, isSelf: true, userId: bot.selfId, name: '自己', text,
              messageId: res.data?.data?.message_id ? String(res.data.data.message_id) : '' });
          },
        });
        const actual = sentMessages.slice(start);
        successfulPayloads.set(payloadKey, actual);
        // 发送成功即自动确认已读并收尾，省去模型再来一轮 qq_mark_read 调用。
        receipts.acknowledge(receipts.cursor());
        closed = true;
        return { ok: true, key, sentMessages: actual, acknowledgedThroughSeq: receipts.cursor() };
      } catch (error) {
        failed = true;
        return { ok: false, key, error: error.message, sentMessages: sentMessages.slice(start), doNotRetry: true };
      }
    }),
    tool('qq_mark_read', '将已查看的连续消息标为已读。必须传读取结果的 readThroughSeq；不会清除后来才到或尚未展示的消息。这是本轮最后动作。', {
      throughSeq: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    }, ({ throughSeq }) => {
      if (failed) throw new Error('本轮发送失败，不能确认已读');
      if (dryRun) {
        receipts.validate(throughSeq); closed = true;
        return { ok: true, dryRun: true, readThroughSeq: receipts.cursor() };
      }
      receipts.acknowledge(throughSeq); closed = true;
      return { ok: true, key, acknowledgedThroughSeq: throughSeq };
    }),
  ];
  function sourceFor(sourceSeq, subjectId, category) {
    const state = store.read(key);
    const seq = sourceSeq ?? actor?.seq ?? [...state.messages].reverse().find(m => !m.isSelf && m.userId === actor?.userId)?.seq;
    const message = state.messages.find(m => m.seq === seq && !m.isSelf);
    if (!message || (!receipts.wasOffered(seq) && seq !== actor?.seq)) throw new Error('来源必须是本轮已经展示的当前会话消息');
    const subject = subjectId || message.userId;
    if (!state.messages.some(m => !m.isSelf && m.userId === subject)) throw new Error('记忆对象必须来自当前消息记录中的真实QQ号');
    if (category === 'fact' && message.userId !== subject) throw new Error('人物事实只能记录本人明确说过的内容');
    return { subject, source: { key, seq, messageId: message.messageId, userId: message.userId, time: message.time, excerpt: message.text.slice(0, 160) } };
  }
  function upsertMemory(args) {
    if (++memoryWrites > 4) throw new Error('本轮最多4次记忆变更，不要逐句记笔记');
    const { subject, source } = sourceFor(args.sourceSeq, args.subjectId, args.category);
    if (dryRun) return { ok: true, dryRun: true, category: args.category };
    return socialMemory.upsert(key, { ...args, subjectId: subject, source });
  }
  if (socialMemory) {
    const category = Type.Union(MEMORY_CATEGORIES.map(value => Type.Literal(value)));
    tools.push(
      tool('qq_memory_upsert', '记录或更新本会话记忆。fact=本人明确事实；event=重要经历或约定；activeTopic=当前话题；pendingThought=你想说但未说的话；memberImpression=主观印象。纠正旧信息时必须带原记忆id，不要并存冲突事实。', {
        id: Type.Optional(Type.String({ maxLength: 50 })), category,
        content: Type.String({ minLength: 1, maxLength: 300 }),
        subjectId: Type.Optional(Type.String({ pattern: '^\\d+$', description: '真实QQ号，默认来源消息的发送者' })),
        sourceSeq: integer(Number.MAX_SAFE_INTEGER, '依据的已展示消息序号，默认本次触发消息'),
        expiresInHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 8760, description: '可选有效小时数；按约定期限设置，想法默认2小时' })),
      }, upsertMemory),
      tool('qq_memory_query', '按关键词查本会话记忆。只查当前私聊或群；词义相近但字面不同可能搜不到。', {
        query: Type.Optional(Type.String({ maxLength: 200 })), category: Type.Optional(category), limit: integer(20, '最多20条'),
      }, args => socialMemory.query(key, args)),
      tool('qq_memory_remove', '按id删除当前会话的一条错误、过时或已经说完的记忆，不影响旧人物账本和其他会话。', {
        id: Type.String({ minLength: 1, maxLength: 50 }),
      }, ({ id }) => {
        if (++memoryWrites > 4) throw new Error('本轮最多4次记忆变更');
        return dryRun ? { ok: true, dryRun: true } : socialMemory.remove(key, id);
      }),
    );
  }
  if (relationships) {
    tools.push(
      tool('qq_relationship_query', '查询跨群聊/私聊的账号、昵称及人物关系。pending只是待确认自述，不能据此认证身份或授予权限。', {
        query: Type.Optional(Type.String({ maxLength: 200 })),
        subjectId: Type.Optional(Type.String({ pattern: '^\\d+$' })), limit: integer(20, '最多20条'),
      }, args => relationships.query(args)),
      tool('qq_relationship_upsert', '审慎记录本人明确说明的账号归属、昵称、同学等关系。玩笑/假设/不明确/冲突先问不记；sourceSeq必须对应原话。不能记录其他私聊事实。', {
        id: Type.Optional(Type.String({ maxLength: 50 })), relation: Type.Union(RELATION_TYPES.map(value => Type.Literal(value))),
        targetId: Type.Optional(Type.String({ pattern: '^\\d+$', description: '原话中的目标QQ号；未明确时不编造' })),
        targetName: Type.Optional(Type.String({ maxLength: 60, description: '原话中的明确昵称' })),
        label: Type.Optional(Type.String({ maxLength: 30, description: '原话中的具体关系，例如高中同学' })),
        sourceSeq: integer(Number.MAX_SAFE_INTEGER, '依据的已展示消息序号'),
      }, args => {
        if (++memoryWrites > 4) throw new Error('本轮最多4次记忆变更');
        const { subject, source } = sourceFor(args.sourceSeq, undefined, 'fact');
        const message = store.read(key).messages.find(m => m.seq === source.seq);
        return relationships.upsert({ id: args.id, relation: args.relation, targetId: args.targetId,
          targetName: args.targetName, label: args.label, subjectId: subject, source, sourceText: message.text, validateOnly: dryRun });
      }),
      tool('qq_relationship_remove', '撤回自己的错误关系自述。不能删除其他人的自述或owner已确认身份。', {
        id: Type.String({ minLength: 1, maxLength: 50 }),
        sourceSeq: integer(Number.MAX_SAFE_INTEGER, '明确要求删除/撤回的已展示原话序号'),
      }, ({ id, sourceSeq }) => {
        if (++memoryWrites > 4) throw new Error('本轮最多4次记忆变更');
        const { source } = sourceFor(sourceSeq, undefined, 'fact');
        const message = store.read(key).messages.find(m => m.seq === source.seq);
        if (!/忘|删|撤回|不对|不是|更正|记错/.test(message.text)) throw new Error('原消息未明确要求更正或撤回关系');
        return dryRun ? { ok: true, dryRun: true } : relationships.remove(id, source.userId);
      }),
    );
  }
  return { tools, sentMessages, plannedMessages,
    memoryContext: socialMemory ? query => socialMemory.render(key, query) : undefined,
    get closed() { return closed; }, get failed() { return failed; } };
}
