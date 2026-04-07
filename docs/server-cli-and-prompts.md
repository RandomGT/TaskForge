# Server（`server.js`）命令与 Prompt 一览

本文档梳理后端实际调用的**外部命令**、**子进程**，以及注入 AI CLI 的 **Prompt 来源与结构**。实现以仓库内 `server.js` 为准。

---

## 环境变量（与 CLI 相关）

| 变量 | 作用 |
|------|------|
| `TASKFORGE_CURSOR_AGENT_BIN` | Cursor 引擎使用的可执行文件名或绝对路径；未设置时默认为 `agent`。 |
| `CURSOR_API_KEY` | Cursor Agent 凭证（由 CLI 读取；非 server 直接解析，但在错误提示中会引导配置）。 |

常量 `CURSOR_AGENT_BIN` = `process.env.TASKFORGE_CURSOR_AGENT_BIN || 'agent'`。

---

## 外部命令与子进程总表

### AI 引擎（`runCLI` → `spawn`）

对所有「打印/流式」类调用，若 CLI 配置 `usePty: true`，则实际进程为：

- **`python3`** + `scripts/cursor_pty_runner.py` + `[真实命令, ...参数]`  
  PTY 包装用于 Cursor 引擎的交互/终端特性。

否则直接：

- **`spawn(actualCommand, actualArgs, { shell: false, cwd, env })`**

| 场景 | 引擎标识 `engine` | 命令 | 主要参数模式 |
|------|-------------------|------|----------------|
| 引擎探测 | — | `claude` | `--version` |
| 引擎探测 | — | `CURSOR_AGENT_BIN`（默认 `agent`） | `--version` |
| Cursor 登录探测 | — | `CURSOR_AGENT_BIN` | `status` |
| 任务拆分（旧 `/api/split`） | `claude` | `claude` | `-p`, `<prompt>`, `--output-format`, `text` |
| 任务拆分（旧 `/api/split`） | `cursor` | `CURSOR_AGENT_BIN` | `-p`, `--output-format`, `text`, `--force`, `<prompt>` + **PTY** |
| 编排一次性（`/api/orchestrate-split`） | 同上 | 同上 | 同上 |
| 编排分阶段（`/api/orchestrate-stage`） | `claude` | `claude` | `-p`, `<prompt>`, `--output-format`, `text` |
| 编排分阶段（`/api/orchestrate-stage`). `cursor` | `CURSOR_AGENT_BIN` | `-p`, `--output-format`, `stream-json`, `--stream-partial-output`, `--force`, `--approve-mcps`, `<prompt>` + **PTY** |
| 规范化步骤 JSON（`/api/normalize-orchestration`） | 同上两引擎 | 同上「text」模式 | 与 orchestrate-split 一致 |
| 单任务执行（`/api/execute`） | 由 `buildCliArgs` | 与 `orchestrate-stage` 相同规则 | `cursor` 为 stream-json + PTY |

`buildCliArgs` 摘要：

- **Claude**：`claude -p <prompt> --output-format text`
- **Cursor**：`<CURSOR_AGENT_BIN> -p --output-format stream-json --stream-partial-output --force --approve-mcps <prompt>`

---

### 项目文件 listing

| 用途 | 命令 | 说明 |
|------|------|------|
| `buildProjectSnapshotMarkdown` / 列表 | `find` | `spawnSync`：`projectPath`, `-maxdepth`, `4`, 排除 `node_modules`、`.git`、`dist`、`build`、`.next` |
 POST `/api/ls` | `find` | `-maxdepth` `3`，同等排除规则 |

---

### Git

均通过 `runGitSync(projectPath, args)` → **`git`**，常见子命令包括：

- `rev-parse --is-inside-work-tree`
- `branch`、`branch -a`、`symbolic-ref HEAD` 等（分支列表）
- `checkout`、`-b` 新建分支
- `rev-parse` 校验引用
- `stash`、`reset --hard` 等（与 step checkpoint / rollback 相关）

具体参数以实现中 `ensureGitBranch`、`collectGitBranches`、checkpoint 逻辑为准。

---

### npm（Skills 安装）

| 路由 | 命令 | 参数 |
|------|------|------|
| `POST /api/install-skills` | `npm` | `install` + 各包名（在临时目录执行） |

---

## HTTP 出站（非 Prompt，供对照）

| 用途 | URL |
|------|-----|
| Skills 目录拉取 | `https://ckai-skills-backend-test2.test.xdf.cn/api/skills`（`fetchSkillsCatalog`） |

---

## Prompt：构建函数与使用位置

以下为 **`server.js` 内拼接或组装的字符串**，会作为 AI CLI 的 `-p` 内容（或写在请求体再交由 CLI）。

### 1. `buildAnalysisPrompt`

