# TaskForge 重构规划：从任务拆分升级到意图拆解驱动

## 1. 重构目标

本次重构的目标不是单纯优化 UI 或调整几个工具函数，而是把 TaskForge 从“需求 -> 任务 -> Prompt -> 执行”的工作台，升级为“需求 -> 意图 -> 计划 -> 任务 -> Prompt 包 -> 执行 -> 校验”的执行编排系统。

重点目标有四个：

1. 在任务拆分前增加 `意图拆解`
2. 将当前偏扁平的任务对象升级为结构化的执行对象
3. 将前后端当前混合式 Prompt 逻辑拆成可扩展的编排管线
4. 为后续“任务类型模板化、校验、评估指标、复用约束”打基础

---

## 2. 为什么要做这次重构

从当前项目实现看，TaskForge 已经具备产品雏形，但核心链路仍然偏“直接生成任务”，而不是“先理解意图，再推导任务”。

这会导致几个结构性问题：

### 2.1 `task` 承载了太多不同层级的信息

当前任务对象同时承载：

- 业务目标
- 文件改造建议
- 执行步骤
- Prompt 文本
- 资源绑定
- 执行状态

这使得 `task` 既像规格，又像计划，又像执行单，又像运行记录，边界不清晰。

### 2.2 拆分仍然是“句子切分 + AI 补全”

本地拆分仍以文本分句为主，AI 拆分虽然更强，但输入输出仍然是直接吐 `tasks[]`，中间缺少一层稳定的“意图模型”。

### 2.3 Prompt 生成与任务模型强耦合

前端 `promptBuilder` 直接依赖当前任务结构拼接最终大 Prompt，服务端也会根据 `task.prompt` 再做二次包装。  
这导致后续一旦任务结构升级，Prompt 生成、执行、预览都会连带受影响。

### 2.4 状态管理过于集中

当前 `AppContext` 既管理表单输入，又管理资源，又管理任务，又管理 AI 流式输出，又管理执行状态，后续一旦引入意图层与计划层，复杂度会明显上升。

---

## 3. 当前项目的核心问题定位

基于现有代码，最关键的几个问题如下：

### 3.1 “拆分”没有经过意图建模

当前本地拆分基本是：

- 从 `requirementDesc` 分句
- 用关键词判断是否开新任务
- 直接生成任务列表

这意味着系统还没有真正回答下面这些问题：

- 用户到底想交付什么成果
- 这是 UI 意图、数据意图、交互意图，还是工程约束意图
- 哪些是主目标，哪些只是实现手段
- 哪些工作应该变成任务，哪些只是任务内步骤

### 3.2 `optimizeTask()` 其实在做“规格补写”，但位置不对

现在 `optimizer.js` 已经开始尝试把任务描述转成 EARS、场景、质量基线，这其实是对的，但它发生在 Prompt 拼装阶段，而不是前置成为规格层资产。  
结果就是：结构化规格只是一个展示增强，而不是驱动拆分与执行的核心输入。

### 3.3 服务端 `/api/split` 还是“一次性大 Prompt 出 JSON”

当前服务端的分解逻辑是：

- 收集项目路径、需求、Figma、文件快照
- 生成一段分析 Prompt
- 让 CLI 直接输出 `analysis + tasks[]`

这很适合快速原型，但不适合后续做：

- 意图分层
- 任务分型
- 结构化校验
- 局部重跑
- 反馈归因

### 3.4 前端 Step3 和 Step5 的职责已经开始重叠

Step3 管拆分与任务编辑，Step5 又会重新根据任务生成 Prompt 并执行。  
如果后续新增“意图层”和“计划层”，这两个页面之间还会继续变厚，最终变成难以维护的页面级巨石。

---

## 4. 新的目标架构

建议把系统核心链路升级为七层：

1. `InputSpec`：原始输入层
2. `IntentModel`：意图拆解层
3. `ExecutionPlan`：计划层
4. `TaskGraph`：任务层
5. `PromptPackage`：Prompt 编排层
6. `ExecutionRun`：执行层
7. `VerificationResult`：校验与反馈层

### 4.1 输入层 `InputSpec`

用于承接用户原始输入：

- 项目路径
- 项目名称
- 技术栈
- 原始需求
- 全局补充说明
- Figma / API / Image / Other 资源
- 项目文件快照

