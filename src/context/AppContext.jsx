import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { emptyFigmaLink, normalizeFigmaPagesFromLegacy } from '../utils/figmaPages';
import { createExecutionPlan, createIntentGraph, createTaskGraph, createWorkspaceSpec } from '../domains/pipeline/models';

const AppContext = createContext();

const initialState = {
  // AI engine config
  aiEngine: '', // 'claude' | 'cursor'
  projectPath: '',
  availableEngines: [],
  serverOnline: false,

  // Original fields
  projectName: '',
  requirementDesc: '',
  techStack: [],
  extraNotes: '',
  /** 按页面分组；任务 figmaIds 为全表扁平索引 */
  figmaPages: [{ pageName: '', links: [emptyFigmaLink()] }],
  figmaResources: [],
  apiResources: [],
  imageResources: [],
  otherResources: [],
  tasks: [],
  workspaceSpec: createWorkspaceSpec({}),
  intentGraph: createIntentGraph({}),
  executionPlan: createExecutionPlan({}),
  taskGraph: createTaskGraph({}),
  promptPackages: [],
  splitDrafts: {
    intentDecomposition: '',
    executionPlan: '',
    taskOrchestration: '',
  },
  splitStarted: false,
  splitStrategy: 'feature',
  currentStep: 1,
  templateStyle: 'cursor',
  editingTaskIndex: -1,
  modalVisible: false,
  toasts: [],
  optimizations: {},

  // AI streaming state
  aiLoading: false,
  aiLog: '',         // streaming output from AI
  aiStatus: '',      // status message
  projectFiles: [],  // files in project dir

  // Task execution state
  executingTaskIndex: -1,
  executionLog: '',
  executionStatus: '',
};

let taskIdCounter = 0;

function reducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };

    // AI engine
    case 'SET_ENGINE':
      return { ...state, aiEngine: action.engine };
    case 'SET_PROJECT_PATH':
      return { ...state, projectPath: action.path };
    case 'SET_AVAILABLE_ENGINES':
      return { ...state, availableEngines: action.engines };
    case 'SET_SERVER_ONLINE':
      return { ...state, serverOnline: action.online };
    case 'SET_PROJECT_FILES':
      return { ...state, projectFiles: action.files };

    // AI streaming
    case 'AI_START':
      return { ...state, aiLoading: true, aiLog: '', aiStatus: action.status || '正在分析...' };
    case 'AI_STATUS':
      return { ...state, aiStatus: action.status };
    case 'AI_CHUNK':
      return { ...state, aiLog: state.aiLog + action.text };
    case 'AI_DONE':
      return { ...state, aiLoading: false, aiStatus: '' };
    case 'AI_ERROR':
      return { ...state, aiLoading: false, aiStatus: '', aiLog: state.aiLog + '\n❌ ' + action.message };

    // Execution
    case 'EXEC_START':
      return { ...state, executingTaskIndex: action.index, executionLog: '', executionStatus: action.status || '正在执行...' };
    case 'EXEC_CHUNK':
      return { ...state, executionLog: state.executionLog + action.text };
    case 'EXEC_STATUS':
      return { ...state, executionStatus: action.status };
    case 'EXEC_DONE':
      return { ...state, executingTaskIndex: -1, executionStatus: '' };
    case 'EXEC_ERROR':
      return { ...state, executingTaskIndex: -1, executionStatus: '', executionLog: state.executionLog + '\n❌ ' + action.message };

    case 'SET_TECH_STACK':
      return { ...state, techStack: action.value };

    case 'ADD_TECH_TAG': {
      if (state.techStack.includes(action.tag)) return state;
      return { ...state, techStack: [...state.techStack, action.tag] };
    }
    case 'REMOVE_TECH_TAG': {
      const newStack = [...state.techStack];
      newStack.splice(action.index, 1);
      return { ...state, techStack: newStack };
    }
    case 'POP_TECH_TAG': {
      if (state.techStack.length === 0) return state;
      return { ...state, techStack: state.techStack.slice(0, -1) };
    }

    // Resources — Figma 按页面分组
    case 'ADD_FIGMA_PAGE':
      return {
        ...state,
        figmaPages: [...state.figmaPages, { pageName: '', links: [emptyFigmaLink()] }],
      };
    case 'REMOVE_FIGMA_PAGE': {
      const fp = [...state.figmaPages];
      fp.splice(action.pageIndex, 1);
      return {
        ...state,
        figmaPages: fp.length ? fp : [{ pageName: '', links: [emptyFigmaLink()] }],
      };
    }
    case 'UPDATE_FIGMA_PAGE_NAME': {
      const fp = [...state.figmaPages];
      fp[action.pageIndex] = { ...fp[action.pageIndex], pageName: action.value };
      return { ...state, figmaPages: fp };
    }
    case 'ADD_FIGMA_LINK': {
      const pi = action.pageIndex;
      const fp = state.figmaPages.map((p, i) =>
        i === pi ? { ...p, links: [...p.links, emptyFigmaLink()] } : p,
      );
      return { ...state, figmaPages: fp };
    }
    case 'REMOVE_FIGMA_LINK': {
      const { pageIndex, linkIndex } = action;
      const fp = state.figmaPages.map((p, i) => {
        if (i !== pageIndex) return p;
        const links = [...p.links];
        links.splice(linkIndex, 1);
        return { ...p, links };
      });
      return { ...state, figmaPages: fp };
    }
    case 'UPDATE_FIGMA_LINK': {
      const { pageIndex, linkIndex, field, value } = action;
      const fp = state.figmaPages.map((p, i) => {
        if (i !== pageIndex) return p;
        const links = [...p.links];
        links[linkIndex] = { ...links[linkIndex], [field]: value };
        return { ...p, links };
      });
      return { ...state, figmaPages: fp };
    }

    case 'ADD_API':
      return { ...state, apiResources: [...state.apiResources, { name: '', method: 'GET', path: '', description: '', requestBody: '', responseBody: '' }] };
    case 'REMOVE_API': {
      const a = [...state.apiResources];
      a.splice(action.index, 1);
      return { ...state, apiResources: a };
    }
    case 'UPDATE_API': {
      const a = [...state.apiResources];
      a[action.index] = { ...a[action.index], [action.field]: action.value };
      return { ...state, apiResources: a };
    }

    case 'ADD_IMAGE':
      return { ...state, imageResources: [...state.imageResources, { name: '', path: '', description: '' }] };
    case 'REMOVE_IMAGE': {
      const m = [...state.imageResources];
      m.splice(action.index, 1);
      return { ...state, imageResources: m };
    }
    case 'UPDATE_IMAGE': {
      const m = [...state.imageResources];
      m[action.index] = { ...m[action.index], [action.field]: action.value };
      return { ...state, imageResources: m };
    }

    case 'ADD_OTHER':
      return { ...state, otherResources: [...state.otherResources, { name: '', content: '' }] };
    case 'REMOVE_OTHER': {
      const o = [...state.otherResources];
      o.splice(action.index, 1);
      return { ...state, otherResources: o };
    }
    case 'UPDATE_OTHER': {
      const o = [...state.otherResources];
      o[action.index] = { ...o[action.index], [action.field]: action.value };
      return { ...state, otherResources: o };
    }

    // Tasks
    case 'SET_TASKS':
      return {
        ...state,
        tasks: action.tasks,
        taskGraph: createTaskGraph({ tasks: action.tasks }),
      };
    case 'SET_PIPELINE_DATA':
      return {
        ...state,
        workspaceSpec: action.workspaceSpec ? createWorkspaceSpec({
          projectName: action.workspaceSpec?.project?.name,
          projectPath: action.workspaceSpec?.project?.path,
          techStack: action.workspaceSpec?.project?.techStack,
          requirement: action.workspaceSpec?.requirement?.rawText,
          extraNotes: action.workspaceSpec?.requirement?.extraNotes,
          figmaPages: action.workspaceSpec?.resources?.figmaPages,
          apiResources: action.workspaceSpec?.resources?.apiResources,
          imageResources: action.workspaceSpec?.resources?.imageResources,
          otherResources: action.workspaceSpec?.resources?.otherResources,
          projectFiles: action.workspaceSpec?.projectFiles,
        }) : state.workspaceSpec,
        intentGraph: action.intentGraph ? createIntentGraph(action.intentGraph) : state.intentGraph,
        executionPlan: action.executionPlan ? createExecutionPlan(action.executionPlan) : state.executionPlan,
        taskGraph: action.taskGraph ? createTaskGraph(action.taskGraph) : state.taskGraph,
        promptPackages: Array.isArray(action.promptPackages) ? action.promptPackages : state.promptPackages,
        splitDrafts: action.splitDrafts ? { ...state.splitDrafts, ...action.splitDrafts } : state.splitDrafts,
        splitStarted: action.splitStarted ?? state.splitStarted,
      };
    case 'SET_SPLIT_STARTED':
      return {
        ...state,
        splitStarted: Boolean(action.value),
      };
    case 'SET_SPLIT_DRAFTS':
      return {
        ...state,
        splitDrafts: {
          ...state.splitDrafts,
          ...action.value,
        },
      };
    case 'UPDATE_SPLIT_DRAFT':
      return {
        ...state,
        splitDrafts: {
          ...state.splitDrafts,
          [action.field]: action.value,
        },
      };
    case 'ADD_INTENT': {
      const nextIntent = {
        id: action.intent?.id || `intent-${Date.now()}`,
        type: action.intent?.type || 'business_goal',
        title: action.intent?.title || '新意图',
        summary: action.intent?.summary || '',
        priority: action.intent?.priority || 'medium',
        source: action.intent?.source || 'manual',
        dependsOn: Array.isArray(action.intent?.dependsOn) ? action.intent.dependsOn : [],
        acceptanceSignals: Array.isArray(action.intent?.acceptanceSignals) ? action.intent.acceptanceSignals : [],
        resourceBindings: action.intent?.resourceBindings || { figma: [], api: [], images: [] },
        constraints: Array.isArray(action.intent?.constraints) ? action.intent.constraints : [],
      };
      return {
        ...state,
        intentGraph: {
          ...state.intentGraph,
          intents: [...(state.intentGraph.intents || []), nextIntent],
        },
      };
    }
    case 'UPDATE_INTENT': {
      const intents = [...(state.intentGraph.intents || [])];
      intents[action.index] = { ...intents[action.index], ...action.data };
      return {
        ...state,
        intentGraph: {
          ...state.intentGraph,
          intents,
        },
      };
    }
    case 'REMOVE_INTENT': {
      const intents = [...(state.intentGraph.intents || [])];
      const [removed] = intents.splice(action.index, 1);
      const removedId = removed?.id;
      return {
        ...state,
        intentGraph: {
          ...state.intentGraph,
          intents: intents.map((intent) => ({
            ...intent,
            dependsOn: Array.isArray(intent.dependsOn)
              ? intent.dependsOn.filter((depId) => depId !== removedId)
              : [],
          })),
        },
      };
    }
    case 'SET_INTENT_GRAPH':
      return {
        ...state,
        intentGraph: createIntentGraph(action.intentGraph || {}),
      };
    case 'SET_EXECUTION_PLAN':
      return {
        ...state,
        executionPlan: createExecutionPlan(action.executionPlan || {}),
      };
    case 'SET_PROMPT_PACKAGES':
      return {
        ...state,
        promptPackages: Array.isArray(action.promptPackages) ? action.promptPackages : [],
      };
    case 'UPDATE_PROMPT_PACKAGE': {
      const packages = Array.isArray(state.promptPackages) ? [...state.promptPackages] : [];
      const idx = packages.findIndex((pkg) => String(pkg.taskId) === String(action.taskId));
      const now = new Date().toISOString();
      if (idx >= 0) {
        packages[idx] = {
          ...packages[idx],
          ...action.data,
          version: (packages[idx].version || 1) + 1,
          updatedAt: now,
        };
      } else {
        packages.push({ taskId: action.taskId, version: 1, updatedAt: now, ...action.data });
      }
      return {
        ...state,
        promptPackages: packages,
      };
    }
    case 'ADD_TASK': {
      const newTask = {
        id: ++taskIdCounter,
        type: 'implementation',
        title: '新任务',
        goal: '',
        description: '',
        intentIds: [],
        acceptanceCriteria: [],
        allowedChanges: { files: [], newFiles: [] },
        forbiddenChanges: { files: [], actions: [] },
        changePlan: [],
        files: [],
        steps: [],
        dependencies: [],
        prompt: '',
        figmaIds: [],
        apiIds: [],
        imageIds: [],
        extra: '',
        status: 'pending', // pending | running | done | error
        executionOutput: '',
        executionResult: {
          summary: '',
          risks: [],
          assumptions: [],
          manualChecks: [],
          satisfiedCriteria: [],
          unresolvedCriteria: [],
        },
        verification: {
          status: 'pending',
          failureCategory: '',
          reviewerNotes: '',
          lastVerifiedAt: '',
        },
        metrics: {
          runCount: 0,
          successCount: 0,
          errorCount: 0,
          lastRunAt: '',
        },
      };
      const nextTasks = [...state.tasks, newTask];
      return {
        ...state,
        tasks: nextTasks,
        taskGraph: createTaskGraph({ tasks: nextTasks }),
      };
    }
    case 'REMOVE_TASK': {
      const t = [...state.tasks];
      t.splice(action.index, 1);
      return {
        ...state,
        tasks: t,
        taskGraph: createTaskGraph({ tasks: t }),
      };
    }
    case 'UPDATE_TASK': {
      const t = [...state.tasks];
      t[action.index] = { ...t[action.index], ...action.data };
      return {
        ...state,
        tasks: t,
        taskGraph: createTaskGraph({ tasks: t }),
      };
    }
    case 'REORDER_TASKS': {
      const t = [...state.tasks];
      const [item] = t.splice(action.from, 1);
      t.splice(action.to, 0, item);
      return {
        ...state,
        tasks: t,
        taskGraph: createTaskGraph({ tasks: t }),
      };
    }

    // Strategy
    case 'SET_STRATEGY':
      return { ...state, splitStrategy: action.strategy === 'page' ? 'feature' : action.strategy };

    // Step
    case 'SET_STEP':
      return { ...state, currentStep: action.step };

    // Template
    case 'SET_TEMPLATE':
      return { ...state, templateStyle: action.style };

    // Modal
    case 'OPEN_MODAL':
      return { ...state, editingTaskIndex: action.index, modalVisible: true };
    case 'CLOSE_MODAL':
      return { ...state, editingTaskIndex: -1, modalVisible: false };

    // Toast
    case 'ADD_TOAST':
      return { ...state, toasts: [...state.toasts, { id: Date.now(), message: action.message }] };
    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter(t => t.id !== action.id) };

    // Load from storage
    case 'LOAD_STATE': {
      const loaded = action.state;
      if (loaded.tasks && loaded.tasks.length > 0) {
        const maxId = Math.max(...loaded.tasks.map(t => t.id || 0));
        if (maxId > taskIdCounter) taskIdCounter = maxId;
      }
      const figmaPages = normalizeFigmaPagesFromLegacy(loaded);
      return {
        ...state,
        ...loaded,
        splitStrategy: loaded.splitStrategy === 'page' ? 'feature' : (loaded.splitStrategy || state.splitStrategy),
        figmaPages,
        figmaResources: [],
        workspaceSpec: loaded.workspaceSpec || createWorkspaceSpec(loaded),
        intentGraph: createIntentGraph(loaded.intentGraph || {}),
        executionPlan: createExecutionPlan(loaded.executionPlan || {}),
        taskGraph: createTaskGraph(loaded.taskGraph || { tasks: loaded.tasks || [] }),
        promptPackages: Array.isArray(loaded.promptPackages) ? loaded.promptPackages : [],
        splitDrafts: loaded.splitDrafts || state.splitDrafts,
        splitStarted: Boolean(loaded.splitStarted),
        currentStep: 1,
        modalVisible: false,
        editingTaskIndex: -1,
        toasts: [],
        optimizations: loaded.optimizations || {},
        aiLoading: false,
        aiLog: '',
        aiStatus: '',
        executingTaskIndex: -1,
        executionLog: '',
        executionStatus: '',
      };
    }

    case 'RESET':
      taskIdCounter = 0;
      return { ...initialState, toasts: [] };

    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveTimerRef = useRef(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('taskforge_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        dispatch({ type: 'LOAD_STATE', state: parsed });
      }
    } catch (e) { /* ignore */ }
  }, []);

  const autoSave = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const toSave = { ...state };
        delete toSave.toasts;
        delete toSave.modalVisible;
        delete toSave.editingTaskIndex;
        delete toSave.aiLoading;
        delete toSave.aiLog;
        delete toSave.aiStatus;
        delete toSave.executingTaskIndex;
        delete toSave.executionLog;
        delete toSave.executionStatus;
        delete toSave.serverOnline;
        delete toSave.availableEngines;
        delete toSave.projectFiles;
        localStorage.setItem('taskforge_state', JSON.stringify(toSave));
      } catch (e) { /* ignore */ }
    }, 500);
  }, [state]);

  useEffect(() => {
    autoSave();
  }, [state, autoSave]);

  const showToast = useCallback((message) => {
    const id = Date.now();
    dispatch({ type: 'ADD_TOAST', message });
    setTimeout(() => {
      dispatch({ type: 'REMOVE_TOAST', id });
    }, 2300);
  }, []);

  const copyToClipboard = useCallback((text) => {
    navigator.clipboard.writeText(text).then(() => {
      showToast('✅ 已复制到剪贴板');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('✅ 已复制到剪贴板');
    });
  }, [showToast]);

  return (
    <AppContext.Provider value={{ state, dispatch, showToast, copyToClipboard }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  return useContext(AppContext);
}

export { taskIdCounter };
