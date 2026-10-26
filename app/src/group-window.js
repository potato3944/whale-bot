/** 群聊固定收集窗口：普通消息只加入，触发消息延长截止时间。 */
export class GroupWindow {
  constructor({ initialMs = 6000, extensionMs = 1000, maxMs = 10000, dispatch,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { initialMs, extensionMs, maxMs, dispatch, now, schedule, cancel });
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
      batch = { items: [], startedAt: now, deadline: now + Math.min(this.initialMs, this.maxMs) };
      this.pending.set(msg.key, batch);
    } else if (triggered) {
      batch.deadline = Math.min(batch.deadline + this.extensionMs, batch.startedAt + this.maxMs);
    }
    batch.items.push({ ...msg, triggered });
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