这一层尽量保持“原始事实”，不要在这里混入太多推断。

### 4.2 意图层 `IntentModel`

这是本次重构新增的关键层。  
它不直接告诉系统“改哪个文件”，而是先回答：

- 用户真正想交付的成果是什么
- 存在哪些一级目标
- 每个目标下有哪些子意图
- 哪些意图是用户可见的
- 哪些意图是技术支撑性的
- 哪些意图需要外部资源约束

例如一个“做用户列表页”的需求，意图层不应直接产生 5 个任务，而应先产出：

- `展示用户列表`
- `支持筛选与搜索`
- `接入列表查询接口`
- `保持与设计稿一致`
- `复用现有表格与筛选组件`
- `处理空态、加载态、错误态`

然后再由计划层和任务层把这些意图映射成具体任务。

### 4.3 计划层 `ExecutionPlan`

计划层的职责是把意图映射到当前仓库的真实实现空间：

- 相关目录在哪
- 可复用组件有哪些
- API 封装在哪
- 潜在影响面多大
- 哪些意图可以合并为同一任务
- 哪些意图必须拆开以便验证

### 4.4 任务层 `TaskGraph`

任务层只保留“最小可执行、最小可验证”的单元，不能再承担意图解释职责。  
任务应该是计划的编译结果，而不是原始需求的直接切块。

### 4.5 Prompt 编排层 `PromptPackage`

Prompt 不再直接从 `task.description` 拼接，而是从结构化输入装配：

- system prompt
- project context
- task spec
- output contract
- verification contract

### 4.6 执行层 `ExecutionRun`

执行层承接：

- 任务执行状态
- CLI 日志
- 最终输出
- 错误信息
- 执行耗时

这一层应与任务定义本身分离。

### 4.7 校验层 `VerificationResult`

执行完成后记录：

- 是否满足验收标准
- 是否超范围改动
- 是否存在未说明假设
- 是否需要人工确认
- 失败归因是什么

---

## 5. “意图拆解”应该怎么设计

## 5.1 什么是意图

在 TaskForge 里，意图不是“用户说的一句话”，而是对交付目标的结构化理解。  
建议把意图定义为：

> 一个可被解释、可被规划、但尚未直接绑定具体文件与步骤的交付目标或约束单元。

### 5.2 意图的推荐分类

建议首版至少支持五类意图：

1. `business_goal`
2. `user_interaction`
3. `data_contract`
4. `ui_realization`
5. `engineering_constraint`

#### `business_goal`

例如：

- 完成用户管理页面
- 支持新增与编辑流程
- 提供可运行首版

#### `user_interaction`

例如：

- 用户可以筛选列表
- 用户可以打开详情弹窗
- 用户可以提交表单并收到反馈

#### `data_contract`

例如：

- 页面需要调用用户列表接口
- 表单字段需要映射后端契约
- 错误态需要对齐接口返回

#### `ui_realization`

例如：

- 页面布局对齐 Figma
- 使用主题 Token
- 复用现有按钮、表格、表单组件

#### `engineering_constraint`

例如：

- 不修改核心框架层
- 不重构全局主题
- 只允许在页面目录内新增组件

### 5.3 意图对象建议

```json
{
  "id": "intent-1",
  "type": "user_interaction",
  "title": "支持用户筛选列表",
  "summary": "用户可以通过筛选条件缩小列表范围",
  "priority": "high",
  "source": "requirement",
  "dependsOn": ["intent-0"],
  "acceptanceSignals": [
    "存在筛选输入区域",
    "筛选条件影响列表查询参数",
    "空条件下恢复默认列表"
  ],
  "resourceBindings": {
    "figma": ["page:user-list/filter-area"],
    "api": ["user-list-query"]
  },
  "constraints": [
    "优先复用现有筛选表单组件",
    "不要新增平行查询状态管理"
  ]
}
```

### 5.4 意图拆解输出不应直接等于任务

意图层输出的是：

- 交付目标树
- 约束项
- 外部依赖
- 风险与待澄清点

然后由计划层判断：

- 一个意图对应一个任务
- 多个意图合并成一个任务
- 一个复杂意图拆成两个任务

