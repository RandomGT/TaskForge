import express from 'express';
import cors from 'cors';
import { spawn, spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatFigmaPagesForSplitPrompt } from './src/utils/figmaPages.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = 3721;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CURSOR_PTY_RUNNER = path.join(__dirname, 'scripts', 'cursor_pty_runner.py');

// ---------- helpers ----------

function runCLI(command, args, input, onDataOrHandlers, onDone, options = {}) {
  const handlerBag = typeof onDataOrHandlers === 'object' && onDataOrHandlers !== null
    ? onDataOrHandlers
    : null;
  const normalizedOptions = handlerBag && onDone && typeof onDone === 'object' && typeof onDone !== 'function'
    ? onDone
    : options;
  const env = { ...process.env, FORCE_COLOR: '0' };
  let actualCommand = command;
  let actualArgs = args;

  if (normalizedOptions.usePty) {
    delete env.CI;
    env.TERM = env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color';
    actualCommand = 'python3';
    actualArgs = [CURSOR_PTY_RUNNER, command, ...args];
  }

  console.log(`[runCLI] command=${command} actualCommand=${actualCommand} usePty=${Boolean(normalizedOptions.usePty)} cwd=${normalizedOptions.cwd || process.cwd()} args=${args.length} lastArgLength=${String(args[args.length - 1] || '').length}`);

  const proc = spawn(actualCommand, actualArgs, {
    shell: false,
    cwd: normalizedOptions.cwd || process.cwd(),
    env,
  });

  const onStdout = typeof onDataOrHandlers === 'function' ? onDataOrHandlers : handlerBag?.onStdout;
  const onStderr = handlerBag?.onStderr;
  const doneHandler = handlerBag?.onDone || onDone;
  let stdout = '';
  let stderr = '';

  if (input) {
    proc.stdin.write(input);
    proc.stdin.end();
  }

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (onStdout) onStdout(text);
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (onStderr) onStderr(text);
  });

  proc.on('close', (code) => {
    doneHandler?.({ code, stdout, stderr });
  });

  proc.on('error', (err) => {
    doneHandler?.({ code: -1, stdout, stderr: err.message });
  });

  return proc;
}

function extractCursorText(message) {
  return (message?.content || [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
}

function stripAnsi(text = '') {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function summarizeCursorToolCall(toolCall = {}) {
  const [toolName, payload] = Object.entries(toolCall)[0] || [];
  if (!toolName) return '工具调用';
  const args = payload?.args || {};
  const target = args.path || args.filePath || args.command || args.url || '';
  return `${toolName}${target ? ` ${String(target).slice(0, 120)}` : ''}`;
}

/** 前端用 [[MCP:…]] 做彩色高亮，禁止 label 内含 ] */
function sanitizeMcpLabel(label) {
  const s = String(label ?? '')
    .replace(/\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || 'MCP';
}

function titleCaseRough(str) {
  return String(str)
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function mcpLabelFromFunctionName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  if (!lower.includes('mcp') && !/^mcp[._-]/i.test(n)) {
    return null;
  }
  let rest = n.replace(/^mcp[._-]+/i, '').trim();
  if (!rest || rest.toLowerCase() === 'mcp') rest = n.replace(/mcp/gi, ' ').trim();
  const human = titleCaseRough(rest.replace(/[.]/g, '_'));
  return human || 'MCP';
}

/**
 * 从 stream-json 的 tool_call 中识别 MCP（含 function.name、payload.server 等）
 */
function extractMcpFromToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;

  for (const [toolKey, payload] of Object.entries(toolCall)) {
    if (!payload || typeof payload !== 'object') continue;

    const fromArgsObj = payload.args && typeof payload.args === 'object' ? payload.args : null;
    const serverHint = fromArgsObj?.mcpServer || fromArgsObj?.server || payload.mcpServer || payload.server;
    if (serverHint) {
      return { label: sanitizeMcpLabel(serverHint) };
    }

    if (toolKey === 'function') {
      const fnName = payload.name;
      const fromName = mcpLabelFromFunctionName(fnName);
      if (fromName) return { label: sanitizeMcpLabel(fromName) };

      if (payload.arguments) {
        try {
          const raw = payload.arguments;
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object') {
            const s = parsed.mcpServer || parsed.server || parsed.mcp_server;
            if (s) return { label: sanitizeMcpLabel(s) };
          }
        } catch {
          /* ignore */
        }
      }

      // Cursor 下外部工具多为 MCP，常以 function + name 透出且无 "mcp" 字样
      if (fnName) {
        const rough = titleCaseRough(String(fnName).replace(/_/g, ' '));
        if (rough) return { label: sanitizeMcpLabel(rough) };
      }
    }

    if (/^mcp/i.test(toolKey)) {
      const label = fromArgsObj?.name || fromArgsObj?.tool || toolKey.replace(/^mcp/i, '').replace(/([A-Z])/g, ' $1');
      return { label: sanitizeMcpLabel(titleCaseRough(label) || toolKey) };
    }
  }

  return null;
}

function createCursorStreamState(sendSSE) {
  return {
    buffer: '',
    finalResult: '',
    partialText: '',
    sawEvent: false,
    mcpUsed: new Set(),
    push(chunk) {
      this.buffer += stripAnsi(chunk);
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          sendSSE('chunk', { text: `\n[stdout] ${trimmed}\n` });
          continue;
        }

        this.sawEvent = true;

        if (event.type === 'system' && event.subtype === 'init') {
          const modelText = event.model ? `，模型 ${event.model}` : '';
          sendSSE('chunk', { text: `\n[cursor] 会话已建立${modelText}\n` });
          const mcpList = event.mcp_servers || event.mcpServers || event.tools?.mcp_servers;
          if (Array.isArray(mcpList) && mcpList.length > 0) {
            const names = mcpList
              .map((x) => (typeof x === 'string' ? x : x?.name || x?.server || x?.id))
              .filter(Boolean)
              .map((n) => sanitizeMcpLabel(n));
            names.forEach((n) => this.mcpUsed.add(n));
            const tags = names.map((n) => `[[MCP:${n}]]`).join('、');
            sendSSE('chunk', { text: `\n[cursor] 会话注册的 MCP（来自 CLI init）：${tags}\n` });
          }
          continue;
        }

        if (event.type === 'assistant') {
          const text = extractCursorText(event.message);
          if (text) {
            this.partialText += text;
            sendSSE('chunk', { text });
          }
          continue;
        }

        if (event.type === 'tool_call') {
          const summary = summarizeCursorToolCall(event.tool_call);
          const label = event.subtype === 'started' ? '开始' : '完成';
          const mcp = extractMcpFromToolCall(event.tool_call);
          let mcpPrefix = '';
          if (mcp) {
            if (event.subtype === 'started') {
              this.mcpUsed.add(mcp.label);
            }
            mcpPrefix = `[[MCP:${mcp.label}]] `;
          }
          sendSSE('chunk', { text: `\n[tool] ${mcpPrefix}${label}: ${summary}\n` });
          continue;
        }

        if (event.type === 'result' && event.subtype === 'success') {
          this.finalResult = String(event.result || this.partialText || '').trim();
          const seconds = event.duration_ms ? `${Math.round(event.duration_ms / 1000)}s` : '';
          sendSSE('chunk', { text: `\n[cursor] 已完成${seconds ? `，耗时 ${seconds}` : ''}\n` });
          if (this.mcpUsed.size > 0) {
            const tags = Array.from(this.mcpUsed).map((n) => `[[MCP:${n}]]`).join('、');
            sendSSE('chunk', {
              text: `\n[taskforge] 本轮 Cursor CLI 涉及的 MCP 汇总：${tags}\n`,
            });
          }
        }
      }
    },
    getResultText(rawStdout = '') {
      if (this.finalResult) return this.finalResult;
      if (this.partialText) return this.partialText.trim();
      return String(rawStdout || '').trim();
    },
  };
}

