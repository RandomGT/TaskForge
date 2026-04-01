import { getFigmaFlatList, hasAnyFigmaLink } from './figmaPages';

/** 凡任务级未勾选资源时，仍强调必须通过 MCP / 契约 / 资源路径落地 */
function buildMandatoryIntegrationBlock(style) {
  if (style === 'cursor') {
    return [
      '### ⛔ 集成与还原：强制要求（不可跳过）',
      '',
      '1. **Figma MCP 与设计还原**：涉及任何 UI/界面/视觉，**必须**使用已接入的 **Figma MCP**（或 IDE 中等效的官方 Figma 工具）拉取节点结构、设计变量、自动布局与样式说明；**禁止**仅凭记忆或肉眼估色估间距。文档中凡出现 Figma 链接、fileKey、node-id，均须在改代码前 **先读设计上下文再实现**。',
      '',
      '2. **后端接口与契约**：**必须**按下列「项目已登记接口」及任务描述中的约定，实现 **HTTP 方法、URL、请求/响应 JSON 字段** 与后端一致；禁止臆造路径或字段。需要 Mock 时须与正式契约结构一致并标注 TODO。',
      '',
      '3. **图标与切图**：**必须**使用下列「项目已登记切图/图标」中的路径或命名规范；优先复用工程内现有图标体系（SVG / Compose Vector / mipmap 等）。缺失时说明占位方案并后续替换，**禁止**引入与设计风格冲突的随机图标。',
      '',
      '4. **总表为空时**：仍须在仓库、README、Swagger/OpenAPI 或设计文档中**主动查找** Figma 链接、接口定义与图标目录；不得因未登记而跳过 MCP、契约与资源校验。',
      '',
    ];
  }
  if (style === 'copilot') {
    return [
      ' *',
      ' * MANDATORY (non-optional):',
      ' * - UI work MUST use Figma MCP (or equivalent) for specs; no guesswork on spacing/colors.',
      ' * - APIs MUST match documented method/path/JSON bodies below; no invented fields.',
      ' * - Icons/assets MUST use listed asset paths or project icon system.',
      ' * - If inventory empty, still discover Figma/API/asset docs in repo.',
    ];
  }
  return [
    '【强制约定 · 不可省略】',
    '1) Figma：须通过 Figma MCP 读取设计参数后再写 UI 代码。',
    '2) 后端：接口方法、路径与 JSON 须与下列登记信息与后端一致。',
    '3) 图标/切图：须使用已登记资源或项目统一图标体系。',
    '4) 若总表为空：仍须在仓库/文档中查找 Figma、接口与资源目录。',
    '',
  ];
}