这一步非常关键。否则“意图拆解”会退化成“换名字的任务拆分”。

---

## 6. 推荐的新数据模型

建议新增以下核心对象，并逐步替换当前直接使用的 `task`。

## 6.1 `WorkspaceSpec`

描述整个工作台会话的输入：

```json
{
  "project": {
    "name": "TaskForge",
    "path": "/path/to/project",
    "techStack": ["React", "Vite"]
  },
  "requirement": {
    "rawText": "实现用户列表页面，支持筛选、接口对接和设计稿还原",
    "extraNotes": "优先复用现有组件"
  },
  "resources": {
    "figmaPages": [],
    "apiResources": [],
    "imageResources": [],
    "otherResources": []
  },
  "projectFiles": []
}
```

## 6.2 `IntentGraph`

```json
{
  "rootGoal": "交付用户列表页",
  "intents": [],
  "assumptions": [],
  "questions": [],
  "risks": []
}
```

## 6.3 `ExecutionPlan`

```json
{
  "summary": "基于现有列表页模式扩展筛选区并接入查询接口",
  "reuseCandidates": [],
  "affectedAreas": [],
  "proposedSlices": [],
  "blockingQuestions": []
}
```

## 6.4 `TaskNode`

```json
{
  "id": "task-1",
  "type": "ui_implementation",
  "title": "实现用户列表筛选区",
  "goal": "完成筛选区 UI 和状态绑定",
  "intentIds": ["intent-2", "intent-4"],
  "acceptanceCriteria": [],
  "allowedChanges": {
    "files": [],
    "newFiles": []
  },
  "changePlan": [],
  "resourceBindings": {
    "figma": [],
    "api": [],
    "images": []
  },
  "dependencies": [],
  "status": "pending"
}
```

## 6.5 `PromptPackage`

```json
{
  "taskId": "task-1",
  "system": "...",
  "project": "...",
  "task": "...",
  "outputContract": "...",
  "verificationContract": "..."
}
```

## 6.6 `ExecutionRun`

```json
{
  "taskId": "task-1",
  "status": "running",
  "startedAt": 0,
  "finishedAt": 0,
  "logs": [],
  "output": "",
  "error": null
}
```

---

## 7. 建议的目录重组

当前项目规模不大，但已经有明显的“领域逻辑都堆在 utils 和 context 里”的趋势。  
建议本次重构顺手把目录整理到领域导向结构。

推荐目标结构：

```text
src/
  app/
    AppShell.jsx
    routes.js

  domains/
    workspace/
      model.js
      reducer.js
      selectors.js

    resources/
      model.js
      mapper.js

    intents/
      model.js
      intentExtractor.js
      intentNormalizer.js
      intentQuestions.js

    planning/
      model.js
      planBuilder.js
      reuseAnalyzer.js
      taskComposer.js

    prompts/
      model.js
      promptAssembler.js
      templates/
        system.js
        project.js
        task-ui.js
        task-api.js
        task-bugfix.js

    execution/
      model.js
      executionService.js
      executionReducer.js

    verification/
      model.js
      verificationBuilder.js

  features/
    requirement-input/
    resource-binding/
    intent-review/
    plan-review/
    task-editor/
    prompt-preview/
    execution-runner/

  services/
    apiClient.js

  utils/
    figmaPages.js
    text.js
```

这个结构的重点不是“好看”，而是让你后续能很自然地把：

- 输入
- 意图
- 计划
- 任务
- Prompt
- 执行

分开放。

---

## 8. 前端重构建议

## 8.1 先拆 `AppContext`

当前 `AppContext` 已经承担太多职责，建议按领域拆成至少三个 reducer：

1. `workspaceReducer`
2. `splitPipelineReducer`
3. `executionReducer`

### `workspaceReducer`

负责：

- 基础项目信息
- 需求描述
- 技术栈
- 资源录入

### `splitPipelineReducer`

负责：

- 意图提取状态
- 计划生成状态
- 任务图状态
- Prompt 预览所需中间数据

### `executionReducer`

负责：

- 当前执行任务
- 执行日志
- 全局运行状态
- 单任务运行记录

### 为什么先拆这个

因为只要加入“意图层”和“计划层”，当前单 reducer 一定会迅速变得不可维护。  
这一步是所有后续重构的地基。

