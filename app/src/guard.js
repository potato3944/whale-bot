/**
 * 防风控 · 给机器人上保险
 * ─────────────────────────────────────────────────────────────
 * 腾讯对机器人有风控。发太快 → 限速；持续作死 → 封号。
 * 作者的原话教训：某次把发送上限调成 20 条/分钟，发送通道卡了 23 分钟，
 * 桥接每 15 秒重试一次，一天下来失败 14 次 vs 成功 18 次，
 * 腾讯直接开始不回包，整整一天发不出消息。
 *
 * 三道保险：
 *   1. 速率限制   —— 每分钟 / 每小时发送条数上限
 *   2. 熔断器     —— 连续失败 N 次就停 M 分钟，期间连试都不试
 *   3. 输入态节流 —— "正在输入"最频繁，但真人不会一分钟报 175 次
 *
 * 这一层对上游是透明的：业务代码照常调 send()，超限就在这里被挡掉。
 */

const DEFAULTS = {
  maxSendPerMinute: 6,
  maxSendPerHour: 80,
  failThreshold: 3,      // 连续失败几次就熔断
  openMs: 180000,        // 熔断多久（3 分钟）
  typing: {
    enabled: true,
    minCharsForTyping: 20,   // 短消息不发输入态
    minIntervalMs: 45000,    // 两次输入态至少隔 45 秒
    probability: 0.35,       // 35% 概率才发
  },
};

export class Guard {
  constructor(opts = {}) {
    const t = { ...DEFAULTS.typing, ...(opts.typing || {}) };
    this.maxSendPerMinute = opts.maxSendPerMinute ?? DEFAULTS.maxSendPerMinute;
    this.maxSendPerHour = opts.maxSendPerHour ?? DEFAULTS.maxSendPerHour;
    this.failThreshold = opts.failThreshold ?? DEFAULTS.failThreshold;
    this.openMs = opts.openMs ?? DEFAULTS.openMs;

    this.typingEnabled = t.enabled !== false;
    this.typingMinChars = t.minCharsForTyping ?? DEFAULTS.typing.minCharsForTyping;
    this.typingMinIntervalMs = t.minIntervalMs ?? DEFAULTS.typing.minIntervalMs;
    this.typingProbability = t.probability ?? DEFAULTS.typing.probability;

    /** @type {number[]} 最近发送时间戳 */
    this.sent = [];
    this.consecutiveFails = 0;
    this.openUntil = 0;
    this.lastTypingAt = 0;
    this.stats = { sent: 0, blocked: 0, failed: 0, breakerOpened: 0 };
  }

  /** 熔断器是否开着 */
  isOpen() {
    if (this.openUntil > Date.now()) return true;
    if (this.openUntil && this.openUntil <= Date.now()) {
      this.openUntil = 0;
      this.consecutiveFails = 0;   // 冷却结束，重新计数
    }
    return false;
  }

  /** 能不能发一条 */
  allow() {
    if (this.isOpen()) {
      const left = Math.ceil((this.openUntil - Date.now()) / 1000);
      return { ok: false, reason: '熔断中，还剩 ' + left + ' 秒' };
    }
    const now = Date.now();
    const minAgo = this.sent.filter((t) => now - t < 60000).length;
    if (minAgo >= this.maxSendPerMinute) {
      return { ok: false, reason: '一分钟上限 ' + this.maxSendPerMinute + ' 条已满' };
    }
    const hourAgo = this.sent.filter((t) => now - t < 3600000).length;
    if (hourAgo >= this.maxSendPerHour) {
      return { ok: false, reason: '一小时上限 ' + this.maxSendPerHour + ' 条已满' };
    }
    return { ok: true };
  }

  /** 发成功 */
  ok() {
    this.consecutiveFails = 0;
    this.sent.push(Date.now());
    this.stats.sent++;
    // 只留一小时的记录，别让数组无限长
    const cutoff = Date.now() - 3600000;
    while (this.sent.length && this.sent[0] < cutoff) this.sent.shift();
  }

  /** 发失败 */
  fail() {
    this.consecutiveFails++;
    this.stats.failed++;
    if (this.consecutiveFails >= this.failThreshold) {
      this.openUntil = Date.now() + this.openMs;
      this.stats.breakerOpened++;
      this.consecutiveFails = 0;
    }
  }

  /** 要不要报"正在输入…" */
  shouldType(text) {
    if (!this.typingEnabled) return false;
    if ([...String(text || '')].length < this.typingMinChars) return false;
    if (Date.now() - this.lastTypingAt < this.typingMinIntervalMs) return false;
    if (Math.random() > this.typingProbability) return false;
    this.lastTypingAt = Date.now();
    return true;
  }

  /** 熔断器状态，给控制台/日志看 */
  status() {
    return {
      ...this.stats,
      consecutiveFails: this.consecutiveFails,
      breakerOpen: this.isOpen(),
      openUntil: this.openUntil,
      sentLastMinute: this.sent.filter((t) => Date.now() - t < 60000).length,
      sentLastHour: this.sent.filter((t) => Date.now() - t < 3600000).length,
    };
  }
}

export default Guard;
