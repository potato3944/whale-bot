/**
 * 主动搭话 · 让她在没有消息的时候也活着
 * ─────────────────────────────────────────────────────────────
 * 整个 bot 原来是纯反应式的：只有收到消息才会动。
 * 这个模块给一条「心跳」：每隔一段时间醒来看一眼，
 * 掷个骰子决定要不要主动找主人说句话。
 *
 * 安全阀（宁可闷，不可炸）：
 *   1. 只找主人，绝不主动给陌生人/群发消息
 *   2. 深夜不扰（quietStart ~ quietEnd）
 *   3. 每天硬上限 maxPerDay，到顶就闭嘴
 *   4. 刚聊过不久不打扰（minSilenceMin）
 *   5. 发送仍走 Guard 限速，跟正常回复同一套风控
 *
 * 效果调节：baseProb 是每格检查的触发概率；沉默越久越想说话
 * （4 小时 ×2，8 小时 ×3），模仿「想你了」的黏人感。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 主动开口的灵感池，随机抽一个让模型自由发挥 */
const SEEDS = [
  '你刚想到一件想跟他说的小事',
  '你有点想他了',
  '你看到一个好玩的梗，想分享给他',
  '你想问问他现在在干嘛',
  '你想汇报一下自己刚才在干嘛（摸鱼/吃饭/发呆）',
  '你想跟他吐槽一件刚发生的事',
  '你饿了，想拉他一起吃点什么',
  '你想起上次跟他聊到一半的事，想接着问',
  '你想关心他一下（一句就好，别婆婆妈妈）',
  '你刚发现一个有趣的东西，想告诉他',
];

export class Proactive {
  /**
   * @param {object} opts
   * @param {Brain} opts.brain
   * @param {Memory} opts.memory
   * @param {OneBot} opts.bot
   * @param {Guard} opts.guard
   * @param {Humanizer} opts.human
   * @param {string} opts.ownerId    主人 QQ 号
   * @param {object} [opts.cfg]      config.proactive
   * @param {(s:string)=>void} [opts.log]
   */
  constructor({ brain, memory, bot, guard, human, conversations, ownerId, ownerName = '', cfg = {}, log = console.log }) {
    this.brain = brain;
    this.memory = memory;
    this.bot = bot;
    this.guard = guard;
    this.human = human;
    this.conversations = conversations;
    this.ownerId = String(ownerId || '');
    this.ownerName = String(ownerName || '');
    this.enabled = cfg.enabled !== false;
    this.checkMin = Math.max(5, Number(cfg.checkMin) || 15);
    this.baseProb = Number(cfg.baseProb ?? 0.1);
    this.maxPerDay = Number(cfg.maxPerDay ?? 6);
    this.minSilenceMin = Number(cfg.minSilenceMin ?? 20);
    this.quietStart = Number(cfg.quietStart ?? 23);
    this.quietEnd = Number(cfg.quietEnd ?? 8);
    this.stateFile = path.join(memory.dir, 'proactive.json');
    this.log = log;
    this.timer = null;
  }

  // ── 状态（每天计数清零，重启也不丢）──────────────────────────
  #loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }
  #saveState(s) {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(s), 'utf8'); } catch {}
  }
  #state() {
    const d = new Date().toLocaleDateString('sv');   // 本地时区的 YYYY-MM-DD
    const s = this.#loadState();
    if (s.date !== d) return { date: d, count: 0, lastAt: 0 };
    return s;
  }

  #inQuietHours() {
    const h = new Date().getHours();
    if (this.quietStart <= this.quietEnd) return h >= this.quietStart && h < this.quietEnd;
    return h >= this.quietStart || h < this.quietEnd;   // 跨午夜，如 23~8
  }

  #lastTurnAt() {
    const rows = this.memory.recentTurns(1);
    return rows.length ? rows[0].t : 0;
  }

  /** 这一格要不要动（纯判定，无副作用） */
  shouldFire() {
    if (!this.enabled || !this.ownerId) return false;
    if (this.#inQuietHours()) return false;
    const s = this.#state();
    if (s.count >= this.maxPerDay) return false;
    const silence = Date.now() - this.#lastTurnAt();
    if (silence < this.minSilenceMin * 60000) return false;
    let p = this.baseProb;
    if (silence > 8 * 3600e3) p *= 3;
    else if (silence > 4 * 3600e3) p *= 2;
    return Math.random() < Math.min(0.5, p);
  }

  /** 真的说一次（定时器或手动 --once 都走这里） */
  async fire({ seed } = {}) {
    const name = this.ownerName || (this.memory.person(this.ownerId).name) || '主人';
    const now = new Date();
    const when = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const pick = seed || SEEDS[Math.floor(Math.random() * SEEDS.length)];
    const key = 'proactive:' + this.ownerId;

    const { text: out } = await this.brain.reply({
      key,
      userId: this.ownerId,
      userName: name,
      text: '（这条不是他发来的。你决定主动找他说句话。现在 ' + when + '，灵感：「' + pick + '」。直接开口说，别用括号解释、别加任何前缀。）',
      situation: '现在没有人在跟你说话。你主动想跟 ' + name + ' 说点什么，这是你发起的话题。',
      record: false,
    });
    if (!out) { this.log('   [主动] 想说话但憋回去了'); return { sent: 0, text: '' }; }

    const wantTyping = this.guard.shouldType(out);
    const sentParts = [];
    const r = await this.human.say(out, {
      setTyping: (on) => (wantTyping ? this.bot.setTyping(key, on) : undefined),
      send: async (m) => {
        const gate = this.guard.allow();
        if (!gate.ok) { this.log('   [主动·限速] ' + gate.reason + '，这条没发出去'); return false; }
        const res = await this.bot.send(key, m);
        if (res?.ok !== true) { this.guard.fail(); this.log('   [主动·失败] ' + (res?.error || '未知错误')); return false; }
        else {
          this.guard.ok();
          this.conversations?.append({ key: 'private:' + this.ownerId, isSelf: true,
            userId: this.bot.selfId, name: '自己', text: m });
          sentParts.push(m);
          return true;
        }
      },
    });

    if (!r.sent) return { sent: 0, text: '' };

    const s = this.#state();
    s.count += 1;
    s.lastAt = Date.now();
    this.#saveState(s);
    this.memory.logTurn({ where: key, who: name, text: '', reply: sentParts.join('\n') });
    this.log('   [主动] ' + when + ' 找 ' + name + ' 说了 ' + r.sent + ' 条（今日 ' + s.count + '/' + this.maxPerDay + '）：'
      + sentParts.map((p) => p.slice(0, 18)).join(' | '));
    return { sent: r.sent, text: sentParts.join('\n') };
  }

  /** 挂定时器：每 checkMin 分钟醒一次 */
  start() {
    if (!this.enabled) { this.log('   [主动] 未启用（proactive.enabled=false）'); return; }
    if (this.timer) return;
    this.log('   [主动] 定时器已挂：每 ' + this.checkMin + ' 分钟掷一次骰子，每天最多 ' + this.maxPerDay
      + ' 次主动搭话，' + this.quietStart + '~' + this.quietEnd + ' 点休眠，静默 ' + this.minSilenceMin + ' 分钟以上才会开口');
    this.timer = setInterval(() => this.tick(), this.checkMin * 60000);
    setTimeout(() => this.tick(), 5 * 60000);   // 起搏：挂上 5 分钟后先看一眼
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick() {
    try {
      if (!this.shouldFire()) return;
      await this.fire();
    } catch (e) { this.log('   [主动] 出错 ' + (e?.message || e)); }
  }
}

export default Proactive;
