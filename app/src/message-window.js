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
