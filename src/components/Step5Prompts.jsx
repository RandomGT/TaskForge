import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { parseTaskOrchestrationDraft, parseTaskOrchestrationTests } from '../domains/pipeline/draftParsers';
import {
  analyzeRecommendedSkills,
  aiExecuteTask,
  createStepCheckpoint,
  ensureGitBranch,
  fetchCursorModels,
  fetchGitBranches,
  installSkillPackages,
  normalizeTaskOrchestration,
  rollbackToStepCheckpoint,
  savePromptResources,
  syncSkillsCatalog,
} from '../utils/aiService';
import { persistJobState } from '../utils/jobApi';

const PROMPT_RESOURCE_FILES = [
  { field: 'intentDecomposition', filename: '01-intent-decomposition.md' },
  { field: 'executionPlan', filename: '02-execution-plan.md' },
  { field: 'taskOrchestration', filename: '03-task-orchestration.md' },
];

const ENGINE_OPTIONS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'cursor', label: 'Cursor CLI' },
];

function getEngineLabel(engine) {
  return ENGINE_OPTIONS.find((item) => item.key === engine)?.label || 'CLI';
}

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

function formatGitBranchLogEntry(entry) {
  const step = entry.step || 'git';
  if (!entry.stderr && !entry.stdout && (entry.code == null || entry.code === 0)) {
    return `[taskforge] ${step}\n`;
  }
  let out = `[taskforge] ${step}`;
  if (entry.code != null && entry.code !== 0) out += ` （退出码 ${entry.code}）`;
  out += '\n';
  if (entry.stdout) out += entry.stdout + (/\n$/.test(entry.stdout) ? '' : '\n');
  if (entry.stderr) out += entry.stderr + (/\n$/.test(entry.stderr) ? '' : '\n');
  return out;
}

function skillRowId(skill, index) {
  return skill.id ?? skill.npmName ?? skill.name ?? `skill-${index}`;
}

function formatSkillInstallMethod(skill) {
  if (skill.installMethod) return skill.installMethod;
  if (skill.npmName) return `npm install ${skill.npmName}`;
  return '无';
}

