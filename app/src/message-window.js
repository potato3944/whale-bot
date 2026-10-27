/** 消息防抖合并窗口：窗口内任何消息都重置倒计时，硬上限封顶。 */
export class MessageWindow {
  constructor({ resetMs = 8000, maxMs = 30000, dispatch,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { resetMs, maxMs, dispatch, now, schedule, cancel });
    this.pending = new Map();
  }

  add(msg, triggered) {
    let batch = this.pending.get(msg.key);
    const now = this.now();
    // 即使事件循环暂时阻塞，也不能把截止后的消息加入上一批。
    if (batch && now >= batch.deadline) {
      this.flush(msg.key);
      batch = undefined;
    }
    if (!batch && !triggered) return false;
    if (!batch) {
      batch = { items: [], startedAt: now };
      this.pending.set(msg.key, batch);
    }
    batch.items.push({ ...msg, triggered });
    // 防抖：每条消息都把截止时间重置为「现在 + resetMs」，同时受整批硬上限约束。
    batch.deadline = Math.min(now + this.resetMs, batch.startedAt + this.maxMs);
    this.cancel(batch.timer);
    batch.timer = this.schedule(() => this.flush(msg.key), Math.max(0, batch.deadline - now));
    return true;
  }

  flush(key) {
    const batch = this.pending.get(key);
    if (!batch) return;
    this.cancel(batch.timer);
    this.pending.delete(key);
    // 先摘下本轮，再提交生成；新消息可以独立开始下一轮。
    this.dispatch(batch.items);
  }
}

/** 群聊按发起人开窗：本人续时，其他人只作背景；到期后按本群入队顺序提交。 */
export class GroupMessageWindow {
  constructor({ resetMs = 8000, maxMs = 30000, dispatch, capture = () => ({}),
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { resetMs, maxMs, dispatch, capture, now, schedule, cancel });
    this.pending = new Map();
    this.queues = new Map();
  }

  add(msg, triggered) {
    const now = this.now();
    // 定时器可能因事件循环阻塞而晚执行；先封存截止时间已过的窗口。
    for (const batch of [...(this.queues.get(msg.key) || [])]) {
      if (!batch.ready && now >= batch.deadline) this.finish(batch);
    }
    const id = `${msg.key}:${msg.userId}`;
    let own = this.pending.get(id);
    if (!own && triggered) {
      own = { id, key: msg.key, items: [], startedAt: now, ready: false,
        request: { ...this.capture(msg), requesterId: String(msg.userId) } };
      this.pending.set(id, own);
      if (!this.queues.has(msg.key)) this.queues.set(msg.key, []);
      this.queues.get(msg.key).push(own);
    }
    let collected = false;
    for (const batch of this.queues.get(msg.key) || []) {
      if (batch.ready) continue;
      // 别人的 @ 属于别人的请求，在本窗口中仅作为群聊背景。
      batch.items.push({ ...msg, triggered: batch === own && triggered });
      collected = true;
      if (batch === own) {
        batch.deadline = Math.min(now + this.resetMs, batch.startedAt + this.maxMs);
        this.cancel(batch.timer);
        batch.timer = this.schedule(() => this.finish(batch), Math.max(0, batch.deadline - now));
      }
    }
    return collected;
  }

  finish(batch) {
    if (batch.ready) return;
    this.cancel(batch.timer);
    batch.ready = true;
    if (this.pending.get(batch.id) === batch) this.pending.delete(batch.id);
    const queue = this.queues.get(batch.key);
    while (queue?.[0]?.ready) {
      const next = queue.shift();
      this.dispatch(next.items, next.request);
    }
    if (!queue?.length) this.queues.delete(batch.key);
  }
}
