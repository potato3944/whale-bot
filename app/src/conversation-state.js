import fs from 'node:fs';
import path from 'node:path';

export function conversationId(key) {
  if (!/^(private|group):\d+$/.test(key)) throw new Error('无效的 QQ 会话标识');
  return key.replace(':', '-');
}

/** 磁盘上的有界近期消息库；没有常驻的全会话消息 Map。 */
export class ConversationState {
  constructor({ dir, limit = 100, maxTextChars = 4000 }) {
    this.dir = dir;
    this.limit = limit;
    this.maxTextChars = maxTextChars;
    fs.mkdirSync(dir, { recursive: true });
  }

  read(key) {
    const file = path.join(this.dir, conversationId(key) + '.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { nextSeq: 1, readThroughSeq: 0, messages: [], recentIds: [] };
    }
  }

  write(key, state) {
    const file = path.join(this.dir, conversationId(key) + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }

  append(msg) {
    const state = this.read(msg.key);
    const id = String(msg.messageId || '');
    if (id && state.recentIds.includes(id)) return null;
    const entry = {
      seq: state.nextSeq++, messageId: id, userId: String(msg.userId || ''),
      replyTo: msg.replyTo ? String(msg.replyTo) : null,
      name: String(msg.name || '').slice(0, 100),
      text: String(msg.text || '').slice(0, this.maxTextChars),
      time: Number(msg.time) || Date.now(), isSelf: Boolean(msg.isSelf),
      hasImages: Boolean(msg.images?.length),
    };
    state.messages.push(entry);
    state.messages = state.messages.slice(-this.limit);
    if (id) state.recentIds = [...state.recentIds, id].slice(-this.limit * 2);
    this.write(msg.key, state);
    return entry;
  }

  snapshot(key, { throughSeq = Infinity, maxChars = 12000 } = {}) {
    const state = this.read(key);
    const available = state.messages.filter(m => m.seq <= throughSeq);
    const unread = available.filter(m => !m.isSelf && m.seq > state.readThroughSeq);
    const messages = [];
    let chars = 0;
    // 从最早未读开始；不能因为提示预算不足而越过未展示的消息。
    for (const msg of unread) {
      const size = JSON.stringify(msg).length;
      if (chars + size > maxChars) break;
      messages.push(msg); chars += size;
    }
    const recent = available.filter(m => m.seq <= state.readThroughSeq || m.isSelf).slice(-4);
    return {
      key, readThroughSeq: state.readThroughSeq,
      throughSeq: messages.at(-1)?.seq ?? state.readThroughSeq,
      unreadCount: unread.length, partial: messages.length < unread.length,
      droppedBeforeSeq: available[0]?.seq ?? state.nextSeq,
      messages, recent,
    };
  }

  markRead(key, throughSeq) {
    const state = this.read(key);
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq >= state.nextSeq) {
      throw new Error('无效的已读水位');
    }
    state.readThroughSeq = Math.max(state.readThroughSeq, throughSeq);
    this.write(key, state);
  }
}

/** 有界串行队列；一项失败不会阻塞后面的项。 */
export class SerialQueue {
  constructor(limit = 32) { this.limit = limit; this.pending = 0; this.tail = Promise.resolve(); }
  run(fn) {
    if (this.pending >= this.limit) return Promise.reject(new Error('处理队列已满，消息仍保留在会话缓存中'));
    this.pending++;
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }
}