/** 工作台录入的 API / 切图 + Figma（Figma 全量仅挂在任务 index===0，避免每个子任务重复所有页面 URL） */
function buildProjectResourcesInventory(style, state, taskIndex = 0) {
  const apis = state.apiResources || [];
  const imgs = state.imageResources || [];
  const other = state.otherResources || [];
  const pages = state.figmaPages || [];
  const hasTaskLinkedFigma = (state.tasks || []).some((task) => Array.isArray(task.figmaIds) && task.figmaIds.length > 0);
  const showFullFigma = hasAnyFigmaLink(pages) && taskIndex === 0 && !hasTaskLinkedFigma;
  const figmaBrief = hasAnyFigmaLink(pages) && (taskIndex > 0 || hasTaskLinkedFigma);

  if (!hasAnyFigmaLink(pages) && !apis.length && !imgs.length && !other.length) return [];

  const lines = [];

  if (style === 'cursor') {
    lines.push('### 📦 项目已登记资源总表（工作台录入 · 执行时逐条核对）');
    lines.push('> 下列内容来自 TaskForge 资源步骤；**即使本任务未单独勾选关联**，只要实现涉及同类能力，就必须对齐此处信息。');
    lines.push('');
    if (showFullFigma) {
      lines.push('#### 🎨 Figma 设计稿按页面聚合（**全量 · 须走 MCP**；仅任务 1 附完整 URL 表）');
      pages.forEach((p) => {
        const links = (p.links || []).filter((l) => (l.url || '').trim());
        if (!links.length && !(p.pageName || '').trim()) return;
        const title = (p.pageName || '').trim() || '（未命名页面）';
        lines.push(`- **页面：${title}**`);
        links.forEach((f, i) => {
          lines.push(`  - ${f.name || `稿 ${i + 1}`}: ${f.url}`);
          if (f.nodeId) lines.push(`    - Node ID: \`${f.nodeId}\`（node-id 中 \`-\` → \`:\`）`);
          if (f.description) lines.push(`    - 说明: ${f.description}`);
        });
      });
      lines.push('');
    } else if (figmaBrief) {
      lines.push('#### 🎨 Figma 设计稿');
      lines.push(
        '> **完整页面与全部 Figma URL 已在任务 1 的提示词中列出**（拆分阶段亦已通盘提供）。本任务请根据描述中的 **页面名称** 使用 Figma MCP 拉取对应画板；勿要求在本段重复粘贴全部链接。',
      );
      lines.push('');
    }
    if (apis.length) {
      lines.push('#### 🔌 后端接口（契约须一致）');
      apis.forEach((a, i) => {
        lines.push(`- **${a.name || `接口 ${i + 1}`}**: \`${a.method} ${a.path}\``);
        if (a.description) lines.push(`  - 说明: ${a.description}`);
        if (a.requestBody) lines.push(`  - 请求体:\n\`\`\`json\n${a.requestBody}\n\`\`\``);
        if (a.responseBody) lines.push(`  - 响应体:\n\`\`\`json\n${a.responseBody}\n\`\`\``);
      });
      lines.push('');
    }
    if (imgs.length) {
      lines.push('#### 🖼️ 图标 / 切图资源');
      imgs.forEach((m, i) => {
        lines.push(`- **${m.name || `资源 ${i + 1}`}**: \`${m.path}\`${m.description ? ` — ${m.description}` : ''}`);
      });
      lines.push('');
    }
    if (other.length) {
      lines.push('#### 📎 其他参考');
      other.forEach(r => {
        lines.push(`- **${r.name}**: ${r.content}`);
      });
      lines.push('');
    }
    return lines;
  }

  if (style === 'copilot') {
    lines.push(' *');
    lines.push(' * Project resource inventory (must honor):');
    if (showFullFigma) {
      lines.push(' * Figma by page (full list — task 1 only; use MCP):');
      pages.forEach((p) => {
        const links = (p.links || []).filter((l) => (l.url || '').trim());
        if (!links.length) return;
        lines.push(` * Page: ${(p.pageName || '').trim() || 'unnamed'}`);
        links.forEach((f) => {
          lines.push(` *   ${f.name || 'frame'}: ${f.url} node:${f.nodeId || '-'}`);
        });
      });
    } else if (figmaBrief) {
      lines.push(' * Figma: full URLs in task 1 prompt; use page name + MCP for this task.');
    }
    if (apis.length) {
      lines.push(' * APIs:');
      apis.forEach(a => {
        lines.push(` *   ${a.method} ${a.path} // ${a.name || ''}`);
      });
    }
    if (imgs.length) {
      lines.push(' * Icons/Assets:');
      imgs.forEach(m => {
        lines.push(` *   ${m.name}: ${m.path}`);
      });
    }
    if (other.length) {
      other.forEach(r => lines.push(` * Other: ${r.name} — ${r.content}`));
    }
    return lines;
  }

  // generic
  lines.push('【项目资源总表 · Figma MCP / 接口 / 图标】');
  if (showFullFigma) {
    lines.push('[Figma — 按页面 · 须 MCP，全量仅任务1]');
    pages.forEach((p) => {
      const links = (p.links || []).filter((l) => (l.url || '').trim());
      if (!links.length) return;
      lines.push(`  页面: ${(p.pageName || '').trim() || '未命名'}`);
      links.forEach((f, i) => {
        lines.push(`    ${i + 1}. ${f.name || ''} ${f.url || ''} node:${f.nodeId || ''}`);
      });
    });
  } else if (figmaBrief) {
    lines.push('[Figma — 详见任务1 全文 URL；本任务用页面名 + MCP]');
  }
  if (apis.length) {
    lines.push('[后端接口]');
    apis.forEach(a => {
      lines.push(`  ${a.method} ${a.path} ${a.name || ''}`);
      if (a.requestBody) lines.push(`  请求: ${a.requestBody}`);
      if (a.responseBody) lines.push(`  响应: ${a.responseBody}`);
    });
  }
  if (imgs.length) {
    lines.push('[图标与切图]');
    imgs.forEach(m => lines.push(`  ${m.name}: ${m.path} ${m.description || ''}`));
  }
  if (other.length) {
    lines.push('[其他]');
    other.forEach(r => lines.push(`  ${r.name}: ${r.content}`));
  }
  lines.push('');
  return lines;
}