function buildCliArgs(engine, prompt) {
  if (engine === 'claude') {
    return {
      command: 'claude',
      args: ['-p', prompt, '--output-format', 'text'],
      mode: 'text',
    };
  }

  if (engine === 'cursor') {
    return {
      command: 'cursor',
      args: ['agent', '-p', '--output-format', 'stream-json', '--stream-partial-output', '--force', '--approve-mcps', prompt],
      mode: 'cursor-stream-json',
      usePty: true,
    };
  }

  return null;
}

function getCliOptions(cli, cwd) {
  return {
    cwd,
    usePty: Boolean(cli?.usePty),
  };
}

async function fetchSkillsCatalog() {
  const res = await fetch('https://ckai-skills-backend-test2.test.xdf.cn/api/skills');
  if (!res.ok) {
    throw new Error(`Skills API HTTP ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data : [];
}

function buildSkillContextTokens(payload = {}) {
  const textParts = [
    payload.projectName,
    payload.requirementDesc,
    payload.projectPath,
    payload.extraNotes,
    ...(payload.techStack || []),
    ...((payload.projectFiles || []).slice(0, 200)),
    payload.intentDecomposition,
    payload.executionPlan,
    payload.taskOrchestration,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  const tokens = new Set();
  const englishTokens = textParts.match(/[a-z][a-z0-9._-]{2,}/g) || [];
  englishTokens.forEach((token) => tokens.add(token));

  if (/android|gradle|androidmanifest|launcher_|module_|kotlin|kt\b/.test(textParts)) {
    ['android', 'kotlin', 'gradle'].forEach((token) => tokens.add(token));
  }
  if (/compose|@preview|composable/.test(textParts)) {
    ['compose', 'jetpack', 'ui'].forEach((token) => tokens.add(token));
  }
  if (/webview|moonbridge|ipc/.test(textParts)) {
    ['webview', 'moonbridge', 'ipc'].forEach((token) => tokens.add(token));
  }
  if (/figma|design|ui/.test(textParts)) {
    ['figma', 'design', 'ui'].forEach((token) => tokens.add(token));
  }

  return Array.from(tokens);
}

function recommendSkills(skills = [], payload = {}) {
  const contextTokens = buildSkillContextTokens(payload);

  const scored = skills.map((skill) => {
    const fields = [
      skill.name,
      skill.description,
      ...(skill.tags || []),
      ...(skill.keywords || []),
      skill.npmName,
    ].filter(Boolean);
    const haystack = fields.join('\n').toLowerCase();

    let score = 0;
    const matchedTokens = [];
    contextTokens.forEach((token) => {
      if (haystack.includes(token)) {
        score += token.length > 6 ? 3 : 2;
        matchedTokens.push(token);
      }
    });

    if (payload.projectPath?.toLowerCase().includes('android') && haystack.includes('android')) score += 4;
    if ((payload.techStack || []).some((item) => String(item).toLowerCase().includes('kotlin')) && haystack.includes('kotlin')) score += 3;
    if ((payload.techStack || []).some((item) => String(item).toLowerCase().includes('compose')) && haystack.includes('compose')) score += 4;

    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags || [],
      npmName: skill.npmName || '',
      score,
      matchedTokens: Array.from(new Set(matchedTokens)).slice(0, 8),
    };
  });

  return scored
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function listProjectFilesForPrompt(projectPath, maxCount = 260) {
  if (!projectPath) return [];
  try {
    const result = spawnSync(
      'find',
      [
        projectPath,
        '-maxdepth', '4',
        '-type', 'f',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/dist/*',
        '-not', '-path', '*/build/*',
        '-not', '-path', '*/.next/*',
      ],
      { encoding: 'utf8', timeout: 10000, shell: false },
    );
    if (result.error || result.status !== 0) return [];
    return result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, maxCount);
  } catch {
    return [];
  }
}

function buildProjectSnapshotMarkdown(projectPath, incomingFiles = []) {
  const files = (Array.isArray(incomingFiles) && incomingFiles.length)
    ? incomingFiles
    : listProjectFilesForPrompt(projectPath);
  if (!files.length) return '';

  const rel = (p) => p.startsWith(projectPath) ? p.slice(projectPath.length).replace(/^\/+/, '') : p;
  const relFiles = files.map(rel);
  const topFiles = relFiles.slice(0, 80);

  const pick = (matcher, limit = 18) => relFiles.filter(matcher).slice(0, limit);
  const uiFiles = pick((f) => /(^|\/)(components|ui|widgets|views|pages|screens)\//i.test(f));
  const apiFiles = pick((f) => /(^|\/)(api|apis|service|services|request|requests|client)\//i.test(f) || /(api|service|request|client)\.(t|j)sx?$/.test(f));
  const stateFiles = pick((f) => /(^|\/)(store|stores|state|context|redux|zustand)\//i.test(f));
  const styleFiles = pick((f) => /\.(css|scss|less|sass|styl)$/.test(f) || /(^|\/)(styles|theme|tokens)\//i.test(f));
  const iconFiles = pick((f) => /(icon|icons|assets|images|img)\//i.test(f) || /\.(svg|png|jpg|jpeg|webp)$/i.test(f));

  const lines = [
    '## 项目文件快照（用于降低臆测、提高文件级建议准确度）',
    '> 你必须基于该快照与实际仓库检索结果，给出可落地的文件/类/函数级改造建议。',
    '',
    '### 文件样本（截断）',
    ...topFiles.map((f) => `- ${f}`),
    '',
  ];

  const pushGroup = (title, list) => {
    if (!list.length) return;
    lines.push(`### ${title}`);
    list.forEach((f) => lines.push(`- ${f}`));
    lines.push('');
  };

  pushGroup('疑似 UI/页面相关', uiFiles);
  pushGroup('疑似 API/服务相关', apiFiles);
  pushGroup('疑似 状态管理相关', stateFiles);
  pushGroup('疑似 样式/主题相关', styleFiles);
  pushGroup('疑似 图标/资源相关', iconFiles);

  return lines.join('\n').trimEnd();
}

function formatCliError(code, stderr = '', engine = '') {
  const text = String(stderr || '');
  if (/Authentication required/i.test(text)) {
    if (engine === 'cursor') {
      return {
        message: 'Cursor Agent 未登录或无可用凭证。请先运行 `cursor agent login`，或设置 `CURSOR_API_KEY`。',
        stderr: text,
      };
    }
    return {
      message: '当前 AI CLI 缺少认证信息，请先登录或配置凭证。',
      stderr: text,
    };
  }

  return {
    message: `CLI 退出码: ${code}`,
    stderr: text,
  };
}

function runGitSync(projectPath, args, { allowFailure = false, timeout = 30000 } = {}) {
  const result = spawnSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8',
    timeout,
    shell: false,
  });

  if (result.error) {
    throw new Error(result.error.message || `git ${args.join(' ')} 执行失败`);
  }

  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `git ${args.join(' ')} 退出码: ${result.status}`);
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function ensureGitRepository(projectPath) {
  const inside = runGitSync(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (inside.stdout.trim() !== 'true') {
    throw new Error('目标项目不是 Git 仓库，当前无法创建分步回退点');
  }
  const topLevel = runGitSync(projectPath, ['rev-parse', '--show-toplevel']).stdout.trim();
  const head = runGitSync(projectPath, ['rev-parse', 'HEAD']).stdout.trim();
  return { topLevel, head };
}

function sanitizeCheckpointLabel(text) {
  return String(text || '')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'step';
}

function createStepCheckpoint(projectPath, step = {}) {
  const repo = ensureGitRepository(projectPath);
  const beforeStash = runGitSync(projectPath, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFailure: true }).stdout.trim();
  const label = `taskforge-step-${Date.now()}-${sanitizeCheckpointLabel(step.id || step.title || 'step')}`;
  const stashResult = runGitSync(projectPath, ['stash', 'push', '--include-untracked', '-m', label], { allowFailure: true, timeout: 120000 });

  if (stashResult.status !== 0) {
    const detail = (stashResult.stderr || stashResult.stdout || '').trim();
    throw new Error(detail || '创建 Git 快照失败');
  }

  const afterStash = runGitSync(projectPath, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFailure: true }).stdout.trim();
  const createdStash = Boolean(afterStash && afterStash !== beforeStash);

  if (createdStash) {
    try {
      runGitSync(projectPath, ['stash', 'apply', '--index', afterStash], { timeout: 120000 });
    } catch (error) {
      throw new Error(`Git 快照已创建但恢复工作区失败，请先手动检查仓库状态: ${error.message}`);
    }
  }

  return {
    kind: createdStash ? 'stash' : 'clean',
    baseHead: repo.head,
    stashHash: createdStash ? afterStash : '',
    label,
    createdAt: new Date().toISOString(),
  };
}

