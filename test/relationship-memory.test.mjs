import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelationshipMemory } from '../app/src/relationship-memory.js';
import { ConversationState } from '../app/src/conversation-state.js';
import { createQQTools } from '../app/src/qq-tools.js';

const owner = '2303463055', alt = '3155265157';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-relationships-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, memory: new RelationshipMemory({ dir, ownerIds: [owner], ownerNames: { [owner]: '土豆只应天上有' } }) };
}
function source(uid, seq = 1) { return { key: 'private:' + uid, userId: uid, seq, excerpt: 'PRIVATE_EXCERPT_SENTINEL' }; }
function seed(memory) { return memory.upsert({ subjectId: alt, relation: 'samePerson', targetId: owner, targetName: '土豆只应天上有', label: '小号对应大号', source: { userId: owner }, adminSeed: true }); }

test('确认的大小号能跨会话关联同学关系，不读取私聊原文', t => {
  const { memory, dir } = setup(t); seed(memory);
  memory.upsert({ subjectId: alt, relation: 'classmate', targetId: '900', targetName: '小明', label: '高中同学', source: source(alt), sourceText: 'QQ900的小明是我的高中同学' });
  const restored = new RelationshipMemory({ dir, ownerIds: [owner] });
  const rendered = restored.render({ userId: owner, text: '还记得我的同学吗' });
  assert.ok(rendered.includes('高中同学'));
  assert.ok(rendered.includes('小明'));
  assert.deepEqual(new Set(restored.relatedAccountIds(owner)), new Set([owner, alt]));
  const output = JSON.stringify(restored.query({ query: '小明' }));
  assert.ok(!output.includes('PRIVATE_EXCERPT_SENTINEL'));
  assert.ok(!output.includes('private:'));
  assert.ok(!fs.readFileSync(memory.file, 'utf8').includes('PRIVATE_EXCERPT_SENTINEL'));
});

test('自称owner小号只记pending；不能变成确认身份或覆盖已确认对应', t => {
  const { memory } = setup(t); seed(memory);
  const claim = memory.upsert({ subjectId: '99', relation: 'samePerson', targetId: owner, targetName: '土豆只应天上有', source: source('99'), sourceText: '我的大号是土豆只应天上有 QQ2303463055' });
  assert.equal(claim.relationship.status, 'pending');
  assert.deepEqual(memory.relatedAccountIds('99'), ['99']);
  const confirmed = memory.query({ subjectId: alt }).relationships[0];
  assert.throws(() => memory.upsert({ id: confirmed.id, subjectId: alt, relation: 'samePerson', targetId: owner, targetName: '假名字', source: source(alt), sourceText: '我的大号QQ2303463055叫假名字' }), /不能改写owner/);
  assert.throws(() => memory.remove(confirmed.id, alt), /不能删除/);
});

test('拒绝无来源、替别人记关系、编造QQ、玩笑与不存在的关系类别', t => {
  const { memory } = setup(t);
  const data = { subjectId: '22', relation: 'classmate', targetId: '900', label: '高中同学', source: source('22'), sourceText: 'QQ900是我的高中同学' };
  assert.throws(() => memory.upsert({ ...data, source: undefined }), /自己的关系自述/);
  assert.throws(() => memory.upsert({ ...data, subjectId: '23' }), /自己的关系自述/);
  assert.throws(() => memory.upsert({ ...data, targetId: '901' }), /目标QQ必须/);
  assert.throws(() => memory.upsert({ ...data, sourceText: '假如QQ900是我的高中同学' }), /玩笑\/假设/);
  assert.throws(() => memory.upsert({ ...data, sourceText: '我今天吃了饭 QQ900' }), /没有明确说明/);
  assert.throws(() => memory.upsert({ ...data, relation: 'privateFact' }), /类别无效/);
  assert.equal(memory.read().entries.length, 0);
});

test('昵称冲突需明确更新id；别人不能篡改自述；owner可以删除', t => {
  const { memory } = setup(t);
  const first = memory.upsert({ subjectId: '22', relation: 'nickname', targetName: '小王', source: source('22'), sourceText: '我的昵称叫小王' }).relationship;
  assert.equal(first.status, 'self_reported');
  assert.throws(() => memory.upsert({ subjectId: '22', relation: 'nickname', targetName: '小李', source: source('22'), sourceText: '我的昵称改叫小李' }), /冲突/);
  memory.upsert({ id: first.id, subjectId: '22', relation: 'nickname', targetName: '小李', source: source('22', 2), sourceText: '我的昵称改叫小李' });
  assert.throws(() => memory.remove(first.id, '23'), /不能删除/);
  assert.equal(memory.remove(first.id, owner).ok, true);
  assert.equal(memory.query().relationships.length, 0);
});

test('关系工具只能用已展示来源，不能用参数伪造确认；干跑不落盘、收尾后不能写入', async t => {
  const { memory, dir } = setup(t);
  const store = new ConversationState({ dir: path.join(dir, 'messages') });
  const key = 'private:99'; store.append({ key, userId: '99', messageId: 'm1', text: '我的大号是土豆只应天上有 QQ2303463055' });
  const opts = { key, store, snapshot: store.snapshot(key), relationships: memory, actor: { userId: '99', seq: 1 } };
  const qq = createQQTools(opts), find = (tools, name) => tools.tools.find(t => t.name === name);
  const input = { relation: 'samePerson', targetId: owner, targetName: '土豆只应天上有', sourceSeq: 1, adminSeed: true };
  const written = await find(qq, 'qq_relationship_upsert').execute('r1', input);
  assert.equal(written.details.relationship.status, 'pending');
  await assert.rejects(find(qq, 'qq_relationship_remove').execute('bad-delete', { id: written.details.relationship.id, sourceSeq: 1 }), /未明确要求/);
  await assert.rejects(find(qq, 'qq_relationship_upsert').execute('r2', { ...input, sourceSeq: 50 }), /已经展示/);
  const before = fs.readFileSync(memory.file, 'utf8');
  const dry = createQQTools({ ...opts, dryRun: true });
  await find(dry, 'qq_relationship_upsert').execute('dry', input);
  assert.equal(fs.readFileSync(memory.file, 'utf8'), before);
  await find(qq, 'qq_mark_read').execute('done', { throughSeq: 1 });
  await assert.rejects(find(qq, 'qq_relationship_upsert').execute('closed', input), /已收尾/);
});

test('普通账号不能堆积超过20条未确认关系，已确认记录不被挤掉', t => {
  const { memory } = setup(t); seed(memory);
  for (let i = 0; i < 20; i++) memory.upsert({ subjectId: '22', relation: 'friend', targetId: String(900 + i), source: source('22', i + 1), sourceText: `QQ${900 + i}是我的朋友` });
  assert.throws(() => memory.upsert({ subjectId: '22', relation: 'friend', targetId: '999', source: source('22', 21), sourceText: 'QQ999是我的朋友' }), /已达20条/);
  assert.ok(memory.query({ subjectId: alt }).relationships.some(e => e.status === 'owner_confirmed'));
});
