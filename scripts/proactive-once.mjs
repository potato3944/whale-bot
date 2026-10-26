/**
 * 一次性手动触发主动搭话（验证/测试用，不经过定时器、不依赖概率）
 * 用法：node scripts/proactive-once.mjs [--seed <灵感>]
 * 单独放一个脚本是为了避开「proactive.js ↔ index.js 循环 import 的 TLA 死锁」。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { loadConfig } = await import(path.join(ROOT, 'app/src/index.js'));
const { Memory } = await import(path.join(ROOT, 'app/src/memory.js'));
const { Role } = await import(path.join(ROOT, 'app/src/role.js'));
const { Brain } = await import(path.join(ROOT, 'app/src/brain.js'));
const { Humanizer } = await import(path.join(ROOT, 'app/src/humanize.js'));
const { Guard } = await import(path.join(ROOT, 'app/src/guard.js'));
const { OneBot } = await import(path.join(ROOT, 'app/src/transport-onebot.js'));
const { Proactive } = await import(path.join(ROOT, 'app/src/proactive.js'));

const cfgIdx = process.argv.indexOf('--config');
const cfg = loadConfig(cfgIdx >= 0 ? process.argv[cfgIdx + 1] : path.join(ROOT, 'app/config.json'));
const memory = new Memory({ dir: cfg.dataDir });
const { RelationshipMemory } = await import('../app/src/relationship-memory.js');
const relationships = cfg.globalRelationships ? new RelationshipMemory({ dir: cfg.dataDir, ownerIds: cfg.ownerIds, ownerNames: cfg.ownerNames }) : undefined;
const role = new Role({ cardPath: cfg.roleCard, maxChars: cfg.roleMaxChars });
const brain = new Brain({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, role, memory, ownerIds: cfg.ownerIds, ownerNames: cfg.ownerNames, relationships });
const human = new Humanizer(cfg.humanize);
const guard = new Guard(cfg.guard);
const bot = new OneBot({ ...cfg.onebot, onMessage: () => {}, onRequest: () => {} });

const seedIdx = process.argv.indexOf('--seed');
const seed = seedIdx >= 0 ? process.argv[seedIdx + 1] : undefined;
const p = new Proactive({ brain, memory, bot, guard, human, ownerId: cfg.ownerIds[0], ownerName: cfg.ownerNames[cfg.ownerIds[0]] || '', cfg: cfg.proactive });
const r = await p.fire({ seed });
console.log(r.sent > 0 ? '已发出。' : '没发出。');
process.exit(0);
