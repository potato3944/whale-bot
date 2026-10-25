// Adapted from qq-bridge formatMemoryV2, commit a49877f4e58d04e47532d44b803360d0f001160d.
// Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors. MIT; see THIRD_PARTY_NOTICES.md.
export function formatMemoryV2(st, now = Date.now()) {
  if (!st) return '';
  const lines = [];
  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    lines.push('【进行中的话题】');
    for (const t of topics.slice(-10)) {
      const ago = t.lastMentionAt ? Math.round((now - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && now - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
      lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
    }
  }
  const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < t.expiresAt)) : [];
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts.slice(-10)) {
      lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
    }
  }
  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length) {
    lines.push('【对群友的印象】');
    for (const name of names.slice(-10)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
    }
  }
  return lines.join('\n');
}