/** Cursor 模板：实施前分析、复用现有资源、交付变更清单 */
function buildCursorAnalysisAndReuseBlock() {
  return [
    '### 🔬 实施流程：先分析项目，再改代码；交付须附变更汇总',
    '',
    '**0. 先产出微型改造计划（必做，3-8 行）**',
    '- 在开始编码前，先用简短条目列出：将修改的文件路径、对应类/组件/Hook/函数、改造目的、是否复用现有资源。',
    '- 若任务描述给了 files/steps/changePlan，以其为主；若与仓库真实结构冲突，先说明并给出替代文件。',
    '',
    '**1. 实施前 — 针对本项目做简要分析（必做）**',
    '- 在 `--cwd` 对应仓库内 **检索与阅读**：与需求相关的目录、既有 **公共 UI 组件**、**主题/色板/ Design Token**（含暗色模式若有）、**图标与切图引用方式**（drawable、mipmap、assets、图标组件库等）、以及相近业务的实现方式。',
    '- **对照**上文「资源总表」与 Figma MCP 拉取结果，明确：哪些能力 **已有封装可直接复用**，哪些必须 **增量扩展**，禁止在未检索仓库的前提下大段新建平行实现。',
    '',
    '**2. 优先复用 — UI、图标、颜色与组件（强约束）**',
    '- **颜色**：优先使用工程内 **主题色、语义色、Token 变量**；避免散落魔法数字色值；与设计稿不一致时先核对 Token/MCP 再决定是否扩展 Token。',
    '- **UI 组件**：优先 **组合、扩展** 现有 Button / 列表 / 卡片 / 弹窗 / 导航等同体系组件；新建组件须简短说明「为何无法用现有组件满足」。',
    '- **图标与图示**：优先复用 **已有图标资源与命名规范**；与登记切图、Vector、SVG 组件对齐，**禁止**用风格冲突的替代图标凑数。',
    '',
    '**3. 交付时 — 总结改动范围（写在回复中，便于 Review）**',
    '- **文件**：列出本次 **新建、修改、删除** 的文件路径（相对仓库根）。',
    '- **类 / 类型 / 组件**：列出涉及或新增的 **类、接口、enum、Composable、主要 UI 组件名**（按项目实际栈表述即可），并标注复用来源（若有）。',
    '- **方法 / 函数**：列出新增或行为变化的 **重要方法或顶层函数**（每处用一小句说明职责；Kotlin/Web 等按语言习惯命名）。',
    '- **契约与还原**：简述接口字段对齐情况、Figma MCP 还原范围、图标/切图资源实际引用路径。',
    '- 若仅调研未改代码，说明结论与阻塞原因。',
    '',
  ];
}