- **用于**：`POST /api/split`（旧版一次性拆分流水线）。
- **输入**：`requirement`, `projectPath`, `techStack`, `extraNotes`, `splitStrategy`, `pageFigmaMarkdown`, `projectSnapshotMarkdown`。
- **内容要点**：
  - 角色：专业研发任务编排助手；先意图拆解 → 执行计划 → 任务。
  - 嵌入：项目路径、需求、项目快照、Figma 块、技术栈、补充说明、拆分策略说明。
  - 约束：Figma 与任务 `prompt` 字段、复用优先、改造建议粒度、`intentGraph.questions` / `blockingQuestions` 等。
  - **输出**：要求严格 JSON，含 `analysis`、`intentGraph`、`executionPlan`、`taskGraph`（内含 `tasks[].prompt` 等）。

### 2. `buildWorkflowPrompt`

- **用于**：`POST /api/orchestrate-split`（若走「一次性三阶段」编排）。
- **内容要点**：
  - 读取本地文档并嵌入：
    - `./docs/意图拆解.md`
    - `./docs/执行计划.md`
    - `./docs/任务编排.md`
  - 嵌入 Step1、Step2 的 **JSON**，以及 `projectSnapshotMarkdown`。
  - 要求按顺序产出三份 Markdown 逻辑结果，**最终只输出一个 JSON**，字段：`intentDecomposition`、`executionPlan`、`taskOrchestration`（均为字符串）。

### 3. `buildStagePrompt`

- **用于**：`POST /api/orchestrate-stage`，按 `stage` 分次调用。
- **`stage` 取值**：
  - `intent`：仅意图拆解 + 模板 `意图拆解.md`。
  - `plan`：执行计划 + 模板 `执行计划.md`，依赖上一轮 `previousOutputs.intentDecomposition`。
  - `tasks`：任务编排 + 模板 `任务编排.md`，依赖 `previousOutputs.executionPlan`。
- **公共部分**：Step1/Step2 JSON、项目快照；各阶段要求「只输出最终 Markdown、不要代码块」。

### 4. `buildNormalizeOrchestrationPrompt`

- **用于**：`POST /api/normalize-orchestration`。
- **内容要点**：把「任务编排 Markdown」整理成标准 JSON `{ "tasks": [ { id, title, description, dependencies, acceptanceCriteria, files, steps } ] }`；可参照意图拆解、执行计划补全，但不杜撰需求；输出纯 JSON。

### 5. `buildExecutionPrompt`

- **用于**：`POST /api/execute`（单任务执行）。
- **分支**：
  - 若 `task.prompt` 非空：以该 Markdown 为主干，强调项目路径、Figma MCP / 接口 / 图标约束，附 **`footer`**（实施计划、改动摘要等要求）；可选附加 `projectContext`。
  - 否则：用 `task.title`、`description`、`files`、`steps`、`projectContext` 拼一版后备说明，并含执行要求（改文件、Figma MCP、接口、资源路径等）。

---

## 磁盘上的 Prompt 模板文件（被 `readPromptDoc` 读入）

路径相对于 `server.js` 所在目录：

| 文件 | 用途 |
|------|------|
| `docs/意图拆解.md` | 编排流水线 Prompt A / `intent` 阶段 |
| `docs/执行计划.md` | Prompt B / `plan` 阶段 |
| `docs/任务编排.md` | Prompt C / `tasks` 阶段 |

---

## API 与 CLI/Prompt 对应简表

| 方法 | 路径 | 调用的 CLI | Prompt 来源 |
|------|------|------------|-------------|
| GET | `/api/engines` | `claude`、`agent`（及 `status`） | 无 |
| POST | `/api/split` | `claude` / `CURSOR_AGENT_BIN` | `buildAnalysisPrompt` |
| POST | `/api/orchestrate-split` | 同上 | `buildWorkflowPrompt` |
| POST | `/api/orchestrate-stage` | 同上 | `buildStagePrompt` |
| POST | `/api/normalize-orchestration` | 同上（text） | `buildNormalizeOrchestrationPrompt` |
| POST | `/api/execute` | `buildCliArgs` | `buildExecutionPrompt` |
| POST | `/api/ls` | `find` | 无 |
| 其它 | `git/*`, checkpoint, jobs, skills… | `git` / `npm` / 文件读写 | 无或大段在别处理由前述 Prompt |

---

## 维护说明

- 修改 **Cursor 二进制名**：优先改环境变量 `TASKFORGE_CURSOR_AGENT_BIN`，或改 `server.js` 中的默认值逻辑。
- 修改 **三阶段文案**：编辑 `docs/意图拆解.md`、`docs/执行计划.md`、`docs/任务编排.md` 与 `buildWorkflowPrompt` / `buildStagePrompt` 中的固定中文约束。
- 修改 **单次拆分 JSON  schema**：编辑 `buildAnalysisPrompt` 中的 JSON 示例块。