function rollbackToCheckpoint(projectPath, checkpoint = {}) {
  const repo = ensureGitRepository(projectPath);
  const baseHead = String(checkpoint.baseHead || repo.head).trim();
  if (!baseHead) {
    throw new Error('缺少可回退的基线提交');
  }

  runGitSync(projectPath, ['reset', '--hard', baseHead], { timeout: 120000 });
  runGitSync(projectPath, ['clean', '-fd'], { timeout: 120000 });

  if (checkpoint.kind === 'stash') {
    const stashHash = String(checkpoint.stashHash || '').trim();
    if (!stashHash) {
      throw new Error('缺少可回退的 stash 快照');
    }
    runGitSync(projectPath, ['stash', 'apply', '--index', stashHash], { timeout: 120000 });
  }

  return {
    ok: true,
    head: baseHead,
    kind: checkpoint.kind || 'clean',
  };
}

function readPromptDoc(relativePath) {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

function buildWorkflowPrompt(step1Json, step2Json, projectSnapshotMarkdown) {
  const intentPrompt = readPromptDoc('./docs/意图拆解.md');
  const planPrompt = readPromptDoc('./docs/执行计划.md');
  const taskPrompt = readPromptDoc('./docs/任务编排.md');
  const snapshotBlock = projectSnapshotMarkdown ? `${projectSnapshotMarkdown}\n\n` : '';

  return `你是一名研发编排助手。你需要先读取并分析当前项目（会在当前工作目录中执行），然后基于下面的输入，一次性完成三个阶段的产出：

1. 意图拆解
2. 执行计划
3. 任务编排

## Step1 JSON（需求 & AI 配置）
\`\`\`json
${JSON.stringify(step1Json, null, 2)}
\`\`\`

## Step2 JSON（资源配置）
\`\`\`json
${JSON.stringify(step2Json, null, 2)}
\`\`\`

${snapshotBlock}## 三个阶段对应的 Prompt 模板

### Prompt A：意图拆解
\`\`\`md
${intentPrompt}
\`\`\`

### Prompt B：执行计划
\`\`\`md
${planPrompt}
\`\`\`

### Prompt C：任务编排
\`\`\`md
${taskPrompt}
\`\`\`

## 工作要求

- 必须先结合 Step1、Step2 和当前项目代码结构进行分析
- 必须按顺序生成三个结果：先意图拆解，再执行计划，再任务编排
- Prompt B 必须基于 Prompt A 的输出
- Prompt C 必须基于 Prompt B 的输出
- 输出内容必须尽量遵循各自模板的格式和语气
- 不要输出分析过程
- 不要输出 Markdown 代码块
- 最终严格输出 JSON，字段如下：

\`\`\`json
{
  "intentDecomposition": "字符串，内容为意图拆解的完整 Markdown 文本",
  "executionPlan": "字符串，内容为执行计划的完整 Markdown 文本",
  "taskOrchestration": "字符串，内容为任务编排的完整 Markdown 文本"
}
\`\`\``;
}

function buildStagePrompt(stage, step1Json, step2Json, previousOutputs, projectSnapshotMarkdown) {
  const intentPrompt = readPromptDoc('./docs/意图拆解.md');
  const planPrompt = readPromptDoc('./docs/执行计划.md');
  const taskPrompt = readPromptDoc('./docs/任务编排.md');
  const snapshotBlock = projectSnapshotMarkdown ? `${projectSnapshotMarkdown}\n\n` : '';

  const commonHeader = `你需要在当前项目目录中工作，并先阅读和分析当前项目结构，再输出结果。

## Step1 JSON（需求 & AI 配置）
\`\`\`json
${JSON.stringify(step1Json, null, 2)}
\`\`\`

## Step2 JSON（资源配置）
\`\`\`json
${JSON.stringify(step2Json || {}, null, 2)}
\`\`\`

${snapshotBlock}`;

  if (stage === 'intent') {
    return `${commonHeader}
你现在只需要完成第 1 个阶段：意图拆解。

## 模板
\`\`\`md
${intentPrompt}
\`\`\`

## 执行要求
- 结合项目现状、Step1、Step2 一起理解需求
- 严格按模板输出
- 只输出最终 Markdown 结果
- 不要输出代码块
- 不要输出额外解释`;
  }

  if (stage === 'plan') {
    return `${commonHeader}
你现在只需要完成第 2 个阶段：执行计划。

## 已完成的意图拆解
${previousOutputs?.intentDecomposition || ''}

## 模板
\`\`\`md
${planPrompt}
\`\`\`

## 执行要求
- 必须基于上面的意图拆解结果继续工作
- 结合当前项目结构做技术执行计划
- 严格按模板输出
- 只输出最终 Markdown 结果
- 不要输出代码块
- 不要输出额外解释`;
  }

  if (stage === 'tasks') {
    return `${commonHeader}
你现在只需要完成第 3 个阶段：任务编排。

## 已完成的执行计划
${previousOutputs?.executionPlan || ''}

## 模板
\`\`\`md
${taskPrompt}
\`\`\`

## 执行要求
- 必须基于上面的执行计划继续工作
- 严格按模板输出任务编排结果
- 只输出最终 Markdown 结果
- 不要输出代码块
- 不要输出额外解释`;
  }

  return commonHeader;
}

function buildNormalizeOrchestrationPrompt({
  intentDecomposition = '',
  executionPlan = '',
  taskOrchestration = '',
}) {
  return `你是一名研发任务编排整理助手。请把下面的“任务编排 Markdown”整理成标准 JSON 步骤结构，供前端做分步执行。

你必须遵守：
- 优先从“任务编排 Markdown”中提取步骤。
- 如果字段缺失，可参考“意图拆解”和“执行计划”补全最少必要信息，但不要擅自创造新的需求范围。
- 输出必须是严格 JSON，不要输出 Markdown、解释、代码块。
- 如果某一步缺少任务 ID，则自动生成稳定 ID，格式用 "step-1"、"step-2"。
- dependencies 字段只保留依赖任务 ID 数组；如果是“无”则输出空数组。
- files、acceptanceCriteria、steps 都必须是数组，没有就输出空数组。

输出格式：
{
  "tasks": [
    {
      "id": "TASK-1",
      "title": "步骤标题",
      "description": "步骤说明",
      "dependencies": ["TASK-0"],
      "acceptanceCriteria": ["验收项1"],
      "files": ["src/App.jsx"],
      "steps": ["子步骤1"]
    }
  ]
}

## 意图拆解
${intentDecomposition}

## 执行计划
${executionPlan}

## 任务编排 Markdown
${taskOrchestration}`;
}

// Build the prompt for AI analysis
function buildAnalysisPrompt(requirement, projectPath, techStack, extraNotes, splitStrategy, pageFigmaMarkdown, projectSnapshotMarkdown) {
  const figmaBlock = pageFigmaMarkdown ? `${pageFigmaMarkdown}\n\n` : '';
  const projectSnapshotBlock = projectSnapshotMarkdown ? `${projectSnapshotMarkdown}\n\n` : '';
  return `你是一个专业的研发任务编排助手。请不要直接把原始需求粗暴切成任务，而是先完成“意图拆解”，再给出执行计划，最后生成任务。

## 项目路径
${projectPath}

## 需求描述
${requirement}

${projectSnapshotBlock}${figmaBlock}${techStack.length ? `## 技术栈\n${techStack.join(', ')}` : ''}
${extraNotes ? `## 补充说明\n${extraNotes}` : ''}

## 拆分策略
${splitStrategy === 'feature' ? '按功能拆分 - 每个功能模块一个任务' : ''}
${splitStrategy === 'component' ? '按组件拆分 - 每个UI组件一个任务' : ''}
${splitStrategy === 'custom' ? '自定义拆分 - 根据需求合理拆分' : ''}

## 要求
1. 先分析项目目录结构，了解现有代码
2. 先识别本次需求的主目标、子意图、工程约束、数据契约、UI 还原目标，形成意图拆解结果
3. 再基于项目现状给出执行计划，包括复用建议、影响范围、推荐切片方式
4. 最后再拆分为多个可独立执行的任务
5. 每个任务需要有明确的标题、详细描述、涉及的文件路径、具体的执行步骤；文件路径尽量引用真实存在的代码文件
6. 任务之间需要有合理的依赖关系和执行顺序
5. 若上文已提供「页面级 Figma」，各任务的 description 中须写明**所属页面名称**与界面要点；每个任务的 **prompt** 字段须精炼，用页面名引用设计即可，**禁止在每条 prompt 中重复粘贴全部 Figma URL**（完整链接仅以上文为准）。
7. 每个任务必须体现“复用优先”：优先复用现有组件、主题 token、图标资源和 API 封装，不要平行重造。
8. 每个任务必须给出**改造建议**，细化到文件/类/函数级别（如果是 React 组件，可用组件名/Hook 名替代类名）。
9. 如果信息不足，请把疑问写到 intentGraph.questions 或 executionPlan.blockingQuestions 中，不要偷偷假设。

请严格按照以下 JSON 格式输出（不要输出其他内容）：
\`\`\`json
{
  "analysis": "对项目结构的简要分析",
  "intentGraph": {
    "rootGoal": "本次需求的主交付目标",
    "intents": [
      {
        "id": "intent-1",
        "type": "business_goal|user_interaction|data_contract|ui_realization|engineering_constraint",
        "title": "意图标题",
        "summary": "意图说明",
        "priority": "high|medium|low",
        "source": "requirement",
        "dependsOn": [],
        "acceptanceSignals": ["验收信号1", "验收信号2"],
        "constraints": ["相关约束"]
      }
    ],
    "assumptions": [],
    "questions": [],
    "risks": []
  },
  "executionPlan": {
    "summary": "建议的整体实现路径",
    "reuseCandidates": [
      {
        "target": "可复用资源（组件/工具/样式/API模块）",
        "file": "文件路径",
        "reason": "为何可复用"
      }
    ],
    "affectedAreas": ["受影响目录或模块"],
    "proposedSlices": [
      {
        "intentId": "intent-1",
        "title": "建议切片标题",
        "type": "切片类型"
      }
    ],
    "blockingQuestions": []
  },
  "taskGraph": {
    "tasks": [
      {
        "title": "任务标题",
        "type": "ui_implementation|api_integration|bug_fix|component_extraction|implementation",
        "goal": "任务目标",
        "description": "详细的任务描述",
        "intentIds": ["intent-1"],
        "acceptanceCriteria": ["验收标准"],
        "files": ["涉及的文件路径"],
        "steps": ["具体执行步骤1", "具体执行步骤2"],
        "dependencies": [],
        "changePlan": [
          {
            "path": "文件路径",
            "action": "modify|create|delete",
            "symbols": ["类名/组件名/函数名"],
            "reason": "本文件为何要改"
          }
        ],
        "prompt": "给AI编码助手的完整执行提示词，需要非常详细具体"
      }
    ]
  }
}
\`\`\``;
}

// Build prompt for single task execution（优先使用前端生成的全量 Markdown，已含 Figma MCP / 接口 / 图标等）
function buildExecutionPrompt(task, projectPath, projectContext) {
  const footer = `
## 执行方式（补充）
- 直接修改仓库内代码，不要只给文字建议；确保可运行。
- 涉及 UI 时：先按上文 **Figma MCP** 要求取设计再落代码。
- 涉及网络时：严格按上文 **后端接口** 契约实现。
- 图标与切图：按上文资源路径或工程规范目录引用。
- 先给出简短“实施计划”，明确将修改的文件与组件/函数，再开始改代码。
- 完成后输出“改动摘要”：按文件列出新增/修改的组件、类、方法与复用点。`;

  const rich = task.prompt && String(task.prompt).trim();
  if (rich) {
    let body = String(task.prompt).trim();
    const ctx = (projectContext || '').trim();
    if (ctx && !body.includes(ctx)) {
      body += `\n\n---\n## 项目上下文（补充）\n${ctx}`;
    }
    return `请在项目 \`${projectPath}\` 中执行下列任务。\n**务必遵守文中关于 Figma MCP、后端接口契约与图标/切图资源的全部要求。**\n\n${body}${footer}`;
  }

  return `请在项目 ${projectPath} 中执行以下任务：

## 任务: ${task.title}

## 描述
${task.description}

${task.files && task.files.length ? `## 涉及文件\n${task.files.map(f => `- ${f}`).join('\n')}` : ''}

## 执行步骤
${task.steps ? task.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : task.description}

${projectContext ? `## 项目上下文\n${projectContext}` : ''}

## 要求
- 直接修改代码文件，不要只给建议；**涉及 UI 须 Figma MCP 拉设计**；**接口须与文档一致**；**图标须用规范资源路径**。
- 确保代码可以正确运行
- 遵循项目现有的代码风格和规范
- 如果需要新建文件，请放在合理的目录位置`;
}

// ---------- API routes ----------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/prompt-resources', (req, res) => {
  const { projectPath, files } = req.body || {};

  if (!projectPath || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: projectPath, files' });
  }

  const outputDir = path.join(projectPath, '.taskforge-prompts');

  try {
    mkdirSync(outputDir, { recursive: true });

    const writtenFiles = files.map((file) => {
      const safeName = path.basename(file.filename || '');
      if (!safeName) {
        throw new Error('Invalid filename');
      }

      const targetPath = path.join(outputDir, safeName);
      writeFileSync(targetPath, String(file.content || ''), 'utf8');
      return {
        filename: safeName,
        path: targetPath,
      };
    });

    res.json({
      ok: true,
      outputDir,
      files: writtenFiles,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Failed to write prompt resources',
    });
  }
});

app.post('/api/step-checkpoint', (req, res) => {
  const { projectPath, step } = req.body || {};
  if (!projectPath || !existsSync(projectPath)) {
    return res.status(400).json({ error: '无效的项目路径或目录不存在' });
  }

  try {
    const checkpoint = createStepCheckpoint(projectPath, step || {});
    res.json({
      ok: true,
      checkpoint,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message || '创建步骤回退点失败',
    });
  }
});

app.post('/api/step-rollback', (req, res) => {
  const { projectPath, checkpoint } = req.body || {};
  if (!projectPath || !existsSync(projectPath)) {
    return res.status(400).json({ error: '无效的项目路径或目录不存在' });
  }
  if (!checkpoint || typeof checkpoint !== 'object') {
    return res.status(400).json({ error: '缺少 checkpoint 参数' });
  }

  try {
    const result = rollbackToCheckpoint(projectPath, checkpoint);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message || '回退步骤失败',
    });
  }
});

app.post('/api/recommended-skills', async (req, res) => {
  try {
    const skills = await fetchSkillsCatalog();
    const recommended = recommendSkills(skills, req.body || {});
    res.json({
      ok: true,
      total: skills.length,
      skills: recommended,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to load recommended skills',
      skills: [],
    });
  }
});

const NPM_PACKAGE_SAFE = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function sanitizeNpmPackageList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const name = String(item || '').trim();
    if (!name || name.length > 214 || !NPM_PACKAGE_SAFE.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** npm --prefix 下 node_modules 中某个包的绝对路径 */
function nodeModulesPackageDir(installPrefix, packageName) {
  const nm = path.join(installPrefix, 'node_modules');
  if (packageName.startsWith('@')) {
    const i = packageName.indexOf('/');
    const scope = packageName.slice(0, i);
    const name = packageName.slice(i + 1);
    return path.join(nm, scope, name);
  }
  return path.join(nm, packageName);
}

/** Cursor 项目级目录名，如 @xdf-skills/foo -> xdf-skills-foo */
function cursorSkillDirName(packageName) {
  return packageName.replace(/^@/, '').replace(/\//g, '-');
}

/**
 * 同步到 .cursor/skills 时的复制规则：
 * - 排除包内 node_modules（相对路径段，不误伤 .../node_modules/pkg/ 外层）
 * - 排除 npm 的 bin 目录（仅顶层 bin/，不误伤其他目录名中含 bin 的路径）
 * - 排除所有 package.json
 */
function shouldCopySkillAsset(src, skillContentDir) {
  const rel = path.relative(skillContentDir, src);
  if (!rel || rel === '.') return true;
  const parts = path.normalize(rel).split(path.sep).filter(Boolean);
  if (parts.includes('node_modules')) return false;
  if (parts[0] === 'bin') return false;
  if (parts[parts.length - 1] === 'package.json') return false;
  return true;
}

/**
 * 在 npm 包目录下定位含 SKILL.md 的目录（支持子目录）
 */
function resolveSkillContentDir(packageRootDir, maxDepth = 6) {
  function walk(dir, depth) {
    if (depth > maxDepth) return null;
    if (existsSync(path.join(dir, 'SKILL.md'))) return dir;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules') continue;
      const hit = walk(path.join(dir, ent.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  return walk(path.resolve(packageRootDir), 0);
}

/**
 * 将 npm 包内文件复制到 projectRoot/.cursor/skills/<name>/（Cursor 项目级 Skills）
 * projectRoot 与 Taskforge 第一步「项目路径」一致
 */
function syncPackageIntoProjectCursorSkills(projectRoot, packageName, packageRootDir, sendSSE) {
  const skillContentDir = resolveSkillContentDir(packageRootDir);
  if (!skillContentDir) {
    sendSSE('chunk', {
      text: `[taskforge] 警告: 包 ${packageName} 内未找到 SKILL.md，已跳过写入 .cursor/skills\n`,
    });
    return false;
  }
  const destDirName = cursorSkillDirName(packageName);
  const dest = path.join(projectRoot, '.cursor', 'skills', destDirName);
  mkdirSync(path.join(projectRoot, '.cursor', 'skills'), { recursive: true });
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(skillContentDir, dest, {
    recursive: true,
    filter: (src) => shouldCopySkillAsset(src, skillContentDir),
  });
  sendSSE('chunk', {
    text: `[taskforge] 已写入: ${dest}/\n`,
  });
  return true;
}

app.post('/api/install-skills', (req, res) => {
  const { projectPath, packages: rawPackages } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!projectPath || typeof projectPath !== 'string' || !projectPath.trim()) {
    sendSSE('error', { message: '无效的项目路径（请填写第一步「项目路径」）' });
    res.end();
    return;
  }

  /** 与 Step1 `projectPath` 输入一致，解析为绝对路径后作为 `.cursor/skills` 的根 */
  const projectRoot = path.resolve(projectPath.trim());
  if (!existsSync(projectRoot)) {
    sendSSE('error', { message: '项目路径对应目录不存在，请检查第一步填写是否正确' });
    res.end();
    return;
  }

  const packages = sanitizeNpmPackageList(rawPackages);
  if (packages.length === 0) {
    sendSSE('status', { message: '无待安装的 npm Skill 包，跳过安装' });
    sendSSE('chunk', { text: '[taskforge] 未选择可安装的 npm 包（需勾选 Skill 且含 npm 名称）\n' });
    sendSSE('done', { output: '' });
    res.end();
    return;
  }

  let tmpRoot;
  try {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'taskforge-skills-'));
  } catch (err) {
    sendSSE('error', { message: err.message || '无法创建临时目录' });
    res.end();
    return;
  }
  const installPrefix = path.join(tmpRoot, 'prefix');
  mkdirSync(installPrefix, { recursive: true });

  const npmInstallArgs = [
    ...packages,
    '--prefix',
    installPrefix,
    '--no-fund',
    '--no-audit',
    '--legacy-peer-deps',
  ];

  sendSSE('status', { message: `正在安装 ${packages.length} 个 npm Skill 包...` });
  const skillsRootDir = path.join(projectRoot, '.cursor', 'skills');
  sendSSE('chunk', {
    text: `[taskforge] 项目根目录（第一步「项目路径」）: ${projectRoot}\n`
      + `[taskforge] Skills 将写入: ${skillsRootDir}/\n`
      + `[taskforge] npm 仅在临时目录执行，不会修改该项目的 package.json\n`
      + `[taskforge] npm install ${npmInstallArgs.join(' ')}\n\n`,
  });

  let finished = false;
  const cleanupTmp = () => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const proc = spawn('npm', ['install', ...npmInstallArgs], {
    shell: false,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  proc.stdout.on('data', (chunk) => {
    sendSSE('chunk', { text: chunk.toString() });
  });

  proc.stderr.on('data', (chunk) => {
    sendSSE('chunk', { text: chunk.toString() });
  });

  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    if (code !== 0) {
      cleanupTmp();
      sendSSE('error', {
        message: `npm install 退出码: ${code}`,
        stderr: '请查看上方 npm 输出',
      });
      res.end();
      return;
    }
    try {
      mkdirSync(skillsRootDir, { recursive: true });
      for (const pkg of packages) {
        const pkgDir = nodeModulesPackageDir(installPrefix, pkg);
        if (!existsSync(pkgDir)) {
          sendSSE('chunk', { text: `[taskforge] 警告: 临时安装目录中未找到 ${pkg}\n` });
          continue;
        }
        syncPackageIntoProjectCursorSkills(projectRoot, pkg, pkgDir, sendSSE);
      }
      sendSSE('status', { message: 'Skill 已写入 .cursor/skills' });
      sendSSE('chunk', { text: '\n[taskforge] npm 拉取与 .cursor/skills 同步完成\n' });
      sendSSE('done', { output: '' });
    } catch (err) {
      sendSSE('error', { message: err.message || '同步到 .cursor/skills 失败' });
    } finally {
      cleanupTmp();
      res.end();
    }
  });

  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    cleanupTmp();
    sendSSE('error', { message: err.message || '无法启动 npm' });
    res.end();
  });

  res.on('close', () => {
    if (!finished) {
      finished = true;
      proc.kill('SIGTERM');
      cleanupTmp();
    }
  });
});

// Check which CLI tools are available
app.get('/api/engines', async (req, res) => {
  const engines = [];

  const check = (name, cmd, args = ['--version']) =>
    new Promise((resolve) => {
      const proc = spawn(cmd, args, { shell: false, timeout: 8000 });
      let output = '';
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.stderr.on('data', (d) => (output += d.toString()));
      proc.on('close', (code) => {
        if (code === 0) {
          engines.push({
            name,
            version: output.trim(),
            installed: true,
            authenticated: null,
            authMessage: '',
          });
        }
        resolve();
      });
      proc.on('error', () => resolve());
    });

  const probeCursorAuth = () =>
    new Promise((resolve) => {
      const proc = spawn(
        'cursor',
        ['agent', 'status'],
        { shell: false, timeout: 15000 },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => {
        const engine = engines.find((item) => item.name === 'cursor');
        if (!engine) {
          resolve();
          return;
        }
        const combined = `${stdout}\n${stderr}`;
        engine.authenticated = code === 0 && /logged in/i.test(combined);
        engine.authMessage = code === 0
          ? 'Cursor Agent 已认证，可直接执行'
          : (stderr.trim() || stdout.trim() || 'Cursor CLI 已安装，但未登录或当前凭证不可用。请先执行 cursor agent login，或配置 CURSOR_API_KEY。');
        resolve();
      });
      proc.on('error', (err) => {
        const engine = engines.find((item) => item.name === 'cursor');
        if (engine) {
          engine.authenticated = false;
          engine.authMessage = err.message;
        }
        resolve();
      });
    });

  await Promise.all([
    check('claude', 'claude'),
    check('cursor', 'cursor'),
  ]);

  if (engines.some((item) => item.name === 'cursor')) {
    await probeCursorAuth();
  }

  res.json({ engines });
});

// AI-powered task split (streaming)
app.post('/api/split', (req, res) => {
  const { engine, projectPath, requirement, techStack, extraNotes, splitStrategy, figmaPages, projectFiles } = req.body;

  if (!engine || !projectPath || !requirement) {
    return res.status(400).json({ error: 'Missing required fields: engine, projectPath, requirement' });
  }

  const pageFigmaMarkdown = formatFigmaPagesForSplitPrompt(figmaPages || []);
  const projectSnapshotMarkdown = buildProjectSnapshotMarkdown(projectPath, projectFiles || []);
  const prompt = buildAnalysisPrompt(
    requirement,
    projectPath,
    techStack || [],
    extraNotes || '',
    splitStrategy || 'feature',
    pageFigmaMarkdown,
    projectSnapshotMarkdown,
  );

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendSSE('status', { message: '正在调用 AI 分析项目结构...' });

  let command, args;

  if (engine === 'claude') {
    command = 'claude';
    args = ['-p', prompt, '--output-format', 'text'];
  } else if (engine === 'cursor') {
    command = 'cursor';
    args = ['agent', '-p', '--output-format', 'text', '--force', prompt];
  } else {
    sendSSE('error', { message: `不支持的引擎: ${engine}` });
    res.end();
    return;
  }

  sendSSE('status', { message: `正在通过 ${engine} CLI 分析...` });

  let finished = false;
  const proc = runCLI(
    command,
    args,
    null,
    (chunk) => {
      sendSSE('chunk', { text: chunk });
    },
    ({ code, stdout, stderr }) => {
      finished = true;
      if (code !== 0) {
        sendSSE('error', formatCliError(code, stderr, engine));
        res.end();
        return;
      }

      // Try to extract JSON from the output
      try {
        const jsonMatch = stdout.match(/```json\s*([\s\S]*?)```/) || stdout.match(/(\{[\s\S]*"tasks"[\s\S]*\})/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          sendSSE('result', parsed);
        } else {
          // Try parsing the whole output as JSON
          const parsed = JSON.parse(stdout.trim());
          sendSSE('result', parsed);
        }
      } catch (e) {
        // Return raw text if can't parse JSON
        sendSSE('raw', { text: stdout });
      }
      res.end();
    },
    getCliOptions({ usePty: engine === 'cursor' }, projectPath)
  );

  res.on('close', () => {
    if (!finished) {
      proc.kill();
    }
  });
});

app.post('/api/orchestrate-split', (req, res) => {
  const { engine, projectPath, step1, step2, projectFiles } = req.body;

  if (!engine || !projectPath || !step1) {
    return res.status(400).json({ error: 'Missing required fields: engine, projectPath, step1' });
  }

  const projectSnapshotMarkdown = buildProjectSnapshotMarkdown(projectPath, projectFiles || []);
  const prompt = buildWorkflowPrompt(step1, step2 || {}, projectSnapshotMarkdown);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendSSE('status', { message: '正在编排意图拆解、执行计划与任务编排...' });

  let command, args;
  if (engine === 'claude') {
    command = 'claude';
    args = ['-p', prompt, '--output-format', 'text'];
  } else if (engine === 'cursor') {
    command = 'cursor';
    args = ['agent', '-p', '--output-format', 'text', '--force', prompt];
  } else {
    sendSSE('error', { message: `不支持的引擎: ${engine}` });
    res.end();
    return;
  }

  let finished = false;
  const proc = runCLI(
    command,
    args,
    null,
    (chunk) => {
      sendSSE('chunk', { text: chunk });
    },
    ({ code, stdout, stderr }) => {
      finished = true;
      if (code !== 0) {
        sendSSE('error', formatCliError(code, stderr, engine));
        res.end();
        return;
      }

      try {
        const jsonMatch = stdout.match(/```json\s*([\s\S]*?)```/) || stdout.match(/(\{[\s\S]*"intentDecomposition"[\s\S]*\})/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : stdout.trim());
        sendSSE('result', parsed);
      } catch {
        sendSSE('raw', { text: stdout });
      }
      res.end();
    },
    getCliOptions({ usePty: engine === 'cursor' }, projectPath)
  );

  res.on('close', () => {
    if (!finished) {
      proc.kill();
    }
  });
});

app.post('/api/orchestrate-stage', (req, res) => {
  const { engine, projectPath, stage, step1, step2, previousOutputs, projectFiles } = req.body;

  if (!engine || !projectPath || !stage || !step1) {
    return res.status(400).json({ error: 'Missing required fields: engine, projectPath, stage, step1' });
  }

  const projectSnapshotMarkdown = buildProjectSnapshotMarkdown(projectPath, projectFiles || []);
  const prompt = buildStagePrompt(stage, step1, step2 || {}, previousOutputs || {}, projectSnapshotMarkdown);
  const requestId = `${stage}-${Date.now().toString(36)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendSSE('status', { message: `正在执行阶段: ${stage}` });
  sendSSE('chunk', { text: `[server] 已收到阶段 ${stage} 请求，正在启动 ${engine} CLI...\n` });
  console.log(`[orchestrate-stage] request=${requestId} start stage=${stage} engine=${engine} cwd=${projectPath}`);

  const cli = buildCliArgs(engine, prompt);
  if (!cli) {
    sendSSE('error', { message: `不支持的引擎: ${engine}` });
    res.end();
    return;
  }

  const startedAt = Date.now();
  let lastOutputAt = Date.now();
  let finished = false;
  let sawStdout = false;
  const cursorState = cli.mode === 'cursor-stream-json' ? createCursorStreamState(sendSSE) : null;
  const heartbeat = setInterval(() => {
    if (finished) return;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const silentSec = Math.round((Date.now() - lastOutputAt) / 1000);
    console.log(`[orchestrate-stage] request=${requestId} heartbeat elapsed=${elapsedSec}s silent=${silentSec}s`);
    sendSSE('status', { message: `阶段 ${stage} 进行中，已等待 ${elapsedSec}s` });
    sendSSE('chunk', { text: `[heartbeat] 阶段 ${stage} 运行中，已等待 ${elapsedSec}s，最近输出距今 ${silentSec}s\n` });
  }, 10000);

  sendSSE('chunk', {
    text: cli.mode === 'cursor-stream-json'
      ? '[server] Cursor 已启用 stream-json 流式输出\n'
      : '[server] 当前引擎使用文本流式输出\n',
  });

  const proc = runCLI(
    cli.command,
    cli.args,
    null,
    {
      onStdout: (chunk) => {
        lastOutputAt = Date.now();
        if (!sawStdout) {
          sawStdout = true;
          console.log(`[orchestrate-stage] request=${requestId} first-stdout after=${Math.round((lastOutputAt - startedAt) / 1000)}s`);
        }
        if (cursorState) {
          cursorState.push(chunk);
        } else {
          sendSSE('chunk', { text: chunk });
        }
      },
      onStderr: (chunk) => {
        lastOutputAt = Date.now();
        console.log(`[orchestrate-stage] request=${requestId} stderr=${JSON.stringify(String(chunk).slice(0, 300))}`);
        sendSSE('chunk', { text: `[stderr] ${chunk}` });
      },
      onDone: ({ code, stdout, stderr }) => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        console.log(`[orchestrate-stage] request=${requestId} done code=${code} stdout_len=${stdout.length} stderr_len=${stderr.length} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
        if (code !== 0) {
          sendSSE('error', formatCliError(code, stderr, engine));
          res.end();
          return;
        }
        const output = cursorState ? cursorState.getResultText(stdout) : String(stdout || '').trim();
        sendSSE('result', { stage, output });
        res.end();
      },
    },
    getCliOptions(cli, projectPath)
  );

  res.on('close', () => {
    if (!finished) {
      clearInterval(heartbeat);
      console.log(`[orchestrate-stage] request=${requestId} client-closed`);
      proc.kill();
    }
  });
});

app.post('/api/normalize-orchestration', (req, res) => {
  const {
    engine,
    projectPath,
    intentDecomposition,
    executionPlan,
    taskOrchestration,
  } = req.body || {};

  if (!engine || !projectPath || !taskOrchestration) {
    return res.status(400).json({ error: 'Missing required fields: engine, projectPath, taskOrchestration' });
  }

  const prompt = buildNormalizeOrchestrationPrompt({
    intentDecomposition,
    executionPlan,
    taskOrchestration,
  });

  let command;
  let args;
  if (engine === 'claude') {
    command = 'claude';
    args = ['-p', prompt, '--output-format', 'text'];
  } else if (engine === 'cursor') {
    command = 'cursor';
    args = ['agent', '-p', '--output-format', 'text', '--force', prompt];
  } else {
    return res.status(400).json({ error: `不支持的引擎: ${engine}` });
  }

  runCLI(
    command,
    args,
    null,
    null,
    ({ code, stdout, stderr }) => {
      if (code !== 0) {
        res.status(500).json(formatCliError(code, stderr, engine));
        return;
      }

      try {
        const jsonMatch = stdout.match(/```json\s*([\s\S]*?)```/) || stdout.match(/(\{[\s\S]*"tasks"[\s\S]*\})/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : stdout.trim());
        res.json(parsed);
      } catch (error) {
        res.status(500).json({
          error: '无法解析标准任务步骤 JSON',
          detail: String(stdout || '').slice(0, 4000),
        });
      }
    },
    { cwd: projectPath }
  );
});

// Execute a single task via AI CLI (streaming)
app.post('/api/execute', (req, res) => {
  const { engine, projectPath, task, projectContext } = req.body;

  if (!engine || !projectPath || !task) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const prompt = buildExecutionPrompt(task, projectPath, projectContext || '');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendSSE('status', { message: `正在执行任务: ${task.title}` });
  sendSSE('chunk', { text: `[server] 正在启动 ${engine} CLI...\n` });

  const cli = buildCliArgs(engine, prompt);
  if (!cli) {
    sendSSE('error', { message: `不支持的引擎: ${engine}` });
    res.end();
    return;
  }

  const startedAt = Date.now();
  let lastOutputAt = Date.now();
  let finished = false;
  let timeoutHandle = null;
  const cursorState = cli.mode === 'cursor-stream-json' ? createCursorStreamState(sendSSE) : null;
  const heartbeat = setInterval(() => {
    if (finished) return;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const silentSec = Math.round((Date.now() - lastOutputAt) / 1000);
    sendSSE('status', { message: `执行中，已等待 ${elapsedSec}s` });
    sendSSE('chunk', { text: `[heartbeat] 运行中，已等待 ${elapsedSec}s，最近输出距今 ${silentSec}s\n` });
  }, 10000);

  const proc = runCLI(
    cli.command,
    cli.args,
    null,
    {
      onStdout: (chunk) => {
        lastOutputAt = Date.now();
        if (cursorState) {
          cursorState.push(chunk);
        } else {
          sendSSE('chunk', { text: chunk });
        }
      },
      onStderr: (chunk) => {
        lastOutputAt = Date.now();
        sendSSE('chunk', { text: `[stderr] ${chunk}` });
      },
      onDone: ({ code, stdout, stderr }) => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(timeoutHandle);
        if (code !== 0) {
          sendSSE('error', formatCliError(code, stderr, engine));
        } else {
          const output = cursorState ? cursorState.getResultText(stdout) : stdout;
          sendSSE('done', { output });
        }
        res.end();
      },
    },
    getCliOptions(cli, projectPath)
  );

  res.on('close', () => {
    if (finished) return;
    // 客户端中止 fetch 时先标记结束，避免子进程退出时仍向已关闭的 res 写 SSE
    finished = true;
    clearInterval(heartbeat);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      proc.kill('SIGTERM');
    } catch (_) {
      /* ignore */
    }
  });
});

// List files in project directory
app.post('/api/ls', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }

  const proc = spawn('find', [projectPath, '-maxdepth', '3', '-type', 'f',
    '-not', '-path', '*/node_modules/*',
    '-not', '-path', '*/.git/*',
    '-not', '-path', '*/dist/*',
    '-not', '-path', '*/.next/*',
  ], { shell: false, timeout: 10000 });

  let stdout = '';
  proc.stdout.on('data', (d) => (stdout += d.toString()));
  proc.on('close', (code) => {
    const files = stdout.trim().split('\n').filter(Boolean).slice(0, 200);
    res.json({ files });
  });
  proc.on('error', () => {
    res.json({ files: [] });
  });
});

app.listen(PORT, () => {
  console.log(`🔧 TaskForge API server running at http://localhost:${PORT}`);
});
