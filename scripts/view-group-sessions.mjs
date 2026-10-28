/** 下载群聊当前 Pi 会话的只读快照，使用 Pi 自带查看器导出 HTML。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let host = 'cn', group = null, open = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--group') group = args[++i];
  else if (args[i] === '--no-open') open = false;
  else throw new Error('用法：npm run sessions:group -- [--group 群号] [--host cn] [--no-open]');
}
if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) throw new Error('SSH 别名格式错误');
if (group !== null && !/^\d+$/.test(group ?? '')) throw new Error('群号须为数字');

const output = path.join(root, 'app/data/group-session-exports', host);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
// 使用包声明的 CLI 入口，避免依赖 Pi 的内部导出模块。
const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piRoot = path.resolve(path.dirname(piEntry), '..');
const piPackage = JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json'), 'utf8'));
const piCli = path.join(piRoot, piPackage.bin.pi);

const remoteScript = `
import os, re, json, base64
root = '/opt/whale-stack/app/data/pi/sessions'
selected = ${group === null ? 'None' : JSON.stringify(group)}
exported = 0
for name in sorted(os.listdir(root)):
    if not re.fullmatch(r'group-[0-9]+', name):
        continue
    if selected is not None and name != 'group-' + selected:
        continue
    directory = os.path.realpath(os.path.join(root, name))
    if os.path.dirname(directory) != os.path.realpath(root):
        raise RuntimeError('Group directory outside session root')
    with open(os.path.join(directory, 'current.json')) as stream:
        pointer = json.load(stream)
    filename = os.path.basename(pointer['file'])
    source = os.path.realpath(os.path.join(directory, filename))
    if os.path.dirname(source) != directory or not filename.endswith('.jsonl'):
        raise RuntimeError('Invalid session file')
    with open(source, 'rb') as stream:
        snapshot = stream.read()
    # 运行中的机器人可能正在追加一行；仅保留已完成的 JSONL 行。
    boundary = snapshot.rfind(b'\\n')
    if boundary < 0:
        raise RuntimeError('Session has no complete lines')
    snapshot = snapshot[:boundary + 1]
    print(json.dumps({'group': name, 'source': filename,
        'data': base64.b64encode(snapshot).decode('ascii')}), flush=True)
    exported += 1
if not exported:
    raise RuntimeError('No matching group sessions')
`;

const ssh = spawn('ssh', ['-C', host, 'python3 -'], { stdio: ['pipe', 'pipe', 'inherit'] });
const completion = new Promise((resolve, reject) => {
  ssh.once('error', reject);
  ssh.once('close', code => code === 0 ? resolve() : reject(new Error(`SSH 导出失败（${code}）`)));
});
// 在读取期间就安装失败处理，避免子进程提前退出产生未处理的拒绝。
void completion.catch(() => {});
ssh.stdin.on('error', () => {});
ssh.stdin.end(remoteScript);
const snapshots = [];
for await (const line of createInterface({ input: ssh.stdout, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  if (!/^group-\d+$/.test(record.group)) throw new Error('服务器返回了无效群号');
  snapshots.push(record);
}
await completion;

const pages = [];
for (const record of snapshots) {
  const jsonl = path.join(output, `${record.group}.jsonl`);
  const html = path.join(output, `${record.group}.html`);
  fs.writeFileSync(jsonl, Buffer.from(record.data, 'base64'), { mode: 0o600 });
  fs.chmodSync(jsonl, 0o600);
  execFileSync(process.execPath, [piCli, '--export', jsonl, html], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
  });
  fs.chmodSync(html, 0o600);
  console.log(`${record.group}: ${html}`);
  pages.push(html);
}
console.log('已导出当前会话快照（群聊输入、模型回复、工具调用及压缩记录）。重新运行可刷新。');
console.log('页面中的 Cost 是 Pi 的定价计算值，不代表套餐实际账单；不会调用模型或重启机器人。');
if (open) {
  if (process.platform === 'darwin') execFileSync('open', pages);
  else console.log('请用浏览器打开以上 HTML 文件。');
}
