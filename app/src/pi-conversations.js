import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentSession, SessionManager, ModelRuntime, DefaultResourceLoader, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { conversationId, SerialQueue } from './conversation-state.js';

/** 仅持有共享模型 runtime；每轮恢复一个 session，结束即 dispose。 */
export class PiConversations {
  constructor({ apiKey, baseUrl, model, dir, timeoutMs, options = {} }) {
    Object.assign(this, { apiKey, baseUrl, model, dir, timeoutMs, options });
    this.dir = path.resolve(dir);
    this.queue = new SerialQueue();
  }

  async initialize() {
    if (this.runtime) return;
    const agentDir = path.join(this.dir, 'agent');
    this.cwd = path.join(this.dir, 'workspace');
    for (const dir of [agentDir, this.cwd]) fs.mkdirSync(dir, { recursive: true });
    const modelsPath = path.join(agentDir, 'models.json');
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: { whale: {
      baseUrl: this.baseUrl, api: 'openai-completions',
      compat: { thinkingFormat: this.options.thinkingFormat || (/deepseek/i.test(this.model) ? 'deepseek' : 'openai') },
      models: [{ id: this.model, reasoning: true, input: ['text', 'image'],
        contextWindow: this.options.contextWindow ?? 131072,
        maxTokens: this.options.maxTokens ?? 4096 }],
    } } }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'), modelsPath,
      modelsStorePath: path.join(agentDir, 'catalog.json'), allowModelNetwork: false,
    });
    // key 只放进 runtime，不写入 models.json 或会话文件。
    await runtime.setRuntimeApiKey('whale', this.apiKey || 'local-no-key');
    this.runtime = runtime;
    this.agentDir = agentDir;
  }

  reply(input) { return this.queue.run(() => this.run(input)); }

  async run({ key, systemPrompt, prompt, images = [], remember, qq, webTools = [] }) {
    await this.initialize();
    const sessionDir = path.join(this.dir, 'sessions', conversationId(key));
    fs.mkdirSync(sessionDir, { recursive: true });
    const pointer = path.join(sessionDir, 'current.json');
    let file;
    try { file = JSON.parse(fs.readFileSync(pointer, 'utf8')).file; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (file && path.dirname(file) !== sessionDir) throw new Error('会话文件越界');
    const manager = file ? SessionManager.open(file, sessionDir) : SessionManager.create(this.cwd, sessionDir);
    const settings = SettingsManager.inMemory({
      cacheWarming: 'off', retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: this.timeoutMs } },
      compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 8192 },
    });
    const loader = new DefaultResourceLoader({
      cwd: this.cwd, agentDir: this.agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, systemPrompt,
    });
    await loader.reload();
    let remembers = 0;
    const rememberTools = qq?.memoryContext ? [] : [{
      name: 'remember', label: '人物记忆', description: '记住当前说话者明确透露的长期信息；不要把其他群友的信息记到此人名下。',
      parameters: Type.Object({
        trait: Type.Optional(Type.String({ maxLength: 60 })),
        fact: Type.Optional(Type.String({ maxLength: 60 })),
        pending: Type.Optional(Type.String({ maxLength: 120 })),
      }),
      async execute(_id, args) {
        if (++remembers > 2) throw new Error('本轮记忆写入已达上限，请直接回复');
        remember(args);
        return { content: [{ type: 'text', text: '{"ok":true}' }], details: {} };
      },
    }];
    const { session } = await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: this.runtime,
      model: this.runtime.getModel('whale', this.model),
      thinkingLevel: this.options.thinkingLevel ?? 'high',
      sessionManager: manager, settingsManager: settings, resourceLoader: loader,
      noTools: 'builtin', tools: [...rememberTools, ...(qq?.tools || []), ...webTools].map(t => t.name),
      customTools: [...rememberTools, ...(qq?.tools || []), ...webTools],
    });
    // Preserve AgentSession's persistence/boundary hooks before deciding whether
    // the completed batch needs another provider request.
    const previousFinishTurn = session.agent.finishTurn;
    let endedByAcknowledgement = false;
    let acknowledgedAssistant;
    session.agent.finishTurn = async (turn, signal) => {
      const previousDecision = await previousFinishTurn?.call(session.agent, turn, signal);
      const calls = turn.message.content.filter(block => block.type === 'toolCall');
      const results = turn.toolResults;
      const acknowledged = results.some(result => result.toolName === 'qq_mark_read' &&
        !result.isError && result.details?.ok === true &&
        (Number.isSafeInteger(result.details.acknowledgedThroughSeq) || result.details.dryRun === true));
      // 发送工具成功即自动确认已读并收尾（见 qq-tools.js），同样视为本轮完成。
      const sentAndAutoAcked = results.some(result => result.toolName === 'qq_send_message' &&
        !result.isError && result.details?.ok !== false &&
        (Number.isSafeInteger(result.details.acknowledgedThroughSeq) || result.details.dryRun === true));
      const allSucceeded = results.length === calls.length &&
        results.every(result => !result.isError && result.details?.ok !== false);
      if (qq?.closed && !qq.failed && !signal?.aborted &&
          turn.message.stopReason === 'toolUse' && (acknowledged || sentAndAutoAcked) && allSucceeded) {
        endedByAcknowledgement = true;
        acknowledgedAssistant = turn.message;
        return { action: 'end' };
      }
      return previousDecision;
    };
    fs.writeFileSync(pointer + '.tmp', JSON.stringify({ file: manager.getSessionFile() }), { mode: 0o600 });
    fs.renameSync(pointer + '.tmp', pointer);
    let timedOut = false;
    let steps = 0;
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant' && ++steps >= 16) {
        void session.abort();
      }
    });
    const timer = setTimeout(() => { timedOut = true; void session.abort(); }, this.timeoutMs);
    try {
      await session.prompt(prompt, { images });
      const last = session.messages.at(-1);
      if (timedOut) throw new Error('模型调用超时');
      if (!endedByAcknowledgement && (last?.role !== 'assistant' || !['stop', 'length'].includes(last.stopReason))) {
        throw new Error(last?.errorMessage || '模型没有完成本轮回复');
      }
      // A valid terminal tool batch ends with tool results, not a synthetic assistant message.
      return { text: endedByAcknowledgement ? '' : session.getLastAssistantText() || '',
        raw: acknowledgedAssistant || last, endedByAcknowledgement };
    } finally {
      clearTimeout(timer); unsubscribe(); session.agent.finishTurn = previousFinishTurn; session.dispose();
    }
  }
}