## 8.2 Step3 不再叫“任务拆分”，而是升级为“拆解工作台”

建议把当前 Step3 拆成 3 个子视图或 3 个子页签：

1. `意图拆解`
2. `执行计划`
3. `任务编排`

这样用户能看到系统不是直接拍脑袋产任务，而是经历了可复核的中间层。

### 子视图 1：意图拆解

展示：

- 主目标
- 子意图列表
- 风险
- 待澄清问题

允许：

- 合并/删除/编辑意图
- 调整优先级
- 标记必须保留的约束

### 子视图 2：执行计划

展示：

- 复用候选
- 影响范围
- 推荐切片方式
- 风险区域

允许：

- 勾选复用点
- 调整切片策略
- 标记禁改目录

### 子视图 3：任务编排

展示：

- 最终任务图
- 依赖关系
- 每个任务的关联意图
- 每个任务的允许改动范围

## 8.3 任务编辑弹窗改成结构化表单

当前 `TaskEditModal` 仍以自由文本为主。  
重构后建议至少增加这些字段：

- 任务类型
- 目标
- 成功标准
- 关联意图
- 允许改动范围
- 禁止事项
- 复用要求
- 澄清规则
- 自动校验项

自由文本描述可以保留，但应退居补充信息。

---

## 9. 后端重构建议

## 9.1 把 `/api/split` 拆成多阶段管线

当前只有一个 `/api/split`。  
建议拆成以下服务方法，HTTP 是否拆多个接口可以后面再决定，但内部逻辑应先拆开：

1. `buildWorkspaceSpec(input)`
2. `extractIntentGraph(spec)`
3. `buildExecutionPlan(spec, intentGraph)`
4. `composeTaskGraph(spec, intentGraph, plan)`
5. `assemblePromptPackages(spec, plan, taskGraph)`

HTTP 层可以先继续保留一个接口，但内部必须改成多阶段函数，否则后续无法迭代。

## 9.2 `/api/split` 的返回值要升级

不要再只返回：

- `analysis`
- `reuseHints`
- `tasks`

而是建议返回：

```json
{
  "workspaceSpec": {},
  "intentGraph": {},
  "executionPlan": {},
  "taskGraph": {
    "tasks": []
  },
  "promptPackages": []
}
```

前端可以先只消费一部分，但服务端应该开始产出完整结构。

## 9.3 执行接口应从接收 `task + prompt` 升级为接收 `PromptPackage`

当前 `/api/execute` 基本是拿 `task.prompt` 直接执行。  
后续建议改成：

- 输入 `taskNode`
- 输入 `promptPackage`
- 输入 `projectPath`

这样 Prompt 的生成和执行解耦，便于调试、缓存和重试。

---

## 10. Prompt 编排层如何重构

## 10.1 不再由 `buildPromptForTask(task, ...)` 直接完成所有事

建议拆成：

- `buildSystemPrompt()`
- `buildProjectPrompt(spec, plan)`
- `buildTaskPrompt(taskNode)`
- `buildOutputContract(taskNode)`
- `buildVerificationContract(taskNode)`
- `assemblePromptPackage(...)`

## 10.2 `optimizer.js` 重定位

建议把现在的 `optimizeTask()` 拆成两个职责：

### `intentNormalizer`

把原始需求或意图转成更结构化的规格描述，用于拆解和计划，不直接面向最终 Prompt。

### `acceptanceBuilder`

根据任务类型生成默认验收项，用于任务层与校验层。

这样 EARS / Given-When-Then 就不只是“Prompt 润色”，而会真正进入系统结构。

---

## 11. 推荐的重构阶段

这次重构建议分五期做，不要一口气全部翻掉。

## Phase 1：模型分层，不动主流程

目标：

- 新增 `WorkspaceSpec / IntentGraph / ExecutionPlan / TaskNode / PromptPackage` 数据模型
- 先在内存中生成中间结构
- 页面仍然保留原有 Step 流程

这一期不追求 UI 大改，先把数据模型立起来。

### 交付物

- 新模型定义文件
- 新的 split pipeline 函数
- 兼容旧任务对象的 mapper

## Phase 2：接入意图拆解

目标：