export function buildPromptForTask(task, index, style, state, optimizedDesc) {
  const lines = [];
  const figmaFlat = getFigmaFlatList(state.figmaPages);

  if (style === 'cursor') {
    lines.push(`## 任务 ${index + 1}: ${task.title}`);
    lines.push('');
    lines.push(`### 📋 原始需求`);
    lines.push(task.description || '(未填写)');
    lines.push('');

    if (optimizedDesc) {
      lines.push(`### 🔍 结构化需求规范（自动优化）`);
      lines.push(optimizedDesc);
      lines.push('');
    }

    if (index === 0) {
      lines.push(`### 🏗️ 项目信息`);
      lines.push(`- **项目名称**: ${state.projectName}`);
      if (state.techStack.length) lines.push(`- **技术栈**: ${state.techStack.join(', ')}`);
      lines.push('');
    }

    lines.push(...buildMandatoryIntegrationBlock('cursor'));
    lines.push(...buildProjectResourcesInventory('cursor', state, index));
    lines.push(...buildCursorAnalysisAndReuseBlock());

    if (state.extraNotes && String(state.extraNotes).trim()) {
      lines.push('### 📌 项目补充说明（全局，适用于所有任务）');
      lines.push(String(state.extraNotes).trim());
      lines.push('');
    }

    if (task.figmaIds && task.figmaIds.length) {
      lines.push(`### 🎨 本任务关联的 Figma（子集 · 须 MCP）`);
      lines.push('> 与上方「项目已登记资源总表」对照，优先满足本任务涉及的帧/组件。');
      task.figmaIds.forEach(fi => {
        const f = figmaFlat[fi];
        if (f) {
          const label = [f.pageName, f.name || '设计稿'].filter(Boolean).join(' · ');
          lines.push(`- **${label}**`);
          lines.push(`  - 链接: ${f.url}`);
          if (f.nodeId) lines.push(`  - Node ID: \`${f.nodeId}\``);
          if (f.description) lines.push(`  - 说明: ${f.description}`);
          lines.push(`  - 💡 使用 Figma MCP 读取布局、颜色、间距、字体，严格还原`);
        }
      });
      lines.push('');
    }

    if (task.apiIds && task.apiIds.length) {
      lines.push(`### 🔌 本任务关联的后端接口（子集 · 契约须对齐）`);
      task.apiIds.forEach(ai => {
        const a = state.apiResources[ai];
        if (a) {
          lines.push(`- **${a.name || '接口'}**: \`${a.method} ${a.path}\``);
          if (a.description) lines.push(`  - 说明: ${a.description}`);
          if (a.requestBody) lines.push(`  - 请求体:\n\`\`\`json\n${a.requestBody}\n\`\`\``);
          if (a.responseBody) lines.push(`  - 响应体:\n\`\`\`json\n${a.responseBody}\n\`\`\``);
        }
      });
      lines.push('');
    }

    if (task.imageIds && task.imageIds.length) {
      lines.push(`### 🖼️ 本任务关联的图标/切图（子集）`);
      task.imageIds.forEach(mi => {
        const m = state.imageResources[mi];
        if (m) {
          lines.push(`- **${m.name}**: \`${m.path}\` ${m.description ? '- ' + m.description : ''}`);
        }
      });
      lines.push('');
    }

    if (task.extra) {
      lines.push(`### ⚠️ 注意事项`);
      lines.push(task.extra);
      lines.push('');
    }

    lines.push(`### ✅ 验收标准`);
    lines.push(`- 代码可直接运行，无语法错误`);
    lines.push(`- **项目分析与交付说明**：回复中须体现对仓库的检索结论，并给出 **改动文件列表** + **类/组件/方法** 级变更摘要；能复用却重复造 UI/图标/颜色 Token 视为不达标`);
    lines.push(`- **Figma**：凡有链/Node ID，须通过 **Figma MCP** 取数后还原，验收时对照设计稿关键屏（含图标与间距）`);
    lines.push(`- **后端**：所有登记接口的请求/响应字段与错误处理与文档一致，可联调或通过契约测试`);
    lines.push(`- **图标/切图**：使用登记路径或项目规范目录，无错用、无拉伸模糊，缺失必须有占位说明`);
    lines.push(`- **复用**：颜色走主题/Token，UI 走既有组件体系，图标走既有资源；组件化、可维护`);

  } else if (style === 'copilot') {
    lines.push(`// Task ${index + 1}: ${task.title}`);
    lines.push(`// ${task.description}`);
    if (state.techStack.length) lines.push(`// Tech: ${state.techStack.join(', ')}`);
    lines.push('');
    lines.push('/* Requirements:');
    lines.push(` * ${task.description || 'TBD'}`);

    if (optimizedDesc) {
      lines.push(' *');
      lines.push(' * Structured Requirements (EARS):');
      optimizedDesc.split('\n').forEach(line => {
        lines.push(` * ${line}`);
      });
    }

    lines.push(...buildMandatoryIntegrationBlock('copilot'));
    buildProjectResourcesInventory('copilot', state, index).forEach(line => lines.push(line));

    if (state.extraNotes && String(state.extraNotes).trim()) {
      lines.push(' *');
      lines.push(' * Global project notes:');
      String(state.extraNotes).trim().split('\n').forEach(line => lines.push(` *   ${line}`));
    }

    if (task.figmaIds && task.figmaIds.length) {
      lines.push(' *');
      lines.push(' * Task-linked design (Figma MCP, subset):');
      task.figmaIds.forEach(fi => {
        const f = figmaFlat[fi];
        if (f) {
          const label = [f.pageName, f.name || 'frame'].filter(Boolean).join(' / ');
          lines.push(` *   - ${label}: ${f.url}${f.nodeId ? ' (node: ' + f.nodeId + ')' : ''}`);
        }
      });
    }

    if (task.apiIds && task.apiIds.length) {
      lines.push(' *');
      lines.push(' * Task-linked API (subset):');
      task.apiIds.forEach(ai => {
        const a = state.apiResources[ai];
        if (a) lines.push(` *   - ${a.method} ${a.path} // ${a.name || a.description || ''}`);
      });
    }

    if (task.imageIds && task.imageIds.length) {
      lines.push(' *');
      lines.push(' * Task-linked icons/assets (subset):');
      task.imageIds.forEach(mi => {
        const m = state.imageResources[mi];
        if (m) lines.push(` *   - ${m.name}: ${m.path}`);
      });
    }

    if (task.extra) {
      lines.push(' *');
      lines.push(` * Notes: ${task.extra}`);
    }

    lines.push(' */');

  } else {
    // Generic
    lines.push(`═══════════════════════════════════════`);
    lines.push(`任务 ${index + 1}/${state.tasks.length}: ${task.title}`);
    lines.push(`═══════════════════════════════════════`);
    lines.push('');
    lines.push(`【需求】`);
    lines.push(task.description || '(未填写)');
    lines.push('');

    if (optimizedDesc) {
      lines.push(`【结构化需求规范】`);
      lines.push(optimizedDesc);
      lines.push('');
    }

    if (index === 0) {
      lines.push(`【项目】${state.projectName}`);
      if (state.techStack.length) lines.push(`【技术栈】${state.techStack.join(' / ')}`);
      lines.push('');
    }

    lines.push(...buildMandatoryIntegrationBlock('generic'));
    lines.push(...buildProjectResourcesInventory('generic', state, index));

    if (state.extraNotes && String(state.extraNotes).trim()) {
      lines.push('【项目补充说明（全局）】');
      lines.push(String(state.extraNotes).trim());
      lines.push('');
    }

    if (task.figmaIds && task.figmaIds.length) {
      lines.push(`【本任务关联设计稿 · Figma MCP（子集）】`);
      task.figmaIds.forEach(fi => {
        const f = figmaFlat[fi];
        if (f) {
          const label = [f.pageName, f.name || '稿'].filter(Boolean).join(' / ');
          lines.push(`  ${label}: ${f.url}`);
          if (f.nodeId) lines.push(`  Node ID: ${f.nodeId}`);
          lines.push(`  → 请通过 Figma MCP 获取精确的设计参数`);
        }
      });
      lines.push('');
    }

    if (task.apiIds && task.apiIds.length) {
      lines.push(`【本任务关联后端接口（子集）】`);
      task.apiIds.forEach(ai => {
        const a = state.apiResources[ai];
        if (a) {
          lines.push(`  ${a.method} ${a.path} - ${a.name || a.description || ''}`);
          if (a.requestBody) lines.push(`  请求: ${a.requestBody}`);
          if (a.responseBody) lines.push(`  响应: ${a.responseBody}`);
        }
      });
      lines.push('');
    }

    if (task.imageIds && task.imageIds.length) {
      lines.push(`【本任务关联图标/切图（子集）】`);
      task.imageIds.forEach(mi => {
        const m = state.imageResources[mi];
        if (m) lines.push(`  ${m.name}: ${m.path} ${m.description ? '(' + m.description + ')' : ''}`);
      });
      lines.push('');
    }

    if (task.extra) {
      lines.push(`【注意】${task.extra}`);
      lines.push('');
    }

    lines.push('【验收要点】');
    lines.push('  · Figma：须 MCP 拉设计后再写 UI；');
    lines.push('  · 接口：方法/路径/JSON 与登记一致；');
    lines.push('  · 图标/切图：须使用登记路径或工程规范资源。');
    lines.push('');
  }

  return lines.join('\n');
}

export function highlightPrompt(text) {
  let result = escapeHtml(text);
  result = result.replace(/(##?\s.+)/g, '<span class="prompt-section-title">$1</span>');
  result = result.replace(/(【[^】]+】)/g, '<span class="prompt-section-title">$1</span>');
  result = result.replace(/(https?:\/\/[^\s<]+)/g, '<span class="prompt-resource">$1</span>');
  result = result.replace(/(\/api\/[^\s<`]+)/g, '<span class="prompt-resource">$1</span>');
  result = result.replace(/(\/\/\s.+)/g, '<span class="prompt-comment">$1</span>');
  result = result.replace(/(💡[^<\n]+)/g, '<span class="prompt-orange">$1</span>');
  return result;
}

function escapeHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
