import React, { useRef, useCallback, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { getNextTaskId } from '../utils/taskSplitter';
import { aiOrchestrateStage } from '../utils/aiService';
import { assignFigmaIdsToTasks } from '../utils/figmaPages';
import { buildPromptPackagesForTasks } from '../domains/prompts/promptPackage';
import { parseExecutionPlanDraft, parseIntentDraft, parseTaskOrchestrationDraft } from '../domains/pipeline/draftParsers';

export default function Step3TaskSplit() {
  const { state, dispatch, showToast } = useAppContext();
  const abortRef = useRef(null);
  const [showLog, setShowLog] = useState(false);
  const [activeView, setActiveView] = useState('intents');
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
  }, [dispatch, state]);

  const handleStopAI = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    dispatch({ type: 'AI_DONE' });
    showToast('⏹️ 已停止拆分');
  };

  const handleDraftChange = (field, value) => {
    const nextDrafts = {
      ...state.splitDrafts,
      [field]: value,
    };
    dispatch({ type: 'UPDATE_SPLIT_DRAFT', field, value });
    syncDraftsToModels(nextDrafts);
  };

  const activeDraftField = {
    intents: 'intentDecomposition',
    plan: 'executionPlan',
    tasks: 'taskOrchestration',
  }[activeView];

  const activeDraftTitle = {
    intents: '意图拆解',
    plan: '执行计划',
    tasks: '任务编排',
  }[activeView];

  const activeDraftValue = state.splitDrafts[activeDraftField] || '';

  const activeDraftPlaceholder = {
    intents: '点击“开始拆分”后，这里会生成意图拆解结果。',
    plan: '点击“开始拆分”后，这里会生成执行计划结果。',
    tasks: '点击“开始拆分”后，这里会生成任务编排结果。',
  }[activeView];

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

  const runStage = useCallback((stage, step1Json, step2Json, previousOutputs) => {
    return new Promise((resolve, reject) => {
      if (abortRef.current) {
        abortRef.current();
      }

      appendAiLog(`\n========== 阶段 ${stage.toUpperCase()} 开始 ==========\n`);

      abortRef.current = aiOrchestrateStage(
        {
          engine: state.aiEngine,
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
            appendAiLog(`\n========== 阶段 ${stage.toUpperCase()} 完成 ==========\n`);
            resolve(data.output || '');
          },
          onRaw: (text) => resolve(text || ''),
          onError: (msg, stderr) => reject(new Error(msg + (stderr ? `\n${stderr}` : ''))),
          onDone: () => {},
        }
      );
    });
  }, [appendAiLog, dispatch, state.aiEngine, state.projectFiles, state.projectPath]);

  const handleStartSplit = useCallback(async () => {
    if (!state.requirementDesc.trim()) {
      dispatch({ type: 'SET_STEP', step: 1 });
      return;
    }
    if (!state.aiEngine || !state.projectPath) {
      showToast('⚠️ 请先在第一步配置 AI 引擎和项目路径');
      dispatch({ type: 'SET_STEP', step: 1 });
      return;
    }

    dispatch({ type: 'AI_START', status: '正在执行阶段 1/3：意图拆解...' });
    dispatch({ type: 'SET_SPLIT_STARTED', value: true });
    dispatch({
      type: 'SET_SPLIT_DRAFTS',
      value: {
        intentDecomposition: '',
        executionPlan: '',
        taskOrchestration: '',
      },
    });
    setShowLog(true);
    setActiveView('intents');

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

    try {
      const intentDecomposition = await runStage('intent', step1Json, step2Json, {});
      const draftsAfterIntent = {
        intentDecomposition,
        executionPlan: '',
        taskOrchestration: '',
      };
      dispatch({ type: 'SET_SPLIT_DRAFTS', value: draftsAfterIntent });
      dispatch({
        type: 'SET_PIPELINE_DATA',
        intentGraph: parseIntentDraft(intentDecomposition),
        splitDrafts: draftsAfterIntent,
        splitStarted: true,
      });
      setActiveView('plan');
      dispatch({ type: 'AI_STATUS', status: '正在执行阶段 2/3：执行计划...' });

      const executionPlan = await runStage('plan', step1Json, step2Json, draftsAfterIntent);
      const draftsAfterPlan = {
        ...draftsAfterIntent,
        executionPlan,
      };
      dispatch({ type: 'SET_SPLIT_DRAFTS', value: draftsAfterPlan });
      dispatch({
        type: 'SET_PIPELINE_DATA',
        executionPlan: parseExecutionPlanDraft(executionPlan),
        splitDrafts: draftsAfterPlan,
        splitStarted: true,
      });
      setActiveView('tasks');
      dispatch({ type: 'AI_STATUS', status: '正在执行阶段 3/3：任务编排...' });

      const taskOrchestration = await runStage('tasks', step1Json, step2Json, draftsAfterPlan);
      const finalDrafts = {
        ...draftsAfterPlan,
        taskOrchestration,
      };
      syncDraftsToModels(finalDrafts);
      setActiveView('intents');
      dispatch({ type: 'AI_DONE' });
      showToast('✅ 三阶段拆分完成');
    } catch (err) {
      dispatch({ type: 'AI_ERROR', message: err.message || String(err) });
      showToast('❌ 智能拆分失败');
    }
  }, [dispatch, runStage, showToast, state, syncDraftsToModels]);

  return (
    <div className="step-content active fade-in">
      <div className="resource-section-title" style={{ marginBottom: 16 }}>🧩 智能拆分</div>
      <div className="split-launch-card">
        <div className="split-launch-title">开始拆分</div>
        <div className="split-launch-desc">
          系统会读取第一步的项目与需求信息、第二步的资源信息，并结合当前项目代码结构，一次性编排出「意图拆解」「执行计划」「任务编排」三份草稿。
        </div>
        {state.aiLoading ? (
          <button className="btn btn-danger" onClick={handleStopAI}>⏹️ 停止拆分</button>
        ) : (
          <button
            className="btn btn-primary btn-lg"
            onClick={handleStartSplit}
            disabled={!state.aiEngine || !state.projectPath}
          >
            ▶ 开始拆分
          </button>
        )}
      </div>

      {/* AI Log Panel */}
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
            <pre className="ai-log-body">{state.aiLog || '等待输出...'}</pre>
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
        <button className="btn btn-secondary" onClick={() => dispatch({ type: 'SET_STEP', step: 2 })}>← 上一步</button>
        <button className="btn btn-primary" onClick={() => dispatch({ type: 'SET_STEP', step: 4 })}>下一步: Prompt & 执行 →</button>
      </div>
    </div>
  );
}
