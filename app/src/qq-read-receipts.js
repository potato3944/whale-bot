// Adapted from qq-bridge src/bridge.js, commit a49877f4e58d04e47532d44b803360d0f001160d.
// Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors. MIT.
// Full license: THIRD_PARTY_NOTICES.md. Receipts intentionally live only for one model turn.
function readThroughSeqV2(st, additional = []) {
  const seen = new Set(st.modelSeenSeqs || []);
  for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
  const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
  const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
  const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
  let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
  // A seq may be reached only when it was offered to the model, or when the buffer
  // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
  // again). Scoping the skip to the real buffer range is what keeps this from ever
  // stepping over a still-pending message.
  const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
  while (through < lastUnread && reachable(through + 1)) through += 1;
  return through;
}

function requestedReadThroughSeqV2(st, body, isAgent) {
  if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
  const seq = body.throughSeq;
  const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
    const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
    error.statusCode = 400;
    throw error;
  }
  return seq;
}


export class ReadReceipts {
  constructor(store, key) { this.store = store; this.key = key; this.seen = new Set(); this.visibleSeqs = new Set(); }
  state() {
    const state = this.store.read(this.key);
    const unread = state.messages.filter(m => !m.isSelf && m.seq > state.readThroughSeq);
    const buffered = new Set(unread.map(m => m.seq));
    this.seen = new Set([...this.seen].filter(seq => buffered.has(seq)));
    return {
      unread, lastReadThroughSeq: state.readThroughSeq,
      lastUnreadSeq: Math.max(state.readThroughSeq, ...unread.map(m => m.seq)),
      // whale-bot uses one sequence for incoming and outgoing; self entries are safe gaps.
      modelSeenSeqs: new Set([...this.seen, ...state.messages.filter(m => m.isSelf).map(m => m.seq)]),
    };
  }
  offer(messages) {
    for (const m of messages) if (Number.isSafeInteger(m?.seq)) {
      this.seen.add(m.seq); this.visibleSeqs.add(m.seq);
    }
    return this.cursor();
  }
  cursor() { return readThroughSeqV2(this.state()); }
  wasOffered(seq) { return this.visibleSeqs.has(seq); }
  validate(throughSeq) {
    // Unlike upstream's legacy compatibility path, a cursor is mandatory here.
    if (throughSeq === undefined) throw new Error('必须提供 throughSeq');
    const state = this.state();
    requestedReadThroughSeqV2(state, { throughSeq }, true);
    return throughSeq;
  }
  acknowledge(throughSeq) {
    this.validate(throughSeq);
    this.store.markRead(this.key, throughSeq);
    return throughSeq;
  }
}
