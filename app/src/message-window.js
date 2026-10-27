function extendWindow(batch, policy) {
  if (batch.deadline === undefined) {
    batch.deadline = batch.startedAt + policy.initialMs;
    batch.extensions = 0;
  } else if (batch.extensions < policy.maxExtensions) {
    batch.deadline += policy.extensionMs;
    batch.extensions++;
  }
}

/** 私聊收集窗口：初始等待，补充消息在原截止时间上有限次延长。 */
export class MessageWindow {
  constructor({ initialMs = 5000, extensionMs = 3000, maxExtensions = 4, dispatch,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { initialMs, extensionMs, maxExtensions, dispatch, now, schedule, cancel });
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
    extendWindow(batch, this);
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
  constructor({ initialMs = 5000, extensionMs = 3000, maxExtensions = 4, dispatch, capture = () => ({}),
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { initialMs, extensionMs, maxExtensions, dispatch, capture, now, schedule, cancel });
    this.pending = new Map();
    this.queues = new Map();
    // 从封存起保留，直到真正开始处理（包括提交到全局串行队列之后）。
    this.queued = new Map();
  }

  isQueued(key, userId) { return this.queued.has(`${key}:${userId}`); }

  add(msg, triggered) {
    const now = this.now();
    // 定时器可能因事件循环阻塞而晚执行；先封存截止时间已过的窗口。
    for (const batch of [...(this.queues.get(msg.key) || [])]) {
      if (!batch.ready && now >= batch.deadline) this.finish(batch);
    }
    const id = `${msg.key}:${msg.userId}`;
    let own = this.pending.get(id);
    if (!own && triggered && !this.queued.has(id)) {
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
        extendWindow(batch, this);
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
    this.queued.set(batch.id, batch);
    const queue = this.queues.get(batch.key);
    while (queue?.[0]?.ready) {
      const next = queue.shift();
      const release = () => {
        // 前一轮完成时不能误删同一用户后来入队的新一轮。
        if (this.queued.get(next.id) === next) this.queued.delete(next.id);
      };
      try {
        const completion = this.dispatch(next.items, { ...next.request, onStart: release });
        // 队列拒收或处理失败也释放占位，避免该用户永久无法发起请求。
        if (completion?.then) void completion.then(release, release);
      } catch (error) {
        release();
        throw error;
      }
    }
    if (!queue?.length) this.queues.delete(batch.key);
  }
}
