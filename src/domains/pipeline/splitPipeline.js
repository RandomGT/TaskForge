import {
  createExecutionPlan,
  createIntent,
  createIntentGraph,
  createTaskGraph,
  createTaskNode,
  createWorkspaceSpec,
} from './models';

function splitRequirementSegments(text) {
  return String(text || '')
    .split(/[。；;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
}

function classifyIntentType(segment) {
  if (/(接口|请求|响应|字段|数据|查询|提交|保存|删除|新增)/.test(segment)) {
    return 'data_contract';
  }
  if (/(按钮|点击|输入|筛选|搜索|选择|弹窗|表单|交互|列表)/.test(segment)) {
    return 'user_interaction';
  }
  if (/(figma|设计稿|页面|布局|样式|颜色|图标|还原|token|视觉)/i.test(segment)) {
    return 'ui_realization';
  }
  if (/(复用|禁止|不要|限制|范围|仅|必须|目录|规范|风格)/.test(segment)) {
    return 'engineering_constraint';
  }
  return 'business_goal';
}

function guessIntentPriority(segment) {
  if (/(必须|核心|主流程|首版|优先|先)/.test(segment)) return 'high';
  if (/(可选|后续|补充|优化)/.test(segment)) return 'low';
  return 'medium';
}

function extractAcceptanceSignals(segment) {
  const signals = [];
  if (/(列表|表格)/.test(segment)) signals.push('页面能展示主要数据列表');
  if (/(筛选|搜索)/.test(segment)) signals.push('用户操作会更新筛选条件并影响结果');
  if (/(接口|请求|保存|提交)/.test(segment)) signals.push('前后端契约与接口调用一致');
  if (/(figma|设计稿|布局|样式)/i.test(segment)) signals.push('关键界面与设计稿保持一致');
  if (signals.length === 0) signals.push(`能够完成“${segment}”对应的用户目标`);
  return signals;
}

function buildIntentFromSegment(segment, index) {
  const type = classifyIntentType(segment);
  return createIntent({
    id: `intent-${index + 1}`,
    type,
    title: segment.length > 28 ? `${segment.slice(0, 28)}...` : segment,
    summary: segment,
    priority: guessIntentPriority(segment),
    source: 'requirement',
    acceptanceSignals: extractAcceptanceSignals(segment),
    constraints: type === 'engineering_constraint' ? [segment] : [],
  }, index);
}

function inferRootGoal(workspaceSpec, intents) {
  const first = intents[0]?.summary || workspaceSpec.requirement.rawText;
  if (first) return first;
  return workspaceSpec.project.name ? `完成 ${workspaceSpec.project.name} 当前需求` : '完成当前需求';
}

function pickAffectedAreas(projectFiles = []) {
  const rel = projectFiles.slice(0, 120).map((file) => {
    const parts = String(file).split('/').filter(Boolean);
    return parts.slice(0, Math.min(parts.length, 3)).join('/');
  });
  return [...new Set(rel)].slice(0, 12);
}

function inferReuseCandidates(projectFiles = []) {
  return projectFiles
    .filter((file) => /components|api|services|hooks|utils|theme|styles/i.test(file))
    .slice(0, 12)
    .map((file) => ({
      target: file.split('/').pop(),
      file,
      reason: '可能是现有可复用实现或规范入口',
    }));
}

function inferTaskType(task) {
  const text = `${task.title || ''} ${task.description || ''}`;
  if (/(接口|请求|响应|字段|查询|提交|保存|删除)/.test(text)) return 'api_integration';
  if (/(修复|bug|异常|报错|错误)/i.test(text)) return 'bug_fix';
  if (/(组件|抽离|封装|复用)/.test(text)) return 'component_extraction';
  return 'ui_implementation';
}

function inferTaskTypeFromIntent(intent) {
  switch (intent?.type) {
    case 'data_contract':
      return 'api_integration';
    case 'ui_realization':
      return 'ui_implementation';
    case 'user_interaction':
      return 'implementation';
    case 'engineering_constraint':
      return 'implementation';
    default:
      return 'implementation';
  }
}

function buildStepsFromIntent(intent) {
  const steps = ['分析现有实现与可复用点'];
  if (intent?.type === 'ui_realization') {
    steps.push('读取相关 Figma 或设计约束并确认页面结构');
  }
  if (intent?.type === 'data_contract') {
    steps.push('核对接口契约、请求参数与响应结构');
  }
  if (intent?.type === 'user_interaction') {
    steps.push('梳理交互状态和用户触发路径');
  }
  steps.push('确定改动文件与最小实施范围');
  steps.push('实现并完成自检');
  return steps;
}

function buildAllowedChangesFromPlan(executionPlan, intent) {
  const affectedAreas = Array.isArray(executionPlan?.affectedAreas) ? executionPlan.affectedAreas : [];
  const files = affectedAreas
    .filter(Boolean)
    .slice(0, 6)
    .map((area) => `${area}/**`);

  if (intent?.type === 'ui_realization') {
    files.push('src/components/**');
    files.push('src/pages/**');
  }
  if (intent?.type === 'data_contract') {
    files.push('src/api/**');
    files.push('src/services/**');
  }

  return [...new Set(files)];
}

function buildAcceptanceCriteria(task, intentGraph) {
  const criteria = [];
  const relatedIntents = (intentGraph.intents || []).filter((intent) =>
    (task.intentIds || []).includes(intent.id)
  );
  relatedIntents.forEach((intent) => {
    intent.acceptanceSignals.forEach((signal) => criteria.push(signal));
  });
  if ((task.figmaIds || []).length) criteria.push('实现前通过 Figma MCP 核对设计信息');
  if ((task.apiIds || []).length) criteria.push('接口实现与登记契约保持一致');
  if (!criteria.length) criteria.push('任务完成后应满足描述中的目标且不引入无关改动');
  return [...new Set(criteria)];
}

export function buildIntentGraphFromSpec(workspaceSpec) {
  const segments = splitRequirementSegments(workspaceSpec.requirement.rawText);
  const intents = segments.length
    ? segments.map(buildIntentFromSegment)
    : [buildIntentFromSegment(workspaceSpec.requirement.rawText || '完成当前需求', 0)];

  return createIntentGraph({
    rootGoal: inferRootGoal(workspaceSpec, intents),
    intents,
    assumptions: [],
    questions: [],
    risks: [],
  });
}

export function buildExecutionPlanFromSpec(workspaceSpec, intentGraph) {
  const summary = intentGraph.rootGoal || workspaceSpec.requirement.rawText;
  return createExecutionPlan({
    summary,
    reuseCandidates: inferReuseCandidates(workspaceSpec.projectFiles),
    affectedAreas: pickAffectedAreas(workspaceSpec.projectFiles),
    proposedSlices: (intentGraph.intents || []).map((intent) => ({
      intentId: intent.id,
      title: intent.title,
      type: intent.type,
    })),
    blockingQuestions: intentGraph.questions || [],
  });
}

export function buildTaskGraphFromLegacyTasks(tasks = [], intentGraph, executionPlan) {
  const normalizedTasks = (tasks || []).map((task, index) => {
    const intentIds = Array.isArray(task.intentIds) && task.intentIds.length
      ? task.intentIds
      : (intentGraph.intents || [])
        .filter((intent) => {
          const title = `${task.title || ''} ${task.description || ''}`.toLowerCase();
          return title && intent.summary && title.includes(intent.summary.slice(0, 6).toLowerCase());
        })
        .map((intent) => intent.id)
        .slice(0, 3);

    return createTaskNode({
      ...task,
      type: task.type || inferTaskType(task),
      goal: task.goal || task.description || task.title,
      intentIds,
      acceptanceCriteria: buildAcceptanceCriteria({ ...task, intentIds }, intentGraph),
      allowedChanges: {
        files: Array.isArray(task.files) ? task.files : [],
        newFiles: [],
      },
      forbiddenChanges: task.forbiddenChanges || {
        files: [],
        actions: executionPlan?.summary
          ? ['不要顺手重构与当前任务无关的模块']
          : [],
      },
      resourceBindings: {
        figma: Array.isArray(task.figmaIds) ? task.figmaIds.map((id) => `figma:${id}`) : [],
        api: Array.isArray(task.apiIds) ? task.apiIds.map((id) => `api:${id}`) : [],
        images: Array.isArray(task.imageIds) ? task.imageIds.map((id) => `image:${id}`) : [],
      },
    }, index);
  });

  return createTaskGraph({ tasks: normalizedTasks });
}

export function buildTaskGraphFromIntentGraph(intentGraph, executionPlan, options = {}) {
  const intents = Array.isArray(intentGraph?.intents) ? intentGraph.intents : [];
  const constraints = intents
    .filter((intent) => intent.type === 'engineering_constraint')
    .map((intent) => intent.summary || intent.title)
    .filter(Boolean);

  const actionableIntents = intents.filter((intent) => intent.type !== 'engineering_constraint');
  const sourceIntents = actionableIntents.length ? actionableIntents : intents;

  const tasks = sourceIntents.map((intent, index) => {
    const taskId = `task-from-intent-${index + 1}`;
    return createTaskNode({
      id: taskId,
      type: inferTaskTypeFromIntent(intent),
      title: intent.title || `任务 ${index + 1}`,
      goal: intent.summary || intent.title || '',
      description: intent.summary || intent.title || '',
      intentIds: [intent.id],
      acceptanceCriteria: Array.isArray(intent.acceptanceSignals) && intent.acceptanceSignals.length
        ? intent.acceptanceSignals
        : [`完成与“${intent.title}”相关的交付目标`],
      allowedChanges: {
        files: Array.isArray(options.allowedFiles) && options.allowedFiles.length
          ? options.allowedFiles
          : buildAllowedChangesFromPlan(executionPlan, intent),
        newFiles: [],
      },
      forbiddenChanges: {
        files: [],
        actions: [...constraints, ...(Array.isArray(intent.constraints) ? intent.constraints : [])],
      },
      changePlan: [],
      files: [],
      steps: buildStepsFromIntent(intent),
      dependencies: Array.isArray(intent.dependsOn)
        ? intent.dependsOn.map((depId) => sourceIntents.findIndex((item) => item.id === depId))
          .filter((taskIndex) => taskIndex >= 0)
          .map((taskIndex) => `task-from-intent-${taskIndex + 1}`)
        : [],
      resourceBindings: {
        figma: Array.isArray(intent?.resourceBindings?.figma) ? intent.resourceBindings.figma : [],
        api: Array.isArray(intent?.resourceBindings?.api) ? intent.resourceBindings.api : [],
        images: Array.isArray(intent?.resourceBindings?.images) ? intent.resourceBindings.images : [],
      },
      extra: constraints.length ? `全局约束：${constraints.join('；')}` : '',
      prompt: '',
      status: 'pending',
      executionOutput: '',
    });
  });

  return createTaskGraph({ tasks });
}

export function buildPipelineArtifacts({ workspaceSpec, intentGraph, executionPlan, taskGraph }) {
  return {
    workspaceSpec: createWorkspaceSpec({
      projectName: workspaceSpec?.project?.name,
      projectPath: workspaceSpec?.project?.path,
      techStack: workspaceSpec?.project?.techStack,
      requirement: workspaceSpec?.requirement?.rawText,
      extraNotes: workspaceSpec?.requirement?.extraNotes,
      figmaPages: workspaceSpec?.resources?.figmaPages,
      apiResources: workspaceSpec?.resources?.apiResources,
      imageResources: workspaceSpec?.resources?.imageResources,
      otherResources: workspaceSpec?.resources?.otherResources,
      projectFiles: workspaceSpec?.projectFiles,
    }),
    intentGraph: createIntentGraph(intentGraph),
    executionPlan: createExecutionPlan(executionPlan),
    taskGraph: createTaskGraph(taskGraph),
  };
}

export function buildLocalSplitArtifacts(state, legacyTasks = []) {
  const workspaceSpec = createWorkspaceSpec(state);
  const intentGraph = buildIntentGraphFromSpec(workspaceSpec);
  const executionPlan = buildExecutionPlanFromSpec(workspaceSpec, intentGraph);
  const taskGraph = buildTaskGraphFromLegacyTasks(legacyTasks, intentGraph, executionPlan);
  return buildPipelineArtifacts({ workspaceSpec, intentGraph, executionPlan, taskGraph });
}

export function normalizeSplitResponse(data = {}, state, fallbackTasks = []) {
  const workspaceSpec = data.workspaceSpec
    ? createWorkspaceSpec({
        projectName: data.workspaceSpec?.project?.name,
        projectPath: data.workspaceSpec?.project?.path,
        techStack: data.workspaceSpec?.project?.techStack,
        requirement: data.workspaceSpec?.requirement?.rawText,
        extraNotes: data.workspaceSpec?.requirement?.extraNotes,
        figmaPages: data.workspaceSpec?.resources?.figmaPages,
        apiResources: data.workspaceSpec?.resources?.apiResources,
        imageResources: data.workspaceSpec?.resources?.imageResources,
        otherResources: data.workspaceSpec?.resources?.otherResources,
        projectFiles: data.workspaceSpec?.projectFiles,
      })
    : createWorkspaceSpec(state);

  const intentGraph = data.intentGraph
    ? createIntentGraph(data.intentGraph)
    : buildIntentGraphFromSpec(workspaceSpec);

  const executionPlan = data.executionPlan
    ? createExecutionPlan(data.executionPlan)
    : buildExecutionPlanFromSpec(workspaceSpec, intentGraph);

  const rawTasks = Array.isArray(data?.taskGraph?.tasks)
    ? data.taskGraph.tasks
    : Array.isArray(data.tasks)
      ? data.tasks
      : fallbackTasks;

  const taskGraph = buildTaskGraphFromLegacyTasks(rawTasks, intentGraph, executionPlan);
  return { workspaceSpec, intentGraph, executionPlan, taskGraph };
}
