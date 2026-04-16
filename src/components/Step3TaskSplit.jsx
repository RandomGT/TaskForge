import React, { useRef, useCallback, useState, useLayoutEffect, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { getNextTaskId } from '../utils/taskSplitter';
import { aiOrchestrateStage, fetchCursorModels } from '../utils/aiService';
import { persistJobState } from '../utils/jobApi';
import { assignFigmaIdsToTasks } from '../utils/figmaPages';
import { buildPromptPackagesForTasks } from '../domains/prompts/promptPackage';
import {
  parseExecutionPlanDraft,
  parseIntentDraft,
  parseTaskOrchestrationDraft,
} from '../domains/pipeline/draftParsers';

const STAGE_CONFIGS = [
  {
    key: 'intents',
    stage: 'intent',
    field: 'intentDecomposition',
    title: '意图拆解',
    icon: '🧠',
    description: '先梳理目标、约束和关键用户故事。重新生成后，会同步清空后续的执行计划与任务编排。',
    statusText: '正在执行意图拆解...',
    placeholder: '点击“开始生成”后，这里会生成意图拆解结果。',
  },
  {
    key: 'plan',
    stage: 'plan',
    field: 'executionPlan',
    title: '执行计划',
    icon: '🗺️',
    description: '基于意图拆解输出实现路径、资源配置和关键风险。重新生成后，会同步清空任务编排。',
    statusText: '正在执行执行计划...',
    placeholder: '完成意图拆解后，这里会生成执行计划结果。',
    dependsOn: 'intentDecomposition',
  },
  {
    key: 'tasks',
    stage: 'tasks',
    field: 'taskOrchestration',
    title: '任务编排',
    icon: '📋',
    description: '基于执行计划拆出可执行任务与依赖关系，供下一步直接执行。',
    statusText: '正在执行任务编排...',
    placeholder: '完成执行计划后，这里会生成任务编排结果。',
    dependsOn: 'executionPlan',
  },
];

const EMPTY_DRAFTS = {
  intentDecomposition: '',
  executionPlan: '',
  taskOrchestration: '',
};

const ENGINE_OPTIONS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'cursor', label: 'Cursor CLI' },
];