function formatSkillsBlock(skills) {
  if (!skills.length) {
    return '- 当前未命中可用 Skill，可按默认工程规范执行。';
  }

  return skills.map((skill, index) => {
    const tags = Array.isArray(skill.tags) && skill.tags.length ? `标签: ${skill.tags.join(', ')}` : '标签: 无';
    const matched = Array.isArray(skill.matchedProjectEvidence) && skill.matchedProjectEvidence.length
      ? `项目依据: ${skill.matchedProjectEvidence.join('；')}`
      : Array.isArray(skill.matchedTokens) && skill.matchedTokens.length
        ? `命中线索: ${skill.matchedTokens.join(', ')}`
        : '项目依据: Agent 综合判断';
    const reason = skill.recommendationReason
      ? `
   - 推荐原因: ${skill.recommendationReason}`
      : '';
    return `${index + 1}. 名称: ${skill.name}
   - 描述: ${skill.description || '无描述'}
   - 安装方式: ${formatSkillInstallMethod(skill)}
   - ${tags}
   - ${matched}${reason}${skill.npmName ? `
   - npm 包名: ${skill.npmName}` : `
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
    lastOutput: '',
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

在正式执行前，请充分理解下方「候选 Skills」中每一项的名称与描述；这些候选项来自人工触发的 Skills 同步与分析流程。结合三份 md 判断哪些 Skill 与本次任务真正相关，仅对适用项严格遵循其规范（不适用的不要假装已采用）。

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

function createTestRuntime() {
  return {
    status: 'never', // never | running | completed | interrupted | failed
    runCount: 0,
    lastRunAt: '',
    lastCompletedAt: '',
    lastError: '',
    lastOutput: '',
  };
}

function getTestCategoryLabel(category) {
  switch (category) {
    case 'unit':
      return '单测';
    case 'integration':
      return '集测';
    case 'e2e':
      return '端到端';
    case 'manual':
      return '人工验证';
    default:
      return '测试';
  }
}

function buildTestExecutionPrompt(test, allSteps) {
  const relatedScope = Array.isArray(test.scope) && test.scope.length
    ? test.scope.map((item) => `- ${item}`).join('\n')
    : '- 未指定范围，请结合任务编排判断';
  const dependencyText = Array.isArray(test.dependencies) && test.dependencies.length
    ? test.dependencies.map((item) => `- ${item}`).join('\n')
    : '- 无';
  const commandText = Array.isArray(test.commands) && test.commands.length
    ? test.commands.map((item) => `- ${item}`).join('\n')
    : '- 未提供命令，请先定位仓库内已有测试入口并在范围内执行';
  const filesText = Array.isArray(test.files) && test.files.length
    ? test.files.map((item) => `- ${item}`).join('\n')
    : '- 未指定文件';
  const acceptanceText = Array.isArray(test.acceptanceCriteria) && test.acceptanceCriteria.length
    ? test.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
    : '- 以本测试目标是否完成为准';
  const orderedList = allSteps.map((item, itemIndex) => `${itemIndex + 1}. [${item.id}] ${item.title}`).join('\n');

  return `你是一个负责验证研发结果的 AI Agent。

开始执行前，必须先完整阅读并分析以下三个文件，它们是本次验证的唯一业务依据：
1. \`.taskforge-prompts/01-intent-decomposition.md\`
2. \`.taskforge-prompts/02-execution-plan.md\`
3. \`.taskforge-prompts/03-task-orchestration.md\`

本轮只允许执行下面这一项测试：
- 测试 ID：${test.id}
- 测试标题：${test.title}
- 测试类型：${getTestCategoryLabel(test.category)}
- 测试目标：${test.objective || '以命令与验收标准为准'}

测试范围：
${relatedScope}

依赖任务：
${dependencyText}

推荐命令 / 执行入口：
${commandText}

关联文件：
${filesText}

验收标准：
${acceptanceText}

全量任务清单（仅用于定位上下文，不要执行未授权的实现改动）：
${orderedList}

执行规则：
- 本轮重点是验证，不是继续扩写实现；除非为了修复明显的测试脚本或命令入口问题，否则不要擅自改业务代码。
- 优先执行上方已有命令；如果命令不可用，再在同等范围内寻找最接近的仓库测试入口。
- 若测试失败，要明确指出失败现象、命令输出摘要、可能关联的任务或文件。
- 若测试通过，要说明执行了哪些命令、验证了哪些点。
- 如果发现该测试事实上无法由 AI 完成，应立即停止并说明为何需要人工验证。

输出要求：
- 先给出简短验证计划。
- 再执行测试。
- 最后输出测试结果摘要，包含：执行命令、结果、失败点或通过依据。`;
}

export default function Step5Prompts() {
  const { state, dispatch, copyToClipboard, showToast } = useAppContext();
  const [selectedEngine, setSelectedEngine] = useState(state.aiEngine || '');
  const [cursorModels, setCursorModels] = useState([]);
  const [cursorModelsLoading, setCursorModelsLoading] = useState(false);
  const [cursorModelsError, setCursorModelsError] = useState('');
  const [selectedCursorModel, setSelectedCursorModel] = useState('');
  const [skillsCatalogMeta, setSkillsCatalogMeta] = useState({
    loaded: false,
    total: 0,
    updatedAt: '',
    filePath: '',
    skipped: false,
  });
  const [skillsCatalogLoading, setSkillsCatalogLoading] = useState(false);
  const [skillsAnalyzing, setSkillsAnalyzing] = useState(false);
  const [skillsAnalysisDone, setSkillsAnalysisDone] = useState(false);
  const [skillsAnalysisSummary, setSkillsAnalysisSummary] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalStatus, setTerminalStatus] = useState('');
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [recommendedSkills, setRecommendedSkills] = useState([]);
  /** skillRowId -> 是否纳入 Prompt（默认全选；npm 安装仅通过「一键安装全部 Skill」） */
  const [skillInstallSelected, setSkillInstallSelected] = useState({});
  /** skillRowId -> 正在执行一键安装中（逐包） */
  const [skillRowInstallLoading, setSkillRowInstallLoading] = useState({});
  const [isBulkInstallingSkills, setIsBulkInstallingSkills] = useState(false);
  const [executionMode, setExecutionMode] = useState('full');
  const [stepRuntimeMap, setStepRuntimeMap] = useState({});
  const [selectedStepIds, setSelectedStepIds] = useState([]);
  const [normalizedSteps, setNormalizedSteps] = useState([]);
  const [normalizedTests, setNormalizedTests] = useState([]);
  const [testRuntimeMap, setTestRuntimeMap] = useState({});
  const [isNormalizingSteps, setIsNormalizingSteps] = useState(false);
  /** 执行分支：来自 git branch -a */
  const [execBranchList, setExecBranchList] = useState([]);
  const [execBranchCurrent, setExecBranchCurrent] = useState('');
  const [selectedExecBranch, setSelectedExecBranch] = useState('');
  const [createBranchModalOpen, setCreateBranchModalOpen] = useState(false);
  const [createBranchDraft, setCreateBranchDraft] = useState('');
  const [createBranchBusy, setCreateBranchBusy] = useState(false);
  const [gitBranchState, setGitBranchState] = useState({ ok: true, loading: false, error: '' });
  const abortRef = useRef(null);
  const stopRequestedRef = useRef(false);
  const currentStepIdRef = useRef('');
  const terminalBodyRef = useRef(null);
  const restoredPromptStateKeyRef = useRef('');
  const persistedPromptStateJsonRef = useRef('');

  const persistedPromptState = state.optimizations?.promptExecution || {};

  const terminalPieces = useMemo(
    () => splitTerminalMcpMarkers(terminalOutput || '等待执行输出...'),
    [terminalOutput],
  );

  const fallbackTaskGraph = useMemo(
    () => parseTaskOrchestrationDraft(state.splitDrafts?.taskOrchestration || ''),
    [state.splitDrafts?.taskOrchestration],
  );

  const fallbackTests = useMemo(
    () => parseTaskOrchestrationTests(state.splitDrafts?.taskOrchestration || ''),
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

  const executableTests = useMemo(() => (
    ((Array.isArray(normalizedTests) && normalizedTests.length ? normalizedTests : fallbackTests)).map((test, index) => ({
      id: String(test.id ?? `test-${index + 1}`),
      title: test.title || `测试 ${index + 1}`,
      category: test.category || 'manual',
      objective: test.objective || '',
      scope: Array.isArray(test.scope) ? test.scope : [],
      dependencies: Array.isArray(test.dependencies) ? test.dependencies : [],
      files: Array.isArray(test.files) ? test.files : [],
      commands: Array.isArray(test.commands) ? test.commands : [],
      acceptanceCriteria: Array.isArray(test.acceptanceCriteria) ? test.acceptanceCriteria : [],
      aiExecutable: Boolean(test.aiExecutable),
      executionHint: test.executionHint || '',
      manualNotes: test.manualNotes || '',
    }))
  ), [fallbackTests, normalizedTests]);

  const stepIndexMap = useMemo(() => {
    const map = new Map();
    orchestrationSteps.forEach((step, index) => {
      map.set(step.id, index);
    });
    return map;
  }, [orchestrationSteps]);

  const mergeBranchesResponse = useCallback((data, preserveSelected) => {
    const branches = data.branches || [];
    setExecBranchList(branches);
    setExecBranchCurrent(data.current || '');
    if (!preserveSelected) {
      setSelectedExecBranch((prev) => {
        const names = branches.map((b) => b.name);
        if (prev && names.includes(prev)) return prev;
        if (data.current && names.includes(data.current)) return data.current;
        return names[0] || '';
      });
    }
  }, []);

  useEffect(() => {
    if (terminalBodyRef.current) {
      terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
    }
  }, [terminalOutput, terminalStatus, terminalPieces]);

  useEffect(() => {
    const persistedKey = JSON.stringify(persistedPromptState || {});
    if (persistedKey === restoredPromptStateKeyRef.current) return;
    restoredPromptStateKeyRef.current = persistedKey;
    setSelectedEngine(persistedPromptState.selectedEngine || state.aiEngine || '');
    setCursorModels(Array.isArray(persistedPromptState.cursorModels) ? persistedPromptState.cursorModels : []);
    setCursorModelsError(persistedPromptState.cursorModelsError || '');
    setSelectedCursorModel(persistedPromptState.selectedCursorModel || state.cursorModel || '');
    setSkillsCatalogMeta(persistedPromptState.skillsCatalogMeta || {
      loaded: false,
      total: 0,
      updatedAt: '',
      filePath: '',
      skipped: false,
    });
    setSkillsAnalysisDone(Boolean(persistedPromptState.skillsAnalysisDone));
    setSkillsAnalysisSummary(persistedPromptState.skillsAnalysisSummary || '');
    setTerminalOutput(persistedPromptState.terminalOutput || '');
    setTerminalStatus(persistedPromptState.terminalStatus || '');
    setTerminalVisible(Boolean(persistedPromptState.terminalVisible));
    setRecommendedSkills(Array.isArray(persistedPromptState.recommendedSkills) ? persistedPromptState.recommendedSkills : []);
    setSkillInstallSelected(persistedPromptState.skillInstallSelected || {});
    setExecutionMode(persistedPromptState.executionMode || 'full');
    setStepRuntimeMap(persistedPromptState.stepRuntimeMap || {});
    setSelectedStepIds(Array.isArray(persistedPromptState.selectedStepIds) ? persistedPromptState.selectedStepIds : []);
    setNormalizedSteps(Array.isArray(persistedPromptState.normalizedSteps) ? persistedPromptState.normalizedSteps : []);
    setNormalizedTests(Array.isArray(persistedPromptState.normalizedTests) ? persistedPromptState.normalizedTests : []);
    setTestRuntimeMap(persistedPromptState.testRuntimeMap || {});
    setExecBranchCurrent(persistedPromptState.execBranchCurrent || '');
    setSelectedExecBranch(persistedPromptState.selectedExecBranch || '');
    setGitBranchState(persistedPromptState.gitBranchState || { ok: true, loading: false, error: '' });
  }, [persistedPromptState, state.aiEngine]);

  useEffect(() => {
    if (selectedEngine !== 'cursor') {
      setCursorModelsLoading(false);
      return undefined;
    }

    let cancelled = false;
    setCursorModelsLoading(true);
    setCursorModelsError('');

    fetchCursorModels()
      .then((data) => {
        if (cancelled) return;
        const models = Array.isArray(data.models) ? data.models : [];
        setCursorModels(models);
        setSelectedCursorModel((prev) => {
          const next = prev && models.some((item) => item.id === prev) ? prev : (models[0]?.id || '');
          dispatch({ type: 'SET_CURSOR_MODEL', model: next });
          return next;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setCursorModels([]);
        setCursorModelsError(error.message || '读取 Cursor 模型失败');
        setSelectedCursorModel('');
        dispatch({ type: 'SET_CURSOR_MODEL', model: '' });
      })
      .finally(() => {
        if (!cancelled) {
          setCursorModelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedEngine, dispatch]);

  useEffect(() => {
    const projectPath = state.projectPath?.trim();
    if (!projectPath) {
      setExecBranchList([]);
      setSelectedExecBranch('');
      setExecBranchCurrent('');
      setGitBranchState({ ok: true, loading: false, error: '' });
      return undefined;
    }

    let cancelled = false;
    setGitBranchState({ ok: false, loading: true, error: '' });
    (async () => {
      try {
        const data = await fetchGitBranches(projectPath);
        if (cancelled) return;
        if (!data.ok) {
          setExecBranchList([]);
          setSelectedExecBranch('');
          setExecBranchCurrent('');
          setGitBranchState({
            ok: false,
            loading: false,
            error: data.error || '读取分支失败',
          });
          return;
        }
        mergeBranchesResponse(data, false);
        setGitBranchState({ ok: true, loading: false, error: '' });
      } catch (e) {
        if (!cancelled) {
          setExecBranchList([]);
          setSelectedExecBranch('');
          setExecBranchCurrent('');
          setGitBranchState({
            ok: false,
            loading: false,
            error: e.message || '网络错误',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mergeBranchesResponse, state.projectPath]);

  useEffect(() => {
    if (!createBranchModalOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !createBranchBusy) {
        e.preventDefault();
        setCreateBranchModalOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [createBranchBusy, createBranchModalOpen]);

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
    setTestRuntimeMap((prev) => {
      const next = {};
      executableTests.forEach((test) => {
        next[test.id] = prev[test.id] || createTestRuntime();
      });
      return next;
    });
  }, [executableTests]);

  useEffect(() => {
    if ((fallbackTaskGraph.tasks || []).length > 0) {
      setNormalizedSteps([]);
    }
  }, [fallbackTaskGraph.tasks]);

  useEffect(() => {
    const next = {};
    recommendedSkills.forEach((s, i) => {
      next[skillRowId(s, i)] = true;
    });
    setSkillInstallSelected(next);
  }, [recommendedSkills]);

  const promptExecutionSnapshot = useMemo(() => ({
    selectedEngine,
    selectedCursorModel,
    cursorModels,
    cursorModelsError,
    skillsCatalogMeta,
    skillsAnalysisDone,
    skillsAnalysisSummary,
    terminalOutput,
    terminalStatus,
    terminalVisible,
    recommendedSkills,
    skillInstallSelected,
    executionMode,
    stepRuntimeMap,
    selectedStepIds,
    normalizedSteps,
    normalizedTests,
    testRuntimeMap,
    execBranchCurrent,
    selectedExecBranch,
    gitBranchState: gitBranchState?.ok === false && gitBranchState?.loading
      ? { ok: false, loading: false, error: gitBranchState.error || '' }
      : gitBranchState,
  }), [
    cursorModels,
    cursorModelsError,
    execBranchCurrent,
    executionMode,
    gitBranchState,
    normalizedSteps,
    normalizedTests,
    recommendedSkills,
    selectedEngine,
    selectedCursorModel,
    selectedExecBranch,
    selectedStepIds,
    testRuntimeMap,
    skillInstallSelected,
    skillsAnalysisDone,
    skillsAnalysisSummary,
    skillsCatalogMeta,
    stepRuntimeMap,
    terminalOutput,
    terminalStatus,
    terminalVisible,
  ]);

  useEffect(() => {
    const t = setTimeout(() => {
      const nextJson = JSON.stringify(promptExecutionSnapshot);
      if (nextJson === persistedPromptStateJsonRef.current) return;
      persistedPromptStateJsonRef.current = nextJson;
      dispatch({
        type: 'MERGE_OPTIMIZATIONS',
        value: {
          promptExecution: promptExecutionSnapshot,
        },
      });
      if (!state.currentJobId) return;
      persistJobState(state.currentJobId, state, {
        optimizations: {
          ...(state.optimizations || {}),
          promptExecution: promptExecutionSnapshot,
        },
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [
    dispatch,
    promptExecutionSnapshot,
    state,
  ]);

  const skillsForPrompt = useMemo(
    () => recommendedSkills.filter((s, i) => skillInstallSelected[skillRowId(s, i)] !== false),
    [recommendedSkills, skillInstallSelected],
  );

  /** 含 npm 的可安装包（去重，顺序与推荐列表首次出现一致） */
  const installableSkillPackagesPlan = useMemo(() => {
    const orderedPackages = [];
    const pkgToRowIds = new Map();
    recommendedSkills.forEach((skill, index) => {
      const pkg = (skill.npmName || '').trim();
      if (!pkg) return;
      const rowId = skillRowId(skill, index);
      if (!pkgToRowIds.has(pkg)) {
        pkgToRowIds.set(pkg, []);
        orderedPackages.push(pkg);
      }
      pkgToRowIds.get(pkg).push(rowId);
    });
    return { orderedPackages, pkgToRowIds };
  }, [recommendedSkills]);

  const skillsBlock = useMemo(() => formatSkillsBlock(skillsForPrompt), [skillsForPrompt]);

  const promptText = useMemo(() => `你是一个负责落地实现的 AI Agent。

开始执行前，必须先完整阅读并分析以下三个文件，它们是本次任务的唯一执行依据：
1. \`.taskforge-prompts/01-intent-decomposition.md\`
2. \`.taskforge-prompts/02-execution-plan.md\`
3. \`.taskforge-prompts/03-task-orchestration.md\`

在正式执行前，请充分理解下方「候选 Skills」中每一项的名称与描述；这些候选项来自人工触发的 Skills 同步与分析流程。结合三份 md 判断哪些 Skill 与本次任务真正相关，仅对适用项严格遵循其规范（不适用的不要假装已采用）。

Skill 使用方式：
- 下方为人工触发 Skills 同步后，再由 Agent 结合项目上下文分析得到的候选集；勾选仅决定某项是否写入本轮 Prompt，npm 包需在执行前通过「一键安装全部 Skill」单独安装。
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

  const handleSyncSkillsCatalog = useCallback(async () => {
    setSkillsCatalogLoading(true);
    try {
      const result = await syncSkillsCatalog();
      setSkillsCatalogMeta({
        loaded: true,
        total: result.totalLocal || 0,
        updatedAt: result.updatedAt || '',
        filePath: result.filePath || '',
        skipped: Boolean(result.skipped),
      });
      setRecommendedSkills([]);
      setSkillsAnalysisDone(false);
      setSkillsAnalysisSummary('');
      showToast(result.skipped ? '✅ Skills 列表未变化，已沿用本地缓存' : '✅ Skills 列表已更新到本地文件');
    } catch (error) {
      showToast(error.message || '❌ 同步 Skills 列表失败');
    } finally {
      setSkillsCatalogLoading(false);
    }
  }, [showToast]);

  const handleAnalyzeSkills = useCallback(async () => {
    if (!selectedEngine) {
      showToast('⚠️ 请先选择执行引擎');
      return;
    }
    if (!state.projectPath?.trim()) {
      showToast('⚠️ 请先在第一步配置项目路径');
      return;
    }
    if (promptResources.every((item) => !item.content.trim())) {
      showToast('⚠️ 请先完成前面的智能拆分，生成三个产物');
      return;
    }

    setSkillsAnalyzing(true);
    try {
      const result = await analyzeRecommendedSkills({
        engine: selectedEngine,
        projectPath: state.projectPath,
        projectName: state.projectName,
        requirementDesc: state.requirementDesc,
        techStack: state.techStack,
        extraNotes: state.extraNotes,
        intentDecomposition: state.splitDrafts?.intentDecomposition || '',
        executionPlan: state.splitDrafts?.executionPlan || '',
        taskOrchestration: state.splitDrafts?.taskOrchestration || '',
      });
      setRecommendedSkills(result.skills || []);
      setSkillsAnalysisDone(true);
      setSkillsAnalysisSummary(result.summary || '');
      setSkillsCatalogMeta((prev) => ({
        ...prev,
        loaded: true,
        total: result.totalCatalogSkills || prev.total,
        updatedAt: result.catalogUpdatedAt || prev.updatedAt,
        filePath: result.sourceFile || prev.filePath,
      }));
      showToast(`✅ Agent 已完成 Skills 分析${(result.skills || []).length ? '' : '（当前无需额外 Skill）'}`);
    } catch (error) {
      setRecommendedSkills([]);
      setSkillsAnalysisDone(false);
      setSkillsAnalysisSummary('');
      showToast(error.message || '❌ 分析推荐 Skills 失败');
    } finally {
      setSkillsAnalyzing(false);
    }
  }, [
    promptResources,
    selectedEngine,
    showToast,
    state.extraNotes,
    state.projectName,
    state.projectPath,
    state.requirementDesc,
    state.splitDrafts,
    state.techStack,
  ]);

  const appendTerminal = useCallback((text) => {
    if (!text) return;
    setTerminalOutput((prev) => prev + text);
  }, []);

  const syncExecutionBranch = useCallback(async () => {
    const projectPath = state.projectPath?.trim();
    if (!projectPath) return { ok: true };

    appendTerminal('\n[taskforge] ===== Git 执行分支 =====\n');
    try {
      const target = selectedExecBranch.trim();
      if (!target) {
        appendTerminal('[taskforge] ❌ 未选择目标分支\n');
        showToast('⚠️ 请选择执行分支');
        return { ok: false };
      }
      const data = await ensureGitBranch(projectPath, target, '');
      for (const log of data.logs || []) {
        appendTerminal(formatGitBranchLogEntry(log));
      }
      if (!data.ok) {
        appendTerminal(`[taskforge] ❌ ${data.error || '分支准备失败'}\n`);
        showToast(data.error || '分支准备失败');
        return { ok: false };
      }
      appendTerminal(`[taskforge] ✅ 当前分支: ${data.current || '（未知）'}\n`);
      return { ok: true };
    } catch (e) {
      appendTerminal(`[taskforge] ❌ ${e.message}\n`);
      showToast(e.message);
      return { ok: false };
    }
  }, [appendTerminal, selectedExecBranch, showToast, state.projectPath]);

  const openCreateBranchModal = useCallback(() => {
    setCreateBranchDraft('');
    setCreateBranchModalOpen(true);
  }, []);

  const closeCreateBranchModal = useCallback(() => {
    if (createBranchBusy) return;
    setCreateBranchModalOpen(false);
  }, [createBranchBusy]);

  const confirmCreateBranch = useCallback(async () => {
    const projectPath = state.projectPath?.trim();
    const base = selectedExecBranch.trim();
    const name = createBranchDraft.trim();
    if (!projectPath || !gitBranchState.ok) return;
    if (!base) {
      showToast('⚠️ 请先在「目标分支」中选择作为起点的分支');
      return;
    }
    if (!name) {
      showToast('⚠️ 请输入新分支名称');
      return;
    }
    setCreateBranchBusy(true);
    setTerminalVisible(true);
    appendTerminal(`\n[taskforge] ===== 新建本地分支（git checkout -b）=====\n`);
    appendTerminal(`[taskforge] 基础分支（先 git checkout）: ${base}\n`);
    try {
      const data = await ensureGitBranch(projectPath, base, name);
      for (const log of data.logs || []) {
        appendTerminal(formatGitBranchLogEntry(log));
      }
      if (!data.ok) {
        appendTerminal(`[taskforge] ❌ ${data.error || '创建失败'}\n`);
        showToast(data.error || '创建失败');
        return;
      }
      appendTerminal(`[taskforge] ✅ 当前已位于: ${data.current || name}\n`);
      appendTerminal('[taskforge] 若要以该分支作为执行目标，请在「目标分支」下拉里手动切换后，再执行「立即执行」或「分步执行」。\n');
      showToast('✅ 新分支已创建');
      setCreateBranchModalOpen(false);
      const fresh = await fetchGitBranches(projectPath);
      if (fresh.ok) {
        mergeBranchesResponse(fresh, true);
      }
    } catch (e) {
      appendTerminal(`[taskforge] ❌ ${e.message}\n`);
      showToast(e.message);
    } finally {
      setCreateBranchBusy(false);
    }
  }, [
    appendTerminal,
    createBranchDraft,
    gitBranchState.ok,
    mergeBranchesResponse,
    selectedExecBranch,
    showToast,
    state.projectPath,
  ]);

  const handleRefreshExecBranches = useCallback(async () => {
    const projectPath = state.projectPath?.trim();
    if (!projectPath || isExecuting) return;
    setGitBranchState({ ok: false, loading: true, error: '' });
    try {
      const data = await fetchGitBranches(projectPath);
      if (!data.ok) {
        setExecBranchList([]);
        setSelectedExecBranch('');
        setExecBranchCurrent('');
        setGitBranchState({
          ok: false,
          loading: false,
          error: data.error || '读取分支失败',
        });
        showToast(data.error || '读取分支失败');
        return;
      }
      mergeBranchesResponse(data, false);
      setGitBranchState({ ok: true, loading: false, error: '' });
      showToast('✅ 分支列表已刷新');
    } catch (e) {
      setGitBranchState({
        ok: false,
        loading: false,
        error: e.message || '网络错误',
      });
      showToast(e.message);
    }
  }, [isExecuting, mergeBranchesResponse, showToast, state.projectPath]);

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

  const handleRefreshCursorModels = useCallback(async () => {
    if (selectedEngine !== 'cursor') return;
    setCursorModelsLoading(true);
    setCursorModelsError('');
    try {
      const data = await fetchCursorModels();
      const models = Array.isArray(data.models) ? data.models : [];
      setCursorModels(models);
      const nextId = (() => {
        const prev = selectedCursorModel;
        if (prev && models.some((item) => item.id === prev)) return prev;
        return models[0]?.id || '';
      })();
      setSelectedCursorModel(nextId);
      dispatch({ type: 'SET_CURSOR_MODEL', model: nextId });
      showToast(models.length ? '✅ Cursor 模型列表已刷新' : '⚠️ 当前未读取到可用模型');
    } catch (error) {
      setCursorModels([]);
      setCursorModelsError(error.message || '读取 Cursor 模型失败');
      setSelectedCursorModel('');
      dispatch({ type: 'SET_CURSOR_MODEL', model: '' });
      showToast(error.message || '❌ 读取 Cursor 模型失败');
    } finally {
      setCursorModelsLoading(false);
    }
  }, [dispatch, selectedCursorModel, selectedEngine, showToast]);

  const runSingleSkillPackageInstall = useCallback((projectPath, pkg) => (
    new Promise((resolve, reject) => {
      installSkillPackages(projectPath, [pkg], {
        onStatus: (msg) => setTerminalStatus(msg),
        onChunk: (text) => appendTerminal(text),
        onDone: () => resolve({ ok: true }),
        onAborted: () => resolve({ ok: false, aborted: true }),
        onError: (msg, stderr) => {
          reject(new Error(stderr ? `${msg}\n${stderr}` : msg));
        },
      });
    })
  ), [appendTerminal]);

  const handleInstallAllSkills = useCallback(async () => {
    const { orderedPackages, pkgToRowIds } = installableSkillPackagesPlan;
    if (!state.projectPath) {
      showToast('⚠️ 请先在第一步配置项目路径');
      return;
    }
    if (orderedPackages.length === 0) {
      showToast('⚠️ 当前推荐中没有可安装的 npm Skill 包');
      return;
    }

    const projectRootDisplay = state.projectPath.trim().replace(/\/+$/, '') || state.projectPath;

    setIsBulkInstallingSkills(true);
    setTerminalVisible(true);
    setTerminalOutput((prev) => {
      const head = `[taskforge] ===== 一键安装全部 Skill（${orderedPackages.length} 个包）=====\n`
        + `[taskforge] 项目根目录 = 第一步「项目路径」: ${projectRootDisplay}\n`
        + `[taskforge] 写入目录: ${projectRootDisplay}/.cursor/skills/<包名>/\n`;
      return prev.trim() ? `${prev}\n\n${head}` : head;
    });
    setTerminalStatus('准备安装 Skills...');

    try {
      for (const pkg of orderedPackages) {
        const rowIds = pkgToRowIds.get(pkg) || [];
        setSkillRowInstallLoading((prev) => {
          const next = { ...prev };
          rowIds.forEach((id) => { next[id] = true; });
          return next;
        });

        appendTerminal(`\n[taskforge] ----------\n[taskforge] 正在安装: ${pkg}（完成后写入 ${projectRootDisplay}/.cursor/skills/）\n`);

        await runSingleSkillPackageInstall(state.projectPath, pkg);

        setSkillRowInstallLoading((prev) => {
          const next = { ...prev };
          rowIds.forEach((id) => { delete next[id]; });
          return next;
        });
      }

      appendTerminal('\n[taskforge] ===== 全部 Skill 安装流程结束 =====\n');
      setTerminalStatus('Skill 安装完成');
      showToast('✅ 全部 Skill 已安装');
    } catch (error) {
      appendTerminal(`\n[taskforge] 安装中断: ${error.message}\n`);
      setTerminalStatus('Skill 安装失败');
      showToast(error.message || '❌ Skill 安装失败');
    } finally {
      setSkillRowInstallLoading({});
      setIsBulkInstallingSkills(false);
    }
  }, [
    appendTerminal,
    installableSkillPackagesPlan,
    runSingleSkillPackageInstall,
    showToast,
    state.projectPath,
  ]);

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

  const updateTestRuntime = useCallback((testId, updater) => {
    setTestRuntimeMap((prev) => {
      const current = prev[testId] || createTestRuntime();
      const nextValue = typeof updater === 'function'
        ? updater(current)
        : { ...current, ...updater };
      return {
        ...prev,
        [testId]: nextValue,
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
    if (selectedEngine === 'cursor' && !selectedCursorModel) {
      showToast(cursorModelsError ? '⚠️ 请先处理 Cursor 模型列表加载失败' : '⚠️ 请选择 Cursor 模型');
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
  }, [
    cursorModelsError,
    orchestrationSteps.length,
    promptResources,
    selectedCursorModel,
    selectedEngine,
    showToast,
    state.projectPath,
  ]);

  const prepareExecutionResources = useCallback(async () => {
    const saved = await savePromptResources(state.projectPath, promptResources);
    appendTerminal(`[taskforge] Prompt 资源已写入: ${saved.outputDir}\n`);
    saved.files.forEach((file) => {
      appendTerminal(`[taskforge] - ${file.filename}\n`);
    });

    if (stopRequestedRef.current) {
      return { aborted: true };
    }

    if (skillsForPrompt.length > 0) {
      appendTerminal('[taskforge] 已纳入本轮 Prompt 的 Skills（npm 不在此步骤安装，请按需使用「一键安装全部 Skill」）:\n');
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
          model: selectedEngine === 'cursor' ? selectedCursorModel : '',
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
  ), [appendTerminal, selectedCursorModel, selectedEngine, state.extraNotes, state.projectPath]);

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
    setTerminalStatus('检查 Git 执行分支...');

    try {
      const branchOk = await syncExecutionBranch();
      if (!branchOk.ok) {
        setIsExecuting(false);
        setTerminalStatus('分支检查失败');
        return;
      }
      setTerminalStatus(`准备使用 ${getEngineLabel(selectedEngine)} 执行...`);

      const prepareResult = await prepareExecutionResources();
      if (prepareResult.aborted) {
        setIsExecuting(false);
        setTerminalStatus('执行已停止');
        return;
      }
      appendTerminal(`\n[taskforge] 即将启动 ${getEngineLabel(selectedEngine)}${selectedEngine === 'cursor' && selectedCursorModel ? `（模型: ${selectedCursorModel}）` : ''}...\n\n`);
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
      const tests = Array.isArray(result?.tests) ? result.tests : [];
      if (!tasks.length && !tests.length) {
        throw new Error('Agent 已返回结果，但没有生成任务列表或测试清单');
      }
      setNormalizedSteps(tasks);
      setNormalizedTests(tests);
      setTerminalOutput((prev) => `${prev}[taskforge] Agent 已生成 ${tasks.length} 个任务、${tests.length} 个测试项，右侧列表已更新。\n`);
      setTerminalStatus(`已生成 ${tasks.length} 个任务 / ${tests.length} 个测试项`);
      showToast(`✅ 已生成 ${tasks.length} 个任务、${tests.length} 个测试项`);
      return { tasks, tests };
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
    let steps = [];
    let tests = [];
    try {
      const generated = await normalizeStepsWithAgent();
      steps = Array.isArray(generated?.tasks) ? generated.tasks : [];
      tests = Array.isArray(generated?.tests) ? generated.tests : [];
    } catch (error) {
      showToast(error.message || '❌ 规范化步骤失败');
      setTerminalStatus('步骤规范化失败');
      setTerminalOutput((prev) => `${prev}[taskforge] ${error.message}\n`);
      return;
    }
    if (steps.length === 0 && tests.length === 0) {
      showToast('⚠️ 当前没有可展示的任务列表或测试清单');
      return;
    }
    setExecutionMode('stepwise');
    setTerminalVisible(true);
    setTerminalOutput((prev) => prev || '[taskforge] 分步模式已就绪，请在右侧任务列表或测试清单中选择要执行的内容。\n');
    setTerminalStatus('请选择要执行的任务或测试');
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
    setTerminalStatus('检查 Git 执行分支...');

    try {
      const branchOk = await syncExecutionBranch();
      if (!branchOk.ok) {
        setIsExecuting(false);
        setTerminalStatus('分支检查失败');
        return;
      }

      setTerminalStatus(`准备分步执行 ${selectedSteps.length} 个步骤...`);
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
            lastOutput: runResult.output || current.lastOutput || '',
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
          lastOutput: runResult.output || current.lastOutput || '',
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
          lastOutput: '',
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
    syncExecutionBranch,
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

  const handleExecuteTest = useCallback(async (test) => {
    if (!test?.aiExecutable) return;
    if (!validateExecutionPrerequisites()) return;

    stopRequestedRef.current = false;
    currentStepIdRef.current = '';
    setExecutionMode('stepwise');
    setTerminalVisible(true);
    setIsExecuting(true);
    setTerminalOutput('');
    setTerminalStatus('检查 Git 执行分支...');

    updateTestRuntime(test.id, (current) => ({
      ...current,
      status: 'running',
      runCount: (current.runCount || 0) + 1,
      lastRunAt: new Date().toISOString(),
      lastError: '',
    }));

    try {
      const branchOk = await syncExecutionBranch();
      if (!branchOk.ok) {
        updateTestRuntime(test.id, (current) => ({
          ...current,
          status: 'failed',
          lastError: '分支检查失败',
        }));
        setIsExecuting(false);
        setTerminalStatus('分支检查失败');
        return;
      }

      const prepareResult = await prepareExecutionResources();
      if (prepareResult.aborted) {
        updateTestRuntime(test.id, (current) => ({
          ...current,
          status: 'interrupted',
        }));
        setIsExecuting(false);
        setTerminalStatus('执行已停止');
        return;
      }

      appendTerminal(`\n[taskforge] ===== 开始执行测试: ${test.title} =====\n`);
      const runResult = await runTaskWithCli({
        title: `执行测试: ${test.title}`,
        prompt: buildTestExecutionPrompt(test, orchestrationSteps),
      });

      if (runResult.aborted) {
        updateTestRuntime(test.id, (current) => ({
          ...current,
          status: 'interrupted',
          lastOutput: runResult.output || current.lastOutput || '',
        }));
        setIsExecuting(false);
        setTerminalStatus('执行已停止');
        return;
      }

      updateTestRuntime(test.id, (current) => ({
        ...current,
        status: 'completed',
        lastCompletedAt: new Date().toISOString(),
        lastOutput: runResult.output || current.lastOutput || '',
      }));
      setIsExecuting(false);
      setTerminalStatus('测试执行完成');
      appendTerminal(`[taskforge] 测试完成: ${test.title}\n`);
      showToast(`✅ 测试完成：${test.title}`);
    } catch (error) {
      updateTestRuntime(test.id, (current) => ({
        ...current,
        status: 'failed',
        lastError: error.message || '测试执行失败',
      }));
      setIsExecuting(false);
      setTerminalStatus('测试执行失败');
      appendTerminal(`[taskforge] ${error.message}\n`);
      showToast(error.message || '❌ 测试执行失败');
    } finally {
      abortRef.current = null;
    }
  }, [
    orchestrationSteps,
    prepareExecutionResources,
    runTaskWithCli,
    showToast,
    syncExecutionBranch,
    updateTestRuntime,
    validateExecutionPrerequisites,
  ]);

  /** 仅在实际任务执行（立即/分步 CLI）进行中锁定，与「停止执行」一致 */
  const branchSwitchLocked = isExecuting;
  const gitReadyForRun = Boolean(state.projectPath?.trim()) && gitBranchState.ok && !gitBranchState.loading;
  const cursorReadyForRun = selectedEngine !== 'cursor'
    || (Boolean(selectedCursorModel) && !cursorModelsLoading && !cursorModelsError);
  const skillsBusy = skillsCatalogLoading || skillsAnalyzing;
  const canExecute = Boolean(selectedEngine) && cursorReadyForRun && !isExecuting && gitReadyForRun && !skillsBusy;
  const canOpenStepwise = !skillsBusy && !isExecuting && !isNormalizingSteps;
  const hasGeneratedStepwiseArtifacts = orchestrationSteps.length > 0 || executableTests.length > 0;
  const canAnalyzeSkills = Boolean(selectedEngine) && Boolean(state.projectPath?.trim()) && !skillsBusy && !isExecuting && !isNormalizingSteps;
  const canInstallAllSkills = Boolean(state.projectPath)
    && installableSkillPackagesPlan.orderedPackages.length > 0
    && !skillsBusy
    && !isBulkInstallingSkills
    && !isExecuting
    && !isNormalizingSteps;

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
            <span>🧩 Skills 清单与推荐 {skillsBusy ? '· 处理中...' : recommendedSkills.length ? `· 已推荐 ${recommendedSkills.length} 个` : ''}</span>
          </div>
          <div className="ai-log-body" style={{ whiteSpace: 'normal' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleSyncSkillsCatalog}
                disabled={skillsBusy || isExecuting || isNormalizingSteps}
                style={{ opacity: skillsBusy || isExecuting || isNormalizingSteps ? 0.55 : 1 }}
              >
                {skillsCatalogLoading ? '⏳ 获取中…' : '⬇️ 获取 / 更新 Skills 列表'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAnalyzeSkills}
                disabled={!canAnalyzeSkills}
                style={{ opacity: canAnalyzeSkills ? 1 : 0.55 }}
              >
                {skillsAnalyzing ? '🤖 分析中…' : '🤖 分析推荐 Skills'}
              </button>
            </div>

            <div style={{ fontSize: '0.92em', opacity: 0.82, marginBottom: 12 }}>
              <div>第 1 步：点击“获取 / 更新 Skills 列表”，服务端会请求 Skills 接口，并把 `name`、`description`、`installMethod` 等信息写入本地缓存文件。</div>
              <div>第 2 步：点击“分析推荐 Skills”，系统会调用 Agent 分析项目代码和前三步产物，再只推荐真正需要的 Skills。</div>
            </div>

            {skillsCatalogMeta.loaded ? (
              <div
                style={{
                  marginBottom: 12,
                  padding: '10px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--panel-muted, rgba(0, 0, 0, 0.04))',
                }}
              >
                <div><strong>本地 Skills 缓存：</strong>{skillsCatalogMeta.total} 个</div>
                {skillsCatalogMeta.updatedAt ? <div>更新时间：{formatTimeLabel(skillsCatalogMeta.updatedAt) || skillsCatalogMeta.updatedAt}</div> : null}
                {skillsCatalogMeta.filePath ? <div style={{ wordBreak: 'break-all' }}>缓存文件：<code>{skillsCatalogMeta.filePath}</code></div> : null}
                <div>{skillsCatalogMeta.skipped ? '本次检测到首条记录未变化，已沿用本地缓存。' : '本次已刷新本地 Skills 缓存。'}</div>
              </div>
            ) : (
              <div style={{ marginBottom: 12, opacity: 0.78 }}>
                当前还没有读取 Skills 本地缓存。执行不会自动联网查找 Skills。
              </div>
            )}

            {skillsAnalysisSummary ? (
              <div style={{ marginBottom: 12 }}>
                <strong>分析摘要：</strong>{skillsAnalysisSummary}
              </div>
            ) : null}

            {recommendedSkills.length > 0 ? recommendedSkills.map((skill, index) => {
              const rowId = skillRowId(skill, index);
              const rowLoading = Boolean(skillRowInstallLoading[rowId]);
              return (
                <label
                  key={rowId}
                  style={{
                    display: 'flex',
                    gap: 10,
                    marginBottom: 12,
                    alignItems: 'flex-start',
                    cursor: rowLoading ? 'wait' : 'pointer',
                    opacity: rowLoading ? 0.88 : 1,
                  }}
                >
                  {rowLoading ? (
                    <span className="ai-spinner" style={{ marginTop: 4, flexShrink: 0 }} aria-hidden />
                  ) : null}
                  <input
                    type="checkbox"
                    checked={skillInstallSelected[rowId] !== false}
                    disabled={rowLoading}
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
                    {rowLoading ? (
                      <span style={{ marginLeft: 8, fontSize: '0.85em', opacity: 0.9 }}>安装中…</span>
                    ) : null}
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
                    <div style={{ marginTop: 4, fontSize: '0.9em', opacity: 0.82 }}>
                      安装方式：<code>{formatSkillInstallMethod(skill)}</code>
                    </div>
                    {skill.recommendationReason ? (
                      <div style={{ marginTop: 4, fontSize: '0.9em' }}>
                        推荐原因：{skill.recommendationReason}
                      </div>
                    ) : null}
                    {Array.isArray(skill.matchedProjectEvidence) && skill.matchedProjectEvidence.length ? (
                      <div style={{ marginTop: 4, fontSize: '0.88em', opacity: 0.8 }}>
                        项目依据：{skill.matchedProjectEvidence.join('；')}
                      </div>
                    ) : null}
                  </span>
                </label>
              );
            }) : skillsAnalysisDone ? 'Agent 已分析完成，当前任务无需额外 Skill，将按默认 Prompt 执行。' : '当前尚未生成推荐 Skill，请先手动获取 Skills 列表，再点击“分析推荐 Skills”。'}
          </div>
          {recommendedSkills.length > 0 && (
            <div
              style={{
                padding: '12px 0 4px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleInstallAllSkills}
                disabled={!canInstallAllSkills}
                style={{ opacity: canInstallAllSkills ? 1 : 0.55 }}
              >
                {isBulkInstallingSkills ? '⏳ 正在安装…' : '📦 一键安装全部 Skill'}
              </button>
              {installableSkillPackagesPlan.orderedPackages.length === 0 && !skillsBusy ? (
                <span style={{ fontSize: '0.9em', opacity: 0.75 }}>
                  当前列表无 npm 包名，无需安装
                </span>
              ) : installableSkillPackagesPlan.orderedPackages.length > 0 ? (
                <span style={{ fontSize: '0.9em', opacity: 0.75 }}>
                  安装到第一步「项目路径」下的
                  <code style={{ fontSize: '0.92em' }}>.cursor/skills/</code>
                  {state.projectPath.trim() ? (
                    <>（当前为 <code style={{ fontSize: '0.88em', wordBreak: 'break-all' }}>{state.projectPath.trim().replace(/\/+$/, '')}/.cursor/skills/</code>）</>
                  ) : null}
                </span>
              ) : null}
            </div>
          )}
        </div>

        <textarea
          className="form-textarea split-editor-textarea mono-input"
          value={promptText}
          readOnly
          style={{ minHeight: 320, marginBottom: 20 }}
        />

        <div
          style={{
            display: 'flex',
            gap: 12,
            marginBottom: 16,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            <span style={{ fontSize: '0.9em', opacity: 0.85 }}>执行引擎</span>
            <select
              className="form-select"
              value={selectedEngine}
              onChange={(e) => setSelectedEngine(e.target.value)}
            >
              <option value="">请选择执行引擎</option>
              {ENGINE_OPTIONS.map((engine) => (
                <option key={engine.key} value={engine.key}>
                  {engine.label}
                </option>
              ))}
            </select>
          </label>

          {selectedEngine === 'cursor' && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260, flex: '1 1 320px' }}>
                <span style={{ fontSize: '0.9em', opacity: 0.85 }}>Cursor 模型</span>
                <select
                  className="form-select"
                  value={selectedCursorModel}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSelectedCursorModel(v);
                    dispatch({ type: 'SET_CURSOR_MODEL', model: v });
                  }}
                  disabled={cursorModelsLoading || cursorModels.length === 0}
                >
                  <option value="">
                    {cursorModelsLoading ? '正在读取模型列表…' : (cursorModels.length ? '请选择模型' : '暂无可用模型')}
                  </option>
                  {cursorModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label || model.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleRefreshCursorModels}
                disabled={cursorModelsLoading}
              >
                {cursorModelsLoading ? '刷新中…' : '🔄 刷新模型'}
              </button>
            </>
          )}
        </div>

        {selectedEngine === 'cursor' && (
          <div className="form-hint" style={{ marginBottom: 16, color: cursorModelsError ? 'var(--danger, #c62828)' : undefined }}>
            {cursorModelsError
              ? cursorModelsError
              : cursorModelsLoading
                ? '正在通过 Cursor CLI 读取当前账号可用模型列表…'
                : selectedCursorModel
                  ? `当前执行模型：${selectedCursorModel}`
                  : '请选择一个 Cursor 模型后再执行。'}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary btn-lg"
            onClick={handleExecute}
            disabled={!canExecute}
            style={{ opacity: canExecute ? 1 : 0.55 }}
          >
            ▶ 立即执行
          </button>
          <button
            className="btn btn-secondary btn-lg"
            onClick={openStepwisePanel}
            disabled={!canOpenStepwise || isExecuting}
            style={{ opacity: canOpenStepwise && !isExecuting ? 1 : 0.55 }}
          >
            {hasGeneratedStepwiseArtifacts ? '↻ 重新生成分步' : '≡ 生成分步'}
          </button>
          {isExecuting && (
            <button className="btn btn-danger" onClick={handleStopExecute}>
              ⏹️ 停止执行
            </button>
          )}
        </div>

        <div
          style={{
            marginBottom: 20,
            padding: '14px 16px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--panel-muted, rgba(0, 0, 0, 0.04))',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 10 }}>执行分支</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220, flex: '1 1 240px' }}>
              <span style={{ fontSize: '0.88em', opacity: 0.85 }}>目标分支（git branch -a）</span>
              <select
                className="form-select"
                value={selectedExecBranch}
                disabled={!state.projectPath?.trim() || gitBranchState.loading || branchSwitchLocked}
                onChange={(e) => setSelectedExecBranch(e.target.value)}
              >
                {execBranchList.length === 0 && !gitBranchState.loading ? (
                  <option value="">（无分支）</option>
                ) : null}
                {execBranchList.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}{b.name === execBranchCurrent ? ' · 当前' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleRefreshExecBranches}
              disabled={!state.projectPath?.trim() || gitBranchState.loading || branchSwitchLocked}
            >
              {gitBranchState.loading ? '刷新中…' : '🔄 刷新分支'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={openCreateBranchModal}
              disabled={!state.projectPath?.trim() || gitBranchState.loading || branchSwitchLocked || !gitBranchState.ok}
            >
              ➕ 新建本地分支
            </button>
          </div>
          {!state.projectPath?.trim() ? (
            <div className="form-hint" style={{ marginTop: 10 }}>请先在第一步填写项目路径以读取 Git 分支。</div>
          ) : gitBranchState.loading ? (
            <div className="form-hint" style={{ marginTop: 10 }}>正在读取分支列表…</div>
          ) : !gitBranchState.ok ? (
            <div className="form-hint" style={{ marginTop: 10, color: 'var(--danger, #c62828)' }}>
              {gitBranchState.error || '无法读取 Git 分支，「立即执行 / 分步执行」已禁用。'}
            </div>
          ) : (
            <div className="form-hint" style={{ marginTop: 10 }}>
              「新建本地分支」会先按当前「目标分支」执行 checkout，再 <code className="mono-input" style={{ fontSize: '0.9em' }}>git checkout -b</code>
              ；创建后需在「目标分支」中自行切换再执行。任务执行进行中不可改分支。
            </div>
          )}
        </div>

        {createBranchModalOpen ? (
          <div
            className="modal-overlay visible"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-branch-modal-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeCreateBranchModal();
            }}
          >
            <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-title" id="create-branch-modal-title">
                  新建本地分支
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  disabled={createBranchBusy}
                  onClick={closeCreateBranchModal}
                  aria-label="关闭"
                >
                  ✕
                </button>
              </div>
              <div className="modal-body">
                <p className="form-hint" style={{ marginTop: 0, marginBottom: 12 }}>
                  将以当前下拉里选中的「目标分支」为起点：先 <strong>git checkout</strong> 到该分支，再执行{' '}
                  <strong>git checkout -b</strong>。创建成功后仍须在下拉里手动切到新分支再执行。
                </p>
                <div className="form-group">
                  <label className="form-label">新分支名称</label>
                  <input
                    type="text"
                    className="form-input mono-input"
                    placeholder="例如 feature/my-task"
                    value={createBranchDraft}
                    disabled={createBranchBusy}
                    autoComplete="off"
                    onChange={(e) => setCreateBranchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !createBranchBusy) {
                        e.preventDefault();
                        confirmCreateBranch();
                      }
                    }}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={createBranchBusy} onClick={closeCreateBranchModal}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={createBranchBusy} onClick={confirmCreateBranch}>
                  {createBranchBusy ? '创建中…' : '确定'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

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
                  {getEngineLabel(selectedEngine)}
                  {selectedEngine === 'cursor' && selectedCursorModel ? ` · ${selectedCursorModel}` : ''}
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
                {(isExecuting || isBulkInstallingSkills) && <span className="terminal-cursor">▋</span>}
              </pre>
            </div>

            {executionMode === 'stepwise' && (
              <div className="stepwise-sidebar">
                <div className="stepwise-sidebar-header">
                  <div>
                    <div className="stepwise-sidebar-title">步骤详情</div>
                    <div className="stepwise-sidebar-subtitle">
                      共 {orchestrationSteps.length} 个任务，测试 {executableTests.length} 项，已选 {selectedStepIds.length} 项任务
                    </div>
                  </div>
                  <div className="stepwise-toolbar">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => executeSelectedSteps(selectedStepIds)}
                      disabled={selectedStepIds.length === 0 || isExecuting || !gitReadyForRun}
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
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={!gitReadyForRun}
                                onClick={() => handleReexecuteStep(step.id)}
                              >
                                重新执行
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!gitReadyForRun}
                              onClick={() => executeSelectedSteps([step.id])}
                            >
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

                <div className="stepwise-test-section">
                  <div className="stepwise-sidebar-header" style={{ paddingTop: 18, borderTop: '1px solid var(--border)' }}>
                    <div>
                      <div className="stepwise-sidebar-title">测试清单</div>
                      <div className="stepwise-sidebar-subtitle">
                        共 {executableTests.length} 项，包含单测 / 集测 / 端到端 / 人工验证
                      </div>
                    </div>
                  </div>

                  <div className="stepwise-list">
                    {executableTests.length === 0 ? (
                      <div className="orchestration-step-card status-never">
                        <div className="orchestration-step-desc">当前还没有生成测试清单，请先点击“生成分步”。</div>
                      </div>
                    ) : executableTests.map((test, index) => {
                      const runtime = testRuntimeMap[test.id] || createTestRuntime();
                      const isRunning = runtime.status === 'running';
                      return (
                        <div
                          key={test.id}
                          className={`orchestration-step-card status-${runtime.status}${isRunning ? ' active' : ''}`}
                        >
                          <div className="orchestration-step-header">
                            <div className="orchestration-step-index">T{index + 1}</div>
                            <div className="orchestration-step-main">
                              <div className="orchestration-step-title-row">
                                <div className="orchestration-step-title">{test.title}</div>
                                <span className={`orchestration-step-badge badge-${runtime.status}`}>
                                  {getRuntimeLabel(runtime.status)}
                                </span>
                              </div>
                              <div className="orchestration-step-desc">
                                {test.objective || test.executionHint || '请根据测试目标与命令完成验证。'}
                              </div>
                              <div className="orchestration-step-meta">
                                <span>{getTestCategoryLabel(test.category)}</span>
                                <span>{test.aiExecutable ? 'AI 可执行' : '需开发者自测'}</span>
                                <span>命令 {test.commands?.length || 0}</span>
                                {runtime.lastCompletedAt && (
                                  <span>完成于 {formatTimeLabel(runtime.lastCompletedAt)}</span>
                                )}
                              </div>
                              {!test.aiExecutable && (
                                <div className="stepwise-test-note">
                                  {test.manualNotes || '该项更适合由开发者手动验证，请按说明自测。'}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="orchestration-step-actions">
                            {test.aiExecutable ? (
                              isRunning ? (
                                <button className="btn btn-danger btn-sm" onClick={handleStopExecute}>
                                  停止
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={!gitReadyForRun || isExecuting}
                                  onClick={() => handleExecuteTest(test)}
                                >
                                  执行测试
                                </button>
                              )
                            ) : (
                              <span className="form-hint">需开发者自测</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
