import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { parseTaskOrchestrationDraft } from '../domains/pipeline/draftParsers';
import {
  aiExecuteTask,
  createStepCheckpoint,
  getRecommendedSkills,
  installSkillPackages,
  normalizeTaskOrchestration,
  rollbackToStepCheckpoint,
  savePromptResources,
} from '../utils/aiService';

const PROMPT_RESOURCE_FILES = [
  { field: 'intentDecomposition', filename: '01-intent-decomposition.md' },
  { field: 'executionPlan', filename: '02-execution-plan.md' },
  { field: 'taskOrchestration', filename: '03-task-orchestration.md' },
];

const ENGINE_OPTIONS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'cursor', label: 'Cursor CLI' },
];

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** 与 server 约定：Cursor 流式输出用 [[MCP:名称]] 标记 MCP，便于终端内高亮 */
function splitTerminalMcpMarkers(text) {
  const s = text ?? '';
  const re = /\[\[MCP:([^\]]+)\]\]/g;
  const pieces = [];
  let last = 0;
  let m = re.exec(s);
  while (m !== null) {
    if (m.index > last) {
      pieces.push({ kind: 'text', value: s.slice(last, m.index) });
    }
    pieces.push({ kind: 'mcp', value: m[1] });
    last = m.index + m[0].length;
    m = re.exec(s);
  }
  if (last < s.length) {
    pieces.push({ kind: 'text', value: s.slice(last) });
  }
  return pieces.length ? pieces : [{ kind: 'text', value: s }];
}

function skillRowId(skill, index) {
  return skill.id ?? skill.npmName ?? skill.name ?? `skill-${index}`;
}

function formatSkillsBlock(skills) {
  if (!skills.length) {
    return '- 当前未命中可用 Skill，可按默认工程规范执行。';
  }

  return skills.map((skill, index) => {
    const tags = Array.isArray(skill.tags) && skill.tags.length ? `标签: ${skill.tags.join(', ')}` : '标签: 无';
    const matched = Array.isArray(skill.matchedTokens) && skill.matchedTokens.length
      ? `命中线索: ${skill.matchedTokens.join(', ')}`
      : '命中线索: 自动推荐';
    return `${index + 1}. 名称: ${skill.name}
   - 描述: ${skill.description || '无描述'}
   - ${tags}
   - ${matched}${skill.npmName ? `
   - npm 包名（将按勾选尝试安装）: ${skill.npmName}` : `
   - npm: 无（仅作规范参考）`}`;
  }).join('\n');
}

function createStepRuntime() {
  return {
    status: 'never', // never | running | completed | interrupted | failed | rolled_back
    checkpoint: null,
    runCount: 0,
    lastRunAt: '',
    lastCompletedAt: '',
    lastError: '',
  };
}