export default function Step3TaskSplit() {
  const { state, dispatch, showToast } = useAppContext();
  const [cursorModels, setCursorModels] = useState([]);
  const [cursorModelsLoading, setCursorModelsLoading] = useState(false);
  const [cursorModelsError, setCursorModelsError] = useState('');
  const abortRef = useRef(null);
  const runningStageRef = useRef('');
  const [showLog, setShowLog] = useState(false);
  const [activeView, setActiveView] = useState('intents');
  const [runningStageKey, setRunningStageKey] = useState('');
  const aiLogBodyRef = useRef(null);
  const aiLogStickBottomRef = useRef(true);
  const cursorModelRef = useRef(state.cursorModel);
  cursorModelRef.current = state.cursorModel;

  useLayoutEffect(() => {
    const el = aiLogBodyRef.current;
    if (!el || !showLog) return;
    if (aiLogStickBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.aiLog, showLog]);

  useEffect(() => {
    if (state.aiEngine !== 'cursor') {
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
        const prev = cursorModelRef.current || '';
        const nextId = prev && models.some((item) => item.id === prev)
          ? prev
          : (models[0]?.id || '');
        if (nextId !== prev) {
          dispatch({ type: 'SET_CURSOR_MODEL', model: nextId });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setCursorModels([]);
        setCursorModelsError(error.message || '读取 Cursor 模型失败');
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
  }, [state.aiEngine, dispatch]);

  const handleRefreshCursorModels = useCallback(async () => {
    if (state.aiEngine !== 'cursor') return;
    setCursorModelsLoading(true);
    setCursorModelsError('');
    try {
      const data = await fetchCursorModels();
      const models = Array.isArray(data.models) ? data.models : [];
      setCursorModels(models);
      const prev = cursorModelRef.current || '';
      const nextId = prev && models.some((item) => item.id === prev)
        ? prev
        : (models[0]?.id || '');
      dispatch({ type: 'SET_CURSOR_MODEL', model: nextId });
      showToast(models.length ? '✅ Cursor 模型列表已刷新' : '⚠️ 当前未读取到可用模型');
    } catch (error) {
      setCursorModels([]);
      setCursorModelsError(error.message || '读取 Cursor 模型失败');
      dispatch({ type: 'SET_CURSOR_MODEL', model: '' });
      showToast(error.message || '❌ 读取 Cursor 模型失败');
    } finally {
      setCursorModelsLoading(false);
    }
  }, [dispatch, showToast, state.aiEngine]);

  const cursorSplitReady = state.aiEngine !== 'cursor'
    || (Boolean(state.cursorModel) && !cursorModelsLoading && !cursorModelsError);

  const handleAiLogScroll = useCallback(() => {
    const el = aiLogBodyRef.current;
    if (!el) return;
    const threshold = 80;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    aiLogStickBottomRef.current = fromBottom <= threshold;
  }, []);

  const appendAiLog = useCallback((text) => {
    dispatch({ type: 'AI_CHUNK', text });
  }, [dispatch]);

  const syncDraftsToModels = useCallback((drafts) => {
    const intentGraph = parseIntentDraft(drafts.intentDecomposition);
    const executionPlan = parseExecutionPlanDraft(drafts.executionPlan);
    const taskGraph = parseTaskOrchestrationDraft(drafts.taskOrchestration);
    const tasksWithIds = (taskGraph.tasks || []).map((task) => ({
      ...task,
      id: typeof task.id === 'number' ? task.id : getNextTaskId(),
      status: task.status || 'pending',
      executionOutput: task.executionOutput || '',
    }));
    const tasksWithFigma = assignFigmaIdsToTasks(tasksWithIds, state.figmaPages);
    const promptPackages = buildPromptPackagesForTasks(tasksWithFigma, { ...state, tasks: tasksWithFigma });

    dispatch({ type: 'SET_TASKS', tasks: tasksWithFigma });
    dispatch({
      type: 'SET_PIPELINE_DATA',
      intentGraph,
      executionPlan,
      taskGraph: { tasks: tasksWithFigma },
      promptPackages,
      splitDrafts: drafts,
      splitStarted: true,
    });
    return {
      intentGraph,
      executionPlan,
      taskGraph: { tasks: tasksWithFigma },
      tasks: tasksWithFigma,
      promptPackages,
      splitDrafts: drafts,
      splitStarted: true,
    };
  }, [dispatch, state]);

  const saveStageSnapshot = useCallback(async (overrides = {}) => {
    if (!state.currentJobId) return;
    await persistJobState(state.currentJobId, state, overrides);
  }, [state, state.currentJobId]);

  const buildStepPayloads = useCallback(() => {
    const step1Json = {
      aiEngine: state.aiEngine,
      projectPath: state.projectPath,
      projectName: state.projectName,
      requirementDesc: state.requirementDesc,
      techStack: state.techStack,
      extraNotes: state.extraNotes,
      projectFiles: state.projectFiles,
    };
    const step2Json = {
      figmaPages: state.figmaPages,
      apiResources: state.apiResources,
      imageResources: state.imageResources,
      otherResources: state.otherResources,
    };
    return { step1Json, step2Json };
  }, [state]);

  const buildResetDraftsForStage = useCallback((field) => {
    if (field === 'intentDecomposition') {
      return { ...EMPTY_DRAFTS };
    }
    if (field === 'executionPlan') {
      return {
        intentDecomposition: state.splitDrafts.intentDecomposition || '',
        executionPlan: '',
        taskOrchestration: '',
      };
    }
    return {
      intentDecomposition: state.splitDrafts.intentDecomposition || '',
      executionPlan: state.splitDrafts.executionPlan || '',
      taskOrchestration: '',
    };
  }, [state.splitDrafts]);

  const runStage = useCallback((stage, step1Json, step2Json, previousOutputs) => {
    return new Promise((resolve, reject) => {
      let settled = false;

      if (abortRef.current) {
        abortRef.current();
      }

      appendAiLog(`\n========== 阶段 ${stage.toUpperCase()} 开始 ==========\n`);

      abortRef.current = aiOrchestrateStage(
        {
          engine: state.aiEngine,
          model: state.aiEngine === 'cursor' ? state.cursorModel : '',
          projectPath: state.projectPath,
          stage,
          step1: step1Json,
          step2: step2Json,
          previousOutputs,
          projectFiles: state.projectFiles,
        },
        {
          onStatus: (msg) => {
            dispatch({ type: 'AI_STATUS', status: msg });
            appendAiLog(`[status] ${msg}\n`);
          },
          onChunk: (text) => appendAiLog(text),
          onResult: (data) => {
            if (settled) return;
            settled = true;
            appendAiLog(`\n========== 阶段 ${stage.toUpperCase()} 完成 ==========\n`);
            resolve({ aborted: false, output: data.output || '' });
          },
          onRaw: (text) => {
            if (settled) return;
            settled = true;
            resolve({ aborted: false, output: text || '' });
          },
          onError: (msg, stderr) => {
            if (settled) return;
            settled = true;
            reject(new Error(msg + (stderr ? `\n${stderr}` : '')));
          },
          onDone: () => {
            if (settled) return;
            settled = true;
            resolve({ aborted: true, output: '' });
          },
        }
      );
    });
  }, [appendAiLog, dispatch, state.aiEngine, state.cursorModel, state.projectFiles, state.projectPath]);

  const resetRunningState = useCallback(() => {
    abortRef.current = null;
    runningStageRef.current = '';
    setRunningStageKey('');
    dispatch({ type: 'AI_DONE' });
  }, [dispatch]);

  const handleStopAI = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    const currentStage = runningStageRef.current;
    runningStageRef.current = '';
    setRunningStageKey('');
    dispatch({ type: 'AI_DONE' });
    showToast(currentStage ? `⏹️ 已停止${currentStage}` : '⏹️ 已停止拆分');
  }, [dispatch, showToast]);

  const handleDraftChange = (field, value) => {
    const nextDrafts = {
      ...state.splitDrafts,
      [field]: value,
    };
    dispatch({ type: 'UPDATE_SPLIT_DRAFT', field, value });
    const snapshot = syncDraftsToModels(nextDrafts);
    saveStageSnapshot(snapshot).catch(() => {
      showToast('⚠️ 拆分内容已更新，但立即保存失败');
    });
  };

  const runSingleStage = useCallback(async (config) => {
    if (!state.requirementDesc.trim()) {
      dispatch({ type: 'SET_STEP', step: 1 });
      return;
    }
    if (!state.projectPath?.trim()) {
      showToast('⚠️ 请先在第一步配置项目路径');
      dispatch({ type: 'SET_STEP', step: 1 });
      return;
    }
    if (!state.aiEngine) {
      showToast('⚠️ 请先选择执行引擎');
      return;
    }
    if (state.aiEngine === 'cursor' && !state.cursorModel) {
      showToast(cursorModelsError ? '⚠️ 请先处理 Cursor 模型列表加载失败' : '⚠️ 请选择 Cursor 模型');
      return;
    }
    if (config.dependsOn && !String(state.splitDrafts[config.dependsOn] || '').trim()) {
      const dependencyLabel = config.dependsOn === 'intentDecomposition' ? '意图拆解' : '执行计划';
      showToast(`⚠️ 请先完成${dependencyLabel}`);
      return;
    }

    const resetDrafts = buildResetDraftsForStage(config.field);
    const resetSnapshot = syncDraftsToModels(resetDrafts);

    dispatch({ type: 'AI_START', status: config.statusText });
    dispatch({ type: 'SET_SPLIT_STARTED', value: true });
    runningStageRef.current = config.title;
    setRunningStageKey(config.key);
    setShowLog(true);
    setActiveView(config.key);

    try {
      await saveStageSnapshot({
        ...resetSnapshot,
        currentStep: 3,
      });
    } catch {
      showToast('⚠️ 已开始新的阶段生成，但初始化保存失败');
    }

    const { step1Json, step2Json } = buildStepPayloads();
    const previousOutputs = {
      intentDecomposition: resetDrafts.intentDecomposition || '',
      executionPlan: resetDrafts.executionPlan || '',
      taskOrchestration: resetDrafts.taskOrchestration || '',
    };

    try {
      const result = await runStage(config.stage, step1Json, step2Json, previousOutputs);
      if (result.aborted) {
        return;
      }

      const nextDrafts = {
        ...resetDrafts,
        [config.field]: result.output,
      };
      const snapshot = syncDraftsToModels(nextDrafts);
      await saveStageSnapshot({
        ...snapshot,
        currentStep: 3,
      });
      showToast(`✅ ${config.title}已完成`);
    } catch (err) {
      dispatch({ type: 'AI_ERROR', message: err.message || String(err) });
      showToast(`❌ ${config.title}失败`);
      return;
    } finally {
      resetRunningState();
    }
  }, [
    buildResetDraftsForStage,
    buildStepPayloads,
    dispatch,
    resetRunningState,
    runStage,
    saveStageSnapshot,
    showToast,
    state.aiEngine,
    state.cursorModel,
    cursorModelsError,
    state.projectPath,
    state.requirementDesc,
    state.splitDrafts,
    syncDraftsToModels,
  ]);

  const activeDraftField = STAGE_CONFIGS.find((item) => item.key === activeView)?.field || 'intentDecomposition';
  const activeDraftTitle = STAGE_CONFIGS.find((item) => item.key === activeView)?.title || '意图拆解';
  const activeDraftValue = state.splitDrafts[activeDraftField] || '';
  const activeDraftPlaceholder = STAGE_CONFIGS.find((item) => item.key === activeView)?.placeholder || '';

  const hasDrafts = Boolean(
    state.splitDrafts.intentDecomposition ||
    state.splitDrafts.executionPlan ||
    state.splitDrafts.taskOrchestration
  );

  const summaryStats = {
    intentCount: state.intentGraph?.intents?.length || 0,
    taskCount: state.tasks.length,
    planSummary: state.executionPlan?.summary || '',
  };

  const jumpToStep = async (step) => {
    dispatch({ type: 'SET_STEP', step });
    if (!state.currentJobId) return;
    try {
      await saveStageSnapshot({ currentStep: step });
    } catch {
      showToast('⚠️ 当前阶段已切换，但立即保存失败');
    }
  };

  return (
    <div className="step-content active fade-in">
      <div className="resource-section-title" style={{ marginBottom: 16 }}>🧩 智能拆分</div>

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
            value={state.aiEngine}
            onChange={(e) => dispatch({ type: 'SET_ENGINE', engine: e.target.value })}
          >
            <option value="">请选择执行引擎</option>
            {ENGINE_OPTIONS.map((engine) => (
              <option key={engine.key} value={engine.key}>
                {engine.label}
              </option>
            ))}
          </select>
        </label>

        {state.aiEngine === 'cursor' && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260, flex: '1 1 320px' }}>
              <span style={{ fontSize: '0.9em', opacity: 0.85 }}>Cursor 模型</span>
              <select
                className="form-select"
                value={state.cursorModel}
                onChange={(e) => dispatch({ type: 'SET_CURSOR_MODEL', model: e.target.value })}
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

      {state.aiEngine === 'cursor' && (
        <div className="form-hint" style={{ marginBottom: 16, color: cursorModelsError ? 'var(--danger, #c62828)' : undefined }}>
          {cursorModelsError
            ? cursorModelsError
            : cursorModelsLoading
              ? '正在通过 Cursor CLI 读取当前账号可用模型列表…'
              : state.cursorModel
                ? `当前拆分使用模型：${state.cursorModel}`
                : '请选择一个 Cursor 模型后再开始生成。'}
        </div>
      )}

      <div className="split-launch-card">
        <div className="split-launch-title">分阶段生成</div>
        <div className="split-launch-desc">
          现在三个阶段可以分别启动和停止。执行计划依赖意图拆解，任务编排依赖执行计划；如果你重新生成上游阶段，系统会自动清空下游结果，保证依赖关系一致。
        </div>

        <div className="split-stage-grid">
          {STAGE_CONFIGS.map((config) => {
            const hasOutput = Boolean(String(state.splitDrafts[config.field] || '').trim());
            const dependencyReady = !config.dependsOn || Boolean(String(state.splitDrafts[config.dependsOn] || '').trim());
            const isRunning = runningStageKey === config.key;
            const isOtherStageRunning = Boolean(runningStageKey && !isRunning);
            const statusClass = isRunning ? 'running' : (hasOutput ? 'completed' : 'never');
            const statusText = isRunning ? '运行中' : (hasOutput ? '已完成' : (dependencyReady ? '未开始' : '等待前置'));

            return (
              <div key={config.key} className={`split-stage-card${isRunning ? ' active' : ''}`}>
                <div className="split-stage-header">
                  <div className="split-stage-title">{config.icon} {config.title}</div>
                  <span className={`orchestration-step-badge badge-${statusClass}`}>{statusText}</span>
                </div>
                <div className="split-stage-desc">{config.description}</div>
                {!dependencyReady && (
                  <div className="split-stage-dependency">
                    依赖未满足：请先完成{config.dependsOn === 'intentDecomposition' ? '意图拆解' : '执行计划'}。
                  </div>
                )}
                <div className="split-stage-actions">
                  {isRunning ? (
                    <button className="btn btn-danger" onClick={handleStopAI}>⏹️ 停止</button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={() => runSingleStage(config)}
                      disabled={!state.aiEngine || !state.projectPath || !cursorSplitReady || !dependencyReady || isOtherStageRunning}
                    >
                      {hasOutput ? '↻ 重新生成' : '▶ 开始生成'}
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    onClick={() => setActiveView(config.key)}
                  >
                    查看内容
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {(state.aiLoading || state.aiLog) && (
        <div className="ai-log-panel">
          <div className="ai-log-header" onClick={() => setShowLog(!showLog)}>
            <span>
              {state.aiLoading && <span className="ai-spinner" />}
              {state.aiStatus || 'AI 输出日志'}
            </span>
            <span className="ai-log-toggle">{showLog ? '▼' : '▶'}</span>
          </div>
          {showLog && (
            <pre
              ref={aiLogBodyRef}
              className="ai-log-body"
              onScroll={handleAiLogScroll}
            >
              {state.aiLog || '等待输出...'}
            </pre>
          )}
        </div>
      )}

      {state.splitStarted && (
        <>
          <div className="template-tabs" style={{ marginBottom: 16 }}>
            <button className={`template-tab${activeView === 'intents' ? ' active' : ''}`} onClick={() => setActiveView('intents')}>
              🧠 意图拆解
            </button>
            <button className={`template-tab${activeView === 'plan' ? ' active' : ''}`} onClick={() => setActiveView('plan')}>
              🗺️ 执行计划
            </button>
            <button className={`template-tab${activeView === 'tasks' ? ' active' : ''}`} onClick={() => setActiveView('tasks')}>
              📋 任务编排
            </button>
          </div>

          {hasDrafts && (
            <div className="ai-log-panel">
              <div className="ai-log-header">
                <span>📌 当前拆分概览</span>
              </div>
              <div className="ai-log-body" style={{ whiteSpace: 'normal' }}>
                <div style={{ marginBottom: 8 }}>
                  <strong>主目标：</strong>{state.intentGraph.rootGoal || '未解析'}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <strong>意图数：</strong> {summaryStats.intentCount} {' · '}
                  <strong>任务数：</strong> {summaryStats.taskCount}
                </div>
                {summaryStats.planSummary && (
                  <div>
                    <strong>执行计划摘要：</strong>{summaryStats.planSummary}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="split-editor-card">
            <div className="resource-section-title" style={{ marginBottom: 12 }}>{activeDraftTitle}</div>
            <textarea
              className="form-textarea split-editor-textarea mono-input"
              value={activeDraftValue}
              onChange={(e) => handleDraftChange(activeDraftField, e.target.value)}
              placeholder={activeDraftPlaceholder}
            />
          </div>
        </>
      )}

      <div className="step-nav">
        <button className="btn btn-secondary" onClick={() => jumpToStep(2)}>← 上一步</button>
        <button className="btn btn-primary" onClick={() => jumpToStep(4)}>下一步: Prompt & 执行 →</button>
      </div>
    </div>
  );
}