- 在 `/api/split` 中增加意图提取阶段
- Step3 增加“意图拆解”视图
- 允许用户编辑意图

### 交付物

- `intentExtractor`
- `intentReviewPanel`
- `intent -> task` 的 first-pass 映射

## Phase 3：计划层与任务图

目标：

- 加入复用候选分析
- 加入影响面与允许修改范围
- 任务从列表升级为图或至少带依赖的结构化节点

### 交付物

- `planBuilder`
- `reuseAnalyzer`
- `taskComposer`

## Phase 4：Prompt 编排与执行重构

目标：

- 由 `PromptPackage` 驱动执行
- Step5 改成“Prompt 包 + 执行结果”
- 校验结果结构化

### 交付物

- `promptAssembler`
- `verificationBuilder`
- execution 数据结构重整

## Phase 5：指标与质量闭环

目标：

- 记录澄清、返工、失败归因
- 统计不同模板和任务类型表现

### 交付物

- run history
- verification result
- template metrics

---

## 12. 首批最值得落地的最小切片

如果你希望尽快看到价值，而不是先做半年基础设施，我建议首批只做下面三件事。

### 切片 1：引入意图层，但先不全面改 UI

做法：

- 保留 Step3 页面
- 新增一个“AI 意图拆解”按钮
- 输出 `intentGraph`
- 用户确认后再生成任务

这样成本低，但能快速验证“意图层是否提升拆分质量”。

### 切片 2：任务对象升级为 `TaskNode`

做法：

- 新旧字段并存一段时间
- 新增 `goal`、`intentIds`、`acceptanceCriteria`、`allowedChanges`
- 旧 UI 暂时只显示部分字段

这样不会一下子把所有页面打爆。

### 切片 3：Prompt 改为分层组装

做法：

- 保留现有预览 UI
- 内部不再直接拼大字符串
- 改成先生成 `PromptPackage`，再转换为展示文本

这样后面切不同任务模板会轻松很多。

---

## 13. 技术实施顺序建议

如果由我来排，你这次重构的开发顺序会是：

1. 抽数据模型
2. 抽 split pipeline
3. 引入 intent graph
4. 升级 task node
5. 重写 prompt assembler
6. 再改 Step3 / Step5 UI

而不是反过来先改 UI。  
因为这次核心不是界面换皮，而是中间数据流重建。

---

## 14. 风险提醒

### 14.1 不要同时做“全面 TS 化”和“意图拆解重构”

虽然从长期看 TypeScript 很有价值，但这次如果同时做：

- 架构迁移
- 数据模型重构
- 类型系统引入

风险会过高。  
建议本轮先保留 JS，等模型稳定后再考虑 TS 化。

### 14.2 不要一次性废掉旧任务结构

建议保留一个适配层：

- `legacyTask -> taskNode`
- `taskNode -> legacyPromptPreviewData`

这样你能分阶段迁移，不会每个页面一起炸。

### 14.3 不要让“意图层”直接输出超细任务

这是最容易走偏的点。  
一旦意图层直接变成细粒度任务枚举，它就失去价值了，只是在旧拆分前多套一层壳。

---

## 15. 我建议你这次重构的核心判断标准

这次重构完成后，系统应该满足下面几个判断标准：

1. 原始需求进入系统后，先能看到“意图”，而不是立刻看到“任务”
2. 每个任务都能反查它服务于哪些意图
3. Prompt 不是直接从描述字符串生成，而是从结构化对象装配
4. 执行结果能回写到任务和校验层，而不是只留一段 CLI 文本
5. 系统以后能自然支持“不同任务类型不同模板”

如果这五点能做到，TaskForge 就真的从“Prompt 工具”升级成了“AI 执行编排系统”。

---

## 16. 最后的建议

这次重构最关键的不是“把任务拆得更细”，而是先回答：

- 用户想达成的交付意图是什么
- 这些意图在当前仓库里最合理的实现路径是什么
- 哪些意图该变成任务，哪些该变成约束、验收或澄清问题

所以这次重构的主线应该是：

**先重建中间层，再升级任务层，最后重写 Prompt 与执行层。**

换句话说：

**TaskForge 下一阶段最重要的新增能力，不是更会写 Prompt，而是更会理解意图并把意图编排成可执行结构。**