function formatTimeLabel(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getRuntimeLabel(status) {
  switch (status) {
    case 'running':
      return '执行中';
    case 'completed':
      return '已完成';
    case 'interrupted':
      return '已终止';
    case 'failed':
      return '执行失败';
    case 'rolled_back':
      return '已回退';
    default:
      return '未执行';
  }
}

function buildStepTooltip(step, index, runtime) {
  const sections = [
    `步骤 ${index + 1}: ${step.title}`,
    `状态: ${getRuntimeLabel(runtime.status)}`,
  ];

  if (step.description) {
    sections.push(`描述: ${step.description}`);
  }
  if (step.dependencies?.length) {
    sections.push(`依赖: ${step.dependencies.join('、')}`);
  }
  if (step.acceptanceCriteria?.length) {
    sections.push(`验收: ${step.acceptanceCriteria.join('；')}`);
  }
  if (step.steps?.length) {
    sections.push(`产出/步骤: ${step.steps.join('；')}`);
  }
  if (step.files?.length) {
    sections.push(`涉及文件: ${step.files.join('、')}`);
  }
  if (runtime.lastError) {
    sections.push(`最近错误: ${runtime.lastError}`);
  }

  return sections.join('\n');
}

function buildScopedExecutionPrompt(step, index, allSteps, skillsBlock) {
  const orderedList = allSteps.map((item, itemIndex) => {
    const dependencyText = item.dependencies?.length ? `；依赖：${item.dependencies.join('、')}` : '';
    return `${itemIndex + 1}. [${item.id}] ${item.title}${dependencyText}`;
  }).join('\n');

  const acceptanceText = step.acceptanceCriteria?.length
    ? step.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
    : '- 以 03-task-orchestration.md 中该步骤的描述与产出要求为准';
  const stepOutputText = step.steps?.length
    ? step.steps.map((item) => `- ${item}`).join('\n')
    : '- 无额外条目，请严格按任务描述实现';
  const filesText = step.files?.length
    ? step.files.map((item) => `- ${item}`).join('\n')
    : '- 先自行定位真实修改文件，但不可越界执行其他步骤';
  const dependencyText = step.dependencies?.length
    ? step.dependencies.map((item) => `- ${item}`).join('\n')
    : '- 无';

  return `你是一个负责落地实现的 AI Agent。

开始执行前，必须先完整阅读并分析以下三个文件，它们是本次任务的唯一执行依据：
1. \`.taskforge-prompts/01-intent-decomposition.md\`
2. \`.taskforge-prompts/02-execution-plan.md\`
3. \`.taskforge-prompts/03-task-orchestration.md\`

在正式执行前，请充分理解下方「候选 Skills」中每一项的名称与描述；结合三份 md 判断哪些 Skill 与本次任务真正相关，仅对适用项严格遵循其规范（不适用的不要假装已采用）。

候选 Skills（名称与描述；请据此挑选适用子集）：
${skillsBlock}

本轮执行范围是“分步执行”，你只允许实现下面这一个步骤：
- 当前步骤序号：${index + 1}
- 当前步骤 ID：${step.id}
- 当前步骤名称：${step.title}

当前步骤详情：
- 描述：${step.description || '以任务标题和 03-task-orchestration.md 原文为准'}
- 依赖：
${dependencyText}
- 验收标准：
${acceptanceText}
- 预期产出/子项：
${stepOutputText}
- 涉及文件：
${filesText}

全量步骤清单（仅用于定位上下文，禁止执行未选步骤）：
${orderedList}

执行规则：
- 只允许完成当前这一个步骤，禁止提前实现、顺手实现、顺带优化任何未选步骤。
- 如果发现依赖步骤尚未完成、信息缺失或前置条件不足，立即停止并明确说明阻塞原因，不要自行扩展范围。
- 所有改动都必须能够映射回 \`.taskforge-prompts/03-task-orchestration.md\` 中的当前步骤。
- 只可更新当前步骤在 \`.taskforge-prompts/03-task-orchestration.md\` 中对应的勾选状态与完成程度；未选步骤禁止改成已完成。
- 如果本轮没有真正完成当前步骤，不要把它标记为 \`[x]\`。
- 完成本步骤后必须停止，不要继续执行下一步。

实施要求：
- 开始前先输出本轮实施计划，说明只会完成当前步骤，以及预计修改的文件。
- 实施时优先复用现有组件、工具、样式和接口封装。
- 完成后输出本步骤的改动摘要，并同步更新 \`.taskforge-prompts/03-task-orchestration.md\` 中当前步骤的状态。`;
}

export default function Step5Prompts() {
  const { state, copyToClipboard, showToast } = useAppContext();
  const [selectedEngine, setSelectedEngine] = useState(state.aiEngine || '');
  const [isExecuting, setIsExecuting] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalStatus, setTerminalStatus] = useState('');
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [recommendedSkills, setRecommendedSkills] = useState([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  /** skillRowId -> 是否参与 Prompt 与 npm 安装（默认全选） */
  const [skillInstallSelected, setSkillInstallSelected] = useState({});
  const [executionMode, setExecutionMode] = useState('full');
  const [stepRuntimeMap, setStepRuntimeMap] = useState({});
  const [selectedStepIds, setSelectedStepIds] = useState([]);
  const [normalizedSteps, setNormalizedSteps] = useState([]);
  const [isNormalizingSteps, setIsNormalizingSteps] = useState(false);
  const abortRef = useRef(null);
  const stopRequestedRef = useRef(false);
  const currentStepIdRef = useRef('');
  const terminalBodyRef = useRef(null);

  const terminalPieces = useMemo(
    () => splitTerminalMcpMarkers(terminalOutput || '等待执行输出...'),
    [terminalOutput],
  );

  const fallbackTaskGraph = useMemo(
    () => parseTaskOrchestrationDraft(state.splitDrafts?.taskOrchestration || ''),
    [state.splitDrafts?.taskOrchestration],
  );

  const orchestrationSteps = useMemo(() => {
    const parsedTasks = fallbackTaskGraph.tasks || [];
    const sourceTasks = parsedTasks.length
      ? parsedTasks
      : (normalizedSteps.length ? normalizedSteps : (Array.isArray(state.tasks) ? state.tasks : []));

    return sourceTasks.map((task, index) => ({
      id: String(task.id ?? `step-${index + 1}`),
      title: task.title || `步骤 ${index + 1}`,
      description: task.description || task.goal || '',
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      files: Array.isArray(task.files) ? task.files : [],
      steps: Array.isArray(task.steps) ? task.steps : [],
    }));
  }, [fallbackTaskGraph.tasks, normalizedSteps, state.tasks]);

  const stepIndexMap = useMemo(() => {
    const map = new Map();
    orchestrationSteps.forEach((step, index) => {
      map.set(step.id, index);
    });
    return map;
  }, [orchestrationSteps]);

  useEffect(() => {
    if (terminalBodyRef.current) {
      terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
    }
  }, [terminalOutput, terminalStatus, terminalPieces]);

  useEffect(() => {
    setStepRuntimeMap((prev) => {
      const next = {};
      orchestrationSteps.forEach((step) => {
        next[step.id] = prev[step.id] || createStepRuntime();
      });
      return next;
    });
    setSelectedStepIds((prev) => prev.filter((id) => stepIndexMap.has(id)));
  }, [orchestrationSteps, stepIndexMap]);

  useEffect(() => {
    if ((fallbackTaskGraph.tasks || []).length > 0) {
      setNormalizedSteps([]);
    }
  }, [fallbackTaskGraph.tasks]);

  useEffect(() => {
    let cancelled = false;
    const loadSkills = async () => {
      setSkillsLoading(true);
      try {
        const result = await getRecommendedSkills({
          projectName: state.projectName,
          projectPath: state.projectPath,
          requirementDesc: state.requirementDesc,
          techStack: state.techStack,
          extraNotes: state.extraNotes,
          projectFiles: state.projectFiles,
          intentDecomposition: state.splitDrafts?.intentDecomposition || '',
          executionPlan: state.splitDrafts?.executionPlan || '',
          taskOrchestration: state.splitDrafts?.taskOrchestration || '',
        });
        if (!cancelled) {
          setRecommendedSkills(result.skills || []);
        }
      } catch (error) {
        if (!cancelled) {
          setRecommendedSkills([]);
          console.warn('[Step5Prompts] 获取推荐 Skills 失败', error);
        }
      } finally {
        if (!cancelled) {
          setSkillsLoading(false);
        }
      }
    };

    loadSkills();
    return () => {
      cancelled = true;
    };
  }, [
    state.projectName,
    state.projectPath,
    state.requirementDesc,
    state.techStack,
    state.extraNotes,
    state.projectFiles,
    state.splitDrafts,
  ]);

  useEffect(() => {
    const next = {};
    recommendedSkills.forEach((s, i) => {
      next[skillRowId(s, i)] = true;
    });
    setSkillInstallSelected(next);
  }, [recommendedSkills]);

  const skillsForPrompt = useMemo(
    () => recommendedSkills.filter((s, i) => skillInstallSelected[skillRowId(s, i)] !== false),
    [recommendedSkills, skillInstallSelected],
  );

  const skillsBlock = useMemo(() => formatSkillsBlock(skillsForPrompt), [skillsForPrompt]);

  const promptText = useMemo(() => `你是一个负责落地实现的 AI Agent。

开始执行前，必须先完整阅读并分析以下三个文件，它们是本次任务的唯一执行依据：
1. \`.taskforge-prompts/01-intent-decomposition.md\`
2. \`.taskforge-prompts/02-execution-plan.md\`
3. \`.taskforge-prompts/03-task-orchestration.md\`

在正式执行前，请充分理解下方「候选 Skills」中每一项的名称与描述；结合三份 md 判断哪些 Skill 与本次任务真正相关，仅对适用项严格遵循其规范（不适用的不要假装已采用）。

Skill 使用方式：
- 下方为系统根据项目上下文推荐的候选集；用户可通过勾选决定是否为含 npm 包名的项执行安装。
- 你必须根据各 Skill 的名称与描述自行筛选适用子集，并优先查阅已安装包内的说明（如 SKILL.md）以吸收具体约定。
- 对判定为不适用的 Skill，不要在输出中引用或声称已遵循。

候选 Skills（名称与描述；请据此挑选适用子集）：
${skillsBlock}

执行规则：
- 先从 \`.taskforge-prompts/01-intent-decomposition.md\` 理解业务目标、边界、约束、验收口径和待澄清项。
- 再从 \`.taskforge-prompts/02-execution-plan.md\` 提取实现顺序、影响范围、复用策略、执行限制和落地要求。
- 最后以 \`.taskforge-prompts/03-task-orchestration.md\` 作为唯一任务清单，严格按照其中的任务目标、依赖关系、执行顺序和约束推进。
- 执行实现时，对你判定为适用的 Skill 优先遵守其规范、约束和最佳实践。
- 不允许脱离这三个文件擅自扩写需求、增加范围、跳过关键任务或修改目标定义。
- 如果三个文件之间存在冲突，优先级为：\`.taskforge-prompts/03-task-orchestration.md\` > \`.taskforge-prompts/02-execution-plan.md\` > \`.taskforge-prompts/01-intent-decomposition.md\`。
- 如果信息缺失、任务冲突或前置条件不足，先暂停并列出问题，不要自行猜测补全。

实施要求：
- 每次开始执行前，先说明本轮要完成的任务名称、涉及文件、预期产出。
- 执行过程中严格遵守意图拆解中的边界约束，以及执行计划中的实现要求。
- 所有改动都必须能够映射回 \`.taskforge-prompts/03-task-orchestration.md\` 中的具体任务。
- 每完成一项任务，必须立即在 \`.taskforge-prompts/03-task-orchestration.md\` 中将该项对应行的 Markdown 任务列表勾选框从 \`[ ]\` 改为 \`[x]\`；未完成项保持 \`[ ]\`，不得提前勾选。
- 每完成一项任务后，还须在同一文件中同步更新该任务的完成程度等文字标注（见下）；全部结束后再次逐项核对勾选框与文字状态是否一致。

任务完成程度标注规范：
- 勾选框与文字状态必须一致：凡使用 \`[ ] / [x]\` 列出的任务，完成度以 \`[x]\` 表示已完成，以 \`[ ]\` 表示未完成；每勾一项 \`[x]\`，对应的「完成程度」等字段须同时更新。
- 使用以下四种状态之一：\`未开始\`、\`进行中\`、\`已完成\`、\`阻塞\`
- 在每个任务下补充以下字段：
  - \`完成程度：<状态>\`
  - \`结果摘要：<本任务已完成的内容>\`
  - \`涉及文件：<本任务实际修改或新增的文件>\`
  - \`阻塞原因：<仅在状态为阻塞时填写>\`

最终输出要求：
- 先输出简短执行计划。
- 再实施任务。
- 最后输出改动摘要，并同步更新 \`.taskforge-prompts/03-task-orchestration.md\` 中各任务的 \`[x]\` 勾选状态与完成程度标注。`, [skillsBlock]);

  const promptResources = useMemo(() => (
    PROMPT_RESOURCE_FILES.map(({ field, filename }) => ({
      filename,
      content: state.splitDrafts?.[field] || '',
    }))
  ), [state.splitDrafts]);

  const appendTerminal = useCallback((text) => {
    if (!text) return;
    setTerminalOutput((prev) => prev + text);
  }, []);

  const handleDownloadPromptResources = () => {
    if (promptResources.every((item) => !item.content.trim())) {
      showToast('⚠️ 还没有可下载的拆分结果，请先完成前面的拆分流程');
      return;
    }

    promptResources.forEach((item, index) => {
      window.setTimeout(() => downloadTextFile(item.filename, item.content), index * 120);
    });
    showToast('✅ 已开始下载 3 个 Prompt 资源文件');
  };

  const handleCopyPrompt = () => {
    copyToClipboard(promptText);
  };

  const updateStepRuntime = useCallback((stepId, updater) => {
    setStepRuntimeMap((prev) => {
      const current = prev[stepId] || createStepRuntime();
      const nextValue = typeof updater === 'function'
        ? updater(current)
        : { ...current, ...updater };
      return {
        ...prev,
        [stepId]: nextValue,
      };
    });
  }, []);

  const resetStepStatesFrom = useCallback((startIndex, targetStatus = 'pending') => {
    setStepRuntimeMap((prev) => {
      const next = { ...prev };
      orchestrationSteps.forEach((step, index) => {
        if (index < startIndex) return;
        const current = prev[step.id] || createStepRuntime();
        next[step.id] = {
          ...createStepRuntime(),
          runCount: current.runCount || 0,
          status: index === startIndex && targetStatus === 'rolled_back' ? 'rolled_back' : 'never',
        };
      });
      return next;
    });
  }, [orchestrationSteps]);

  const validateExecutionPrerequisites = useCallback((requireSteps = false) => {
    if (!selectedEngine) {
      showToast('⚠️ 请先选择执行引擎');
      return false;
    }
    if (!state.projectPath) {
      showToast('⚠️ 请先在第一步配置项目路径');
      return false;
    }
    if (promptResources.every((item) => !item.content.trim())) {
      showToast('⚠️ 还没有可执行的 Prompt 资源，请先完成拆分');
      return false;
    }
    if (requireSteps && orchestrationSteps.length === 0) {
      showToast('⚠️ 当前任务编排中没有可执行步骤');
      return false;
    }
    return true;
  }, [orchestrationSteps.length, promptResources, selectedEngine, showToast, state.projectPath]);

  const prepareExecutionResources = useCallback(async () => {
    const saved = await savePromptResources(state.projectPath, promptResources);
    appendTerminal(`[taskforge] Prompt 资源已写入: ${saved.outputDir}\n`);
    saved.files.forEach((file) => {
      appendTerminal(`[taskforge] - ${file.filename}\n`);
    });

    const packagesToInstall = [...new Set(
      skillsForPrompt
        .map((s) => (s.npmName || '').trim())
        .filter(Boolean),
    )];

    if (packagesToInstall.length > 0) {
      setTerminalStatus(`正在安装 ${packagesToInstall.length} 个 npm Skill 包...`);
      appendTerminal('[taskforge] 即将执行 npm install（流式输出如下）...\n');
    } else {
      setTerminalStatus('无可安装 npm 包，准备启动 CLI');
      appendTerminal('[taskforge] 当前勾选项无 npm 包名，跳过安装\n');
    }

    const installResult = await new Promise((resolve, reject) => {
      if (packagesToInstall.length === 0) {
        resolve({ aborted: false });
        return;
      }
      const cancelInstall = installSkillPackages(state.projectPath, packagesToInstall, {
        onStatus: (msg) => setTerminalStatus(msg),
        onChunk: (text) => appendTerminal(text),
        onDone: () => resolve({ aborted: false }),
        onAborted: () => resolve({ aborted: true }),
        onError: (msg, stderr) => {
          reject(new Error(stderr ? `${msg}\n${stderr}` : msg));
        },
      });
      abortRef.current = cancelInstall;
    });

    abortRef.current = null;

    if (installResult.aborted || stopRequestedRef.current) {
      return { aborted: true };
    }

    if (skillsForPrompt.length > 0) {
      appendTerminal('[taskforge] 已纳入本轮 Prompt 的 Skills:\n');
      skillsForPrompt.forEach((skill) => {
        appendTerminal(`- ${skill.name}${skill.npmName ? ` → ${skill.npmName}` : ''}\n`);
      });
    }

    return { aborted: false };
  }, [appendTerminal, promptResources, skillsForPrompt, state.projectPath]);

  const runTaskWithCli = useCallback((task) => (
    new Promise((resolve, reject) => {
      stopRequestedRef.current = false;
      abortRef.current = aiExecuteTask(
        {
          engine: selectedEngine,
          projectPath: state.projectPath,
          task,
          projectContext: state.extraNotes || '',
        },
        {
          onStatus: (msg) => setTerminalStatus(msg),
          onChunk: (text) => appendTerminal(text),
          onDone: (output) => {
            const aborted = stopRequestedRef.current;
            abortRef.current = null;
            resolve({ aborted, output: output || '' });
          },
          onError: (msg, stderr) => {
            abortRef.current = null;
            if (stopRequestedRef.current) {
              resolve({ aborted: true, output: '' });
              return;
            }
            reject(new Error(stderr ? `${msg}\n${stderr}` : msg));
          },
        }
      );
    })
  ), [appendTerminal, selectedEngine, state.extraNotes, state.projectPath]);

  const handleStopExecute = () => {
    if (abortRef.current) {
      stopRequestedRef.current = true;
      abortRef.current();
      abortRef.current = null;
      setTerminalStatus('正在停止...');
      appendTerminal('\n[taskforge] 已发送停止指令，等待当前过程结束...\n');
      showToast('⏹️ 已发送停止指令');
      return;
    }
  };

  const handleExecute = async () => {
    if (!validateExecutionPrerequisites()) return;

    stopRequestedRef.current = false;
    currentStepIdRef.current = '';
    setExecutionMode('full');
    setTerminalVisible(true);
    setIsExecuting(true);
    setTerminalOutput('');
    setTerminalStatus(`准备使用 ${selectedEngine === 'claude' ? 'Claude Code' : 'Cursor CLI'} 执行...`);

    try {
      const prepareResult = await prepareExecutionResources();
      if (prepareResult.aborted) {
        setIsExecuting(false);
        setTerminalStatus('执行已停止');
        return;
      }
      appendTerminal(`\n[taskforge] 即将启动 ${selectedEngine === 'claude' ? 'Claude Code' : 'Cursor CLI'}...\n\n`);
      const result = await runTaskWithCli({
        title: '执行 Prompt 资源任务',
        prompt: promptText,
      });
      setIsExecuting(false);
      if (result.aborted) {
        setTerminalStatus('执行已停止');
        return;
      }
      setTerminalStatus('执行完成');
      appendTerminal('\n\n[taskforge] 执行完成\n');
      showToast('✅ 执行完成');
    } catch (error) {
      abortRef.current = null;
      setIsExecuting(false);
      setTerminalStatus('执行失败');
      appendTerminal(`[taskforge] ${error.message}\n`);
      showToast(error.message || '❌ 执行失败');
    }
  };

  const normalizeStepsWithAgent = useCallback(async () => {
    if (!selectedEngine) {
      throw new Error('请先选择执行引擎后再规范化步骤');
    }
    if (!state.projectPath) {
      throw new Error('请先配置项目路径后再规范化步骤');
    }
    if (!state.splitDrafts?.taskOrchestration?.trim()) {
      throw new Error('当前没有可规范化的任务编排内容');
    }

    setIsNormalizingSteps(true);
    setTerminalVisible(true);
    setExecutionMode('stepwise');
    setTerminalOutput('[taskforge] 本地未解析出可执行步骤，正在调用 Agent 规范化 03-task-orchestration.md...\n');
    setTerminalStatus('正在规范化步骤结构...');

    try {
      const result = await normalizeTaskOrchestration({
        engine: selectedEngine,
        projectPath: state.projectPath,
        intentDecomposition: state.splitDrafts?.intentDecomposition || '',
        executionPlan: state.splitDrafts?.executionPlan || '',
        taskOrchestration: state.splitDrafts?.taskOrchestration || '',
      });
      const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
      if (!tasks.length) {
        throw new Error('Agent 已返回结果，但没有生成可执行步骤');
      }
      setNormalizedSteps(tasks);
      setTerminalOutput((prev) => `${prev}[taskforge] Agent 已生成 ${tasks.length} 个标准步骤，右侧列表已更新。\n`);
      setTerminalStatus(`已规范化 ${tasks.length} 个步骤`);
      showToast(`✅ 已生成 ${tasks.length} 个标准步骤`);
      return tasks;
    } finally {
      setIsNormalizingSteps(false);
    }
  }, [
    selectedEngine,
    showToast,
    state.projectPath,
    state.splitDrafts,
  ]);

  const openStepwisePanel = async () => {
    let steps = orchestrationSteps;
    if (steps.length === 0) {
      try {
        const generated = await normalizeStepsWithAgent();
        steps = Array.isArray(generated) ? generated : [];
      } catch (error) {
        showToast(error.message || '❌ 规范化步骤失败');
        setTerminalStatus('步骤规范化失败');
        setTerminalOutput((prev) => `${prev}[taskforge] ${error.message}\n`);
        return;
      }
    }
    if (steps.length === 0) {
      showToast('⚠️ 当前任务编排中没有可执行的步骤');
      return;
    }
    setExecutionMode('stepwise');
    setTerminalVisible(true);
    setTerminalOutput((prev) => prev || '[taskforge] 分步执行模式已就绪，请在右侧步骤列表中选择要执行的步骤。\n');
    setTerminalStatus('请选择要执行的步骤');
  };

  const isDependencySatisfied = useCallback((step, completedIds = new Set()) => {
    if (!step.dependencies?.length) return { ok: true };
    for (const dep of step.dependencies) {
      const depText = String(dep || '').trim();
      if (!depText) continue;
      const depIndex = orchestrationSteps.findIndex((candidate, index) => (
        candidate.id === depText ||
        candidate.title === depText ||
        `[${candidate.id}]` === depText ||
        String(index + 1) === depText
      ));

      if (depIndex === -1) continue;

      const depStep = orchestrationSteps[depIndex];
      const runtime = stepRuntimeMap[depStep.id] || createStepRuntime();
      const done = runtime.status === 'completed' || completedIds.has(depStep.id);
      if (!done) {
        return {
          ok: false,
          dependency: depStep.title,
        };
      }
    }
    return { ok: true };
  }, [orchestrationSteps, stepRuntimeMap]);

  const executeSelectedSteps = useCallback(async (stepIds) => {
    if (!validateExecutionPrerequisites(true)) return;
    if (!Array.isArray(stepIds) || stepIds.length === 0) {
      showToast('⚠️ 请先选择至少一个步骤');
      return;
    }

    const orderedStepIds = [...stepIds].sort((a, b) => (stepIndexMap.get(a) ?? 0) - (stepIndexMap.get(b) ?? 0));
    const selectedSteps = orderedStepIds
      .map((id) => orchestrationSteps.find((step) => step.id === id))
      .filter(Boolean);

    if (selectedSteps.length === 0) {
      showToast('⚠️ 未找到可执行的步骤');
      return;
    }

    stopRequestedRef.current = false;
    currentStepIdRef.current = '';
    setExecutionMode('stepwise');
    setTerminalVisible(true);
    setTerminalOutput('');
    setIsExecuting(true);
    setTerminalStatus(`准备分步执行 ${selectedSteps.length} 个步骤...`);

    try {
      const prepareResult = await prepareExecutionResources();
      if (prepareResult.aborted) {
        setIsExecuting(false);
        setTerminalStatus('执行已停止');
        return;
      }

      const completedInBatch = new Set();

      for (let index = 0; index < selectedSteps.length; index += 1) {
        const step = selectedSteps[index];
        const stepPosition = (stepIndexMap.get(step.id) ?? 0) + 1;
        const dependencyStatus = isDependencySatisfied(step, completedInBatch);

        if (!dependencyStatus.ok) {
          updateStepRuntime(step.id, (current) => ({
            ...current,
            status: 'failed',
            lastError: `依赖步骤未完成：${dependencyStatus.dependency}`,
          }));
          throw new Error(`步骤「${step.title}」存在未完成依赖：${dependencyStatus.dependency}`);
        }

        currentStepIdRef.current = step.id;
        updateStepRuntime(step.id, (current) => ({
          ...current,
          status: 'running',
          runCount: (current.runCount || 0) + 1,
          lastRunAt: new Date().toISOString(),
          lastError: '',
        }));

        appendTerminal(`\n[taskforge] ===== 开始步骤 ${stepPosition}/${orchestrationSteps.length}: ${step.title} =====\n`);
        setTerminalStatus(`正在执行步骤 ${stepPosition}: ${step.title}`);

        const checkpointResult = await createStepCheckpoint(state.projectPath, {
          id: step.id,
          title: step.title,
        });

        updateStepRuntime(step.id, (current) => ({
          ...current,
          checkpoint: checkpointResult.checkpoint,
        }));
        appendTerminal(`[taskforge] 已为步骤 ${step.title} 创建回退点\n`);

        const runResult = await runTaskWithCli({
          title: `分步执行: ${step.title}`,
          prompt: buildScopedExecutionPrompt(step, stepPosition - 1, orchestrationSteps, skillsBlock),
        });

        if (runResult.aborted) {
          updateStepRuntime(step.id, (current) => ({
            ...current,
            status: 'interrupted',
          }));
          setIsExecuting(false);
          setTerminalStatus('执行已停止');
          return;
        }

        completedInBatch.add(step.id);
        updateStepRuntime(step.id, (current) => ({
          ...current,
          status: 'completed',
          lastCompletedAt: new Date().toISOString(),
        }));
        appendTerminal(`[taskforge] 步骤完成: ${step.title}\n`);
      }

      setIsExecuting(false);
      currentStepIdRef.current = '';
      setTerminalStatus('分步执行完成');
      appendTerminal('\n[taskforge] 所选步骤已执行完成，已停止在当前批次末尾。\n');
      showToast('✅ 所选步骤执行完成');
    } catch (error) {
      const currentStepId = currentStepIdRef.current;
      if (currentStepId) {
        updateStepRuntime(currentStepId, (current) => ({
          ...current,
          status: 'failed',
          lastError: error.message || '执行失败',
        }));
      }
      setIsExecuting(false);
      setTerminalStatus('执行失败');
      appendTerminal(`[taskforge] ${error.message}\n`);
      showToast(error.message || '❌ 分步执行失败');
    } finally {
      abortRef.current = null;
      currentStepIdRef.current = '';
    }
  }, [
    isDependencySatisfied,
    orchestrationSteps,
    prepareExecutionResources,
    runTaskWithCli,
    showToast,
    skillsBlock,
    state.projectPath,
    stepIndexMap,
    updateStepRuntime,
    validateExecutionPrerequisites,
  ]);

  const handleRollbackStep = useCallback(async (stepId, options = {}) => {
    const stepIndex = stepIndexMap.get(stepId);
    const step = typeof stepIndex === 'number' ? orchestrationSteps[stepIndex] : null;
    const runtime = step ? (stepRuntimeMap[step.id] || createStepRuntime()) : null;

    if (!step || !runtime?.checkpoint) {
      showToast('⚠️ 当前步骤还没有可回退的快照');
      return false;
    }
    if (isExecuting) {
      showToast('⚠️ 请先停止当前执行，再进行回退');
      return false;
    }

    setExecutionMode('stepwise');
    setTerminalVisible(true);
    setTerminalOutput('');
    setTerminalStatus(`正在回退步骤: ${step.title}`);

    try {
      await rollbackToStepCheckpoint(state.projectPath, runtime.checkpoint);
      appendTerminal(`[taskforge] 已回退到步骤「${step.title}」执行前的状态\n`);
      resetStepStatesFrom(stepIndex, 'rolled_back');
      if (!options.silent) {
        showToast(`✅ 已回退步骤：${step.title}`);
      }
      return true;
    } catch (error) {
      appendTerminal(`[taskforge] 回退失败: ${error.message}\n`);
      showToast(error.message || '❌ 回退失败');
      return false;
    }
  }, [isExecuting, orchestrationSteps, resetStepStatesFrom, showToast, state.projectPath, stepIndexMap, stepRuntimeMap]);

  const handleReexecuteStep = useCallback(async (stepId) => {
    const rolledBack = await handleRollbackStep(stepId, { silent: true });
    if (!rolledBack) return;
    await executeSelectedSteps([stepId]);
  }, [executeSelectedSteps, handleRollbackStep]);

  const canExecute = Boolean(selectedEngine) && !isExecuting;
  const canOpenStepwise = !skillsLoading && !isExecuting && !isNormalizingSteps;

  return (
    <div className="step-content active fade-in">
      <div className="split-editor-card">
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleDownloadPromptResources}>
            ⬇️ 下载 Prompt 资源
          </button>
          <button className="btn btn-secondary" onClick={handleCopyPrompt}>
            📋 复制 Prompt
          </button>
        </div>

        <div className="ai-log-panel" style={{ marginBottom: 16 }}>
          <div className="ai-log-header">
            <span>🧩 推荐 Skills {skillsLoading ? '· 加载中...' : `· ${recommendedSkills.length} 个`}</span>
          </div>
          <div className="ai-log-body" style={{ whiteSpace: 'normal' }}>
            {recommendedSkills.length > 0 ? recommendedSkills.map((skill, index) => {
              const rowId = skillRowId(skill, index);
              return (
                <label
                  key={rowId}
                  style={{
                    display: 'flex',
                    gap: 10,
                    marginBottom: 12,
                    alignItems: 'flex-start',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={skillInstallSelected[rowId] !== false}
                    onChange={(e) => {
                      setSkillInstallSelected((prev) => ({
                        ...prev,
                        [rowId]: e.target.checked,
                      }));
                    }}
                    style={{ marginTop: 4 }}
                  />
                  <span style={{ flex: 1 }}>
                    <strong>{skill.name}</strong>
                    {skill.npmName ? (
                      <span style={{ marginLeft: 8, fontSize: '0.9em', opacity: 0.85 }}>
                        npm: {skill.npmName}
                      </span>
                    ) : (
                      <span style={{ marginLeft: 8, fontSize: '0.9em', opacity: 0.65 }}>
                        （无 npm 包，仅规范参考）
                      </span>
                    )}
                    <div style={{ marginTop: 4 }}>{skill.description || '无描述'}</div>
                  </span>
                </label>
              );
            }) : '当前未命中推荐 Skill，将按默认 Prompt 执行。'}
          </div>
        </div>

        <textarea
          className="form-textarea split-editor-textarea mono-input"
          value={promptText}
          readOnly
          style={{ minHeight: 320, marginBottom: 20 }}
        />

        <div className="template-tabs" style={{ marginBottom: 16 }}>
          {ENGINE_OPTIONS.map((engine) => (
            <button
              key={engine.key}
              className={`template-tab${selectedEngine === engine.key ? ' active' : ''}`}
              onClick={() => setSelectedEngine(engine.key)}
            >
              {engine.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary btn-lg"
            onClick={handleExecute}
            disabled={!canExecute || skillsLoading}
            style={{ opacity: canExecute && !skillsLoading ? 1 : 0.55 }}
          >
            ▶ 立即执行
          </button>
          <button
            className="btn btn-secondary btn-lg"
            onClick={openStepwisePanel}
            disabled={!canOpenStepwise || isExecuting}
            style={{ opacity: canOpenStepwise && !isExecuting ? 1 : 0.55 }}
          >
            ≡ 分步执行
          </button>
          {isExecuting && (
            <button className="btn btn-danger" onClick={handleStopExecute}>
              ⏹️ 停止执行
            </button>
          )}
        </div>

        {terminalVisible && (
          <div className={executionMode === 'stepwise' ? 'stepwise-shell' : ''}>
            <div className="terminal-wrapper">
              <div className="terminal-header">
                <div className="terminal-dots">
                  <span className="dot red" />
                  <span className="dot yellow" />
                  <span className="dot green" />
                </div>
                <div className="terminal-title">
                  {selectedEngine === 'claude' ? 'Claude Code' : selectedEngine === 'cursor' ? 'Cursor CLI' : 'CLI'}
                  {terminalStatus ? ` · ${terminalStatus}` : ''}
                </div>
              </div>
              <pre ref={terminalBodyRef} className="terminal-body">
                {terminalPieces.map((piece, i) =>
                  piece.kind === 'mcp' ? (
                    <span key={i} className="terminal-mcp-name">
                      {piece.value}
                    </span>
                  ) : (
                    <span key={i}>{piece.value}</span>
                  ))}
                {isExecuting && <span className="terminal-cursor">▋</span>}
              </pre>
            </div>

            {executionMode === 'stepwise' && (
              <div className="stepwise-sidebar">
                <div className="stepwise-sidebar-header">
                  <div>
                    <div className="stepwise-sidebar-title">步骤详情</div>
                    <div className="stepwise-sidebar-subtitle">
                      共 {orchestrationSteps.length} 步，已选 {selectedStepIds.length} 步
                    </div>
                  </div>
                  <div className="stepwise-toolbar">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => executeSelectedSteps(selectedStepIds)}
                      disabled={selectedStepIds.length === 0 || isExecuting}
                    >
                      执行已选
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setSelectedStepIds([])}
                      disabled={selectedStepIds.length === 0 || isExecuting}
                    >
                      清空选择
                    </button>
                  </div>
                </div>

                <div className="stepwise-list">
                  {orchestrationSteps.map((step, index) => {
                    const runtime = stepRuntimeMap[step.id] || createStepRuntime();
                    const isSelected = selectedStepIds.includes(step.id);
                    const isRunning = runtime.status === 'running';
                    const hasHistory = ['completed', 'interrupted', 'failed'].includes(runtime.status);

                    return (
                      <div
                        key={step.id}
                        className={`orchestration-step-card status-${runtime.status}${isRunning ? ' active' : ''}`}
                        title={buildStepTooltip(step, index, runtime)}
                      >
                        <div className="orchestration-step-header">
                          <div className="orchestration-step-index">{index + 1}</div>
                          <div className="orchestration-step-main">
                            <div className="orchestration-step-title-row">
                              <div className="orchestration-step-title">{step.title}</div>
                              <span className={`orchestration-step-badge badge-${runtime.status}`}>
                                {getRuntimeLabel(runtime.status)}
                              </span>
                            </div>
                            <div className="orchestration-step-desc">
                              {step.description || '悬停可查看该步骤的详细描述与验收信息。'}
                            </div>
                            <div className="orchestration-step-meta">
                              <span>依赖 {step.dependencies?.length || 0}</span>
                              <span>验收 {step.acceptanceCriteria?.length || 0}</span>
                              <span>运行 {runtime.runCount || 0}</span>
                              {runtime.lastCompletedAt && (
                                <span>完成于 {formatTimeLabel(runtime.lastCompletedAt)}</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="orchestration-step-actions">
                          {isRunning ? (
                            <button className="btn btn-danger btn-sm" onClick={handleStopExecute}>
                              停止
                            </button>
                          ) : hasHistory ? (
                            <>
                              <button className="btn btn-secondary btn-sm" onClick={() => handleRollbackStep(step.id)}>
                                回退
                              </button>
                              <button className="btn btn-primary btn-sm" onClick={() => handleReexecuteStep(step.id)}>
                                重新执行
                              </button>
                            </>
                          ) : (
                            <button className="btn btn-primary btn-sm" onClick={() => executeSelectedSteps([step.id])}>
                              执行
                            </button>
                          )}

                          {!isRunning && (
                            <button
                              className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                              onClick={() => {
                                setSelectedStepIds((prev) => (
                                  prev.includes(step.id)
                                    ? prev.filter((id) => id !== step.id)
                                    : [...prev, step.id]
                                ));
                              }}
                            >
                              {isSelected ? '已选中' : '加入批量'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
