import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SocialMemory } from '../app/src/social-memory.js';
import { ConversationState } from '../app/src/conversation-state.js';
import { createQQTools } from '../app/src/qq-tools.js';

const key = 'private:11';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-social-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.now();
  const memory = new SocialMemory({ dir: path.join(dir, 'memory'), now: () => clock });
  const source = { key, userId: '11', seq: 1, messageId: '1', time: clock, excerpt: '我住杭州' };
  return { dir, memory, source, advance: ms => { clock += ms; } };
}

test('轻量记忆持久化、更新纠错、有限版本和关键词查询', t => {
  const s = setup(t);
  const old = s.memory.upsert(key, { category: 'fact', content: '我住杭州', subjectId: '11', source: s.source }).memory;
  const duplicate = s.memory.upsert(key, { category: 'fact', content: ' 我住杭州 ', subjectId: '11', source: s.source });
  assert.equal(duplicate.memory.id, old.id);
  const updated = s.memory.upsert(key, { id: old.id, category: 'fact', content: '现在住上海', subjectId: '11', source: { ...s.source, seq: 2, excerpt: '我搬到上海了' } });
  assert.equal(updated.memory.id, old.id);
  assert.equal(updated.memory.revisions[0].text, '我住杭州');
  const restored = new SocialMemory({ dir: path.join(s.dir, 'memory') });
  assert.equal(restored.query(key, { query: '上海' }).memories[0].text, '现在住上海');
  assert.equal(restored.query(key, { query: '杭州' }).memories.length, 0);
  assert.ok(restored.render(key, '住哪里').includes(old.id));
  assert.equal(restored.query('group:7').memories.length, 0);
  assert.throws(() => restored.upsert('group:7', { id: old.id, category: 'fact', content: '错', subjectId: '11', source: { ...s.source, key: 'group:7' } }), /不存在/);
  restored.remove(key, old.id);
  assert.equal(restored.query(key).memories.length, 0);
  assert.ok(restored.read(key).entries[0].deletedAt);
});

test('不同记忆有不同有效期，查询时立即过滤，无后台常驻任务', t => {
  const s = setup(t);
  for (const category of ['fact', 'event', 'activeTopic', 'pendingThought', 'memberImpression']) {
    s.memory.upsert(key, { category, content: category + '测试', subjectId: '11', source: s.source });
  }
  s.advance(3 * 3600000);
  assert.equal(s.memory.query(key, { category: 'pendingThought' }).memories.length, 0);
  assert.equal(s.memory.query(key, { category: 'activeTopic' }).memories.length, 1);
  s.advance(25 * 3600000);
  assert.equal(s.memory.query(key, { category: 'activeTopic' }).memories.length, 0);
  s.advance(100 * 24 * 3600000);
  assert.deepEqual(s.memory.query(key).memories.map(m => m.category), ['fact']);
});

test('记录与注入都有界，保留来源、历史更新但不把旧版本注入', t => {
  const s = setup(t);
  for (let i = 0; i < 105; i++) {
    s.advance(1);
    s.memory.upsert(key, { category: 'fact', content: '事实' + i + '字'.repeat(100), subjectId: '11', source: s.source });
  }
  assert.equal(s.memory.read(key).entries.length, 100);
  assert.ok(s.memory.render(key, '事实').length <= 3500);
  assert.ok(s.memory.query(key, { query: '', limit: 20 }).memories.length <= 20);
  assert.throws(() => s.memory.query('../../escape'), /会话标识/);
});

function toolContext(t, { dryRun = false } = {}) {
  const s = setup(t), store = new ConversationState({ dir: path.join(s.dir, 'state') });
  store.append({ key, userId: '11', name: '甲', messageId: '1', text: '我住杭州' });
  store.append({ key, userId: '22', name: '乙', messageId: '2', text: '我是乙' });
  let id = 0;
  const qq = createQQTools({ key, store, snapshot: store.snapshot(key, { throughSeq: 1 }),
    socialMemory: s.memory, actor: { userId: '11', seq: 1 }, dryRun });
  const call = async (name, args) => {
    const result = await qq.tools.find(t => t.name === name).execute('call-' + ++id, args);
    return JSON.parse(result.content[0].text);
  };
  return { ...s, store, qq, call };
}

test('记忆工具验证对象与已展示来源，阻止跨会话和串人写入', async t => {
  const s = toolContext(t);
  await assert.rejects(s.call('qq_memory_upsert', { key: 'group:7', category: 'fact', content: '不该写' }), /跨会话/);
  await assert.rejects(s.call('qq_memory_upsert', { category: 'fact', subjectId: '22', sourceSeq: 1, content: '乙住杭州' }), /本人/);
  await assert.rejects(s.call('qq_memory_upsert', { category: 'fact', sourceSeq: 2, content: '我是乙' }), /已经展示/);
  const result = await s.call('qq_memory_upsert', { category: 'fact', content: '住杭州' });
  assert.equal(result.memory.source.userId, '11');
  assert.equal(result.memory.subjectId, '11');
  assert.equal(result.memory.source.messageId, '1');
  await s.call('qq_mark_read', { throughSeq: 1 });
  await assert.rejects(s.call('qq_memory_remove', { id: result.memory.id }), /收尾/);
});

test('干跑记忆工具不会改记忆文件', async t => {
  const s = toolContext(t, { dryRun: true });
  await s.call('qq_memory_upsert', { category: 'fact', content: '住杭州' });
  assert.equal(s.memory.read(key).entries.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'memory')), []);
});
