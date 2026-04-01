function compactText(value) {
  return String(value || '').trim();
}

export function createWorkspaceSpec(input = {}) {
  return {
    project: {
      name: compactText(input.projectName),
      path: compactText(input.projectPath),
      techStack: Array.isArray(input.techStack) ? input.techStack.filter(Boolean) : [],
    },
    requirement: {
      rawText: compactText(input.requirementDesc || input.requirement),
      extraNotes: compactText(input.extraNotes),
    },
    resources: {
      figmaPages: Array.isArray(input.figmaPages) ? input.figmaPages : [],
      apiResources: Array.isArray(input.apiResources) ? input.apiResources : [],
      imageResources: Array.isArray(input.imageResources) ? input.imageResources : [],
      otherResources: Array.isArray(input.otherResources) ? input.otherResources : [],
    },
    projectFiles: Array.isArray(input.projectFiles) ? input.projectFiles.filter(Boolean) : [],
  };
}

export function createIntent(intent = {}, index = 0) {
  return {
    id: intent.id || `intent-${index + 1}`,
    type: intent.type || 'business_goal',
    title: compactText(intent.title) || `意图 ${index + 1}`,
    summary: compactText(intent.summary) || compactText(intent.title) || '',
    priority: intent.priority || 'medium',
    source: intent.source || 'requirement',
    dependsOn: Array.isArray(intent.dependsOn) ? intent.dependsOn : [],
    acceptanceSignals: Array.isArray(intent.acceptanceSignals) ? intent.acceptanceSignals.filter(Boolean) : [],
    resourceBindings: {
      figma: Array.isArray(intent?.resourceBindings?.figma) ? intent.resourceBindings.figma : [],
      api: Array.isArray(intent?.resourceBindings?.api) ? intent.resourceBindings.api : [],
      images: Array.isArray(intent?.resourceBindings?.images) ? intent.resourceBindings.images : [],
    },
    constraints: Array.isArray(intent.constraints) ? intent.constraints.filter(Boolean) : [],
  };
}

export function createIntentGraph(graph = {}) {
  const intents = Array.isArray(graph.intents) ? graph.intents.map(createIntent) : [];
  return {
    rootGoal: compactText(graph.rootGoal),
    intents,
    assumptions: Array.isArray(graph.assumptions) ? graph.assumptions.filter(Boolean) : [],
    questions: Array.isArray(graph.questions) ? graph.questions.filter(Boolean) : [],
    risks: Array.isArray(graph.risks) ? graph.risks.filter(Boolean) : [],
  };
}

export function createExecutionPlan(plan = {}) {
  return {
    summary: compactText(plan.summary),
    reuseCandidates: Array.isArray(plan.reuseCandidates) ? plan.reuseCandidates : [],
    affectedAreas: Array.isArray(plan.affectedAreas) ? plan.affectedAreas : [],
    proposedSlices: Array.isArray(plan.proposedSlices) ? plan.proposedSlices : [],
    blockingQuestions: Array.isArray(plan.blockingQuestions) ? plan.blockingQuestions.filter(Boolean) : [],
  };
}

export function createTaskNode(task = {}, index = 0) {
  return {
    id: task.id ?? `task-${index + 1}`,
    type: task.type || 'implementation',
    title: compactText(task.title) || `任务 ${index + 1}`,
    goal: compactText(task.goal) || compactText(task.description),
    description: compactText(task.description),
    intentIds: Array.isArray(task.intentIds) ? task.intentIds : [],
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.filter(Boolean) : [],
    allowedChanges: {
      files: Array.isArray(task?.allowedChanges?.files)
        ? task.allowedChanges.files.filter(Boolean)
        : Array.isArray(task.files) ? task.files.filter(Boolean) : [],
      newFiles: Array.isArray(task?.allowedChanges?.newFiles) ? task.allowedChanges.newFiles.filter(Boolean) : [],
    },
    forbiddenChanges: {
      files: Array.isArray(task?.forbiddenChanges?.files) ? task.forbiddenChanges.files.filter(Boolean) : [],
      actions: Array.isArray(task?.forbiddenChanges?.actions) ? task.forbiddenChanges.actions.filter(Boolean) : [],
    },
    changePlan: Array.isArray(task.changePlan) ? task.changePlan : [],
    files: Array.isArray(task.files) ? task.files.filter(Boolean) : [],
    steps: Array.isArray(task.steps) ? task.steps.filter(Boolean) : [],
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    resourceBindings: {
      figma: Array.isArray(task?.resourceBindings?.figma) ? task.resourceBindings.figma : [],
      api: Array.isArray(task?.resourceBindings?.api) ? task.resourceBindings.api : [],
      images: Array.isArray(task?.resourceBindings?.images) ? task.resourceBindings.images : [],
    },
    figmaIds: Array.isArray(task.figmaIds) ? task.figmaIds : [],
    apiIds: Array.isArray(task.apiIds) ? task.apiIds : [],
    imageIds: Array.isArray(task.imageIds) ? task.imageIds : [],
    extra: compactText(task.extra),
    prompt: compactText(task.prompt),
    status: task.status || 'pending',
    executionOutput: compactText(task.executionOutput),
    executionResult: {
      summary: compactText(task?.executionResult?.summary),
      risks: Array.isArray(task?.executionResult?.risks) ? task.executionResult.risks.filter(Boolean) : [],
      assumptions: Array.isArray(task?.executionResult?.assumptions) ? task.executionResult.assumptions.filter(Boolean) : [],
      manualChecks: Array.isArray(task?.executionResult?.manualChecks) ? task.executionResult.manualChecks.filter(Boolean) : [],
      satisfiedCriteria: Array.isArray(task?.executionResult?.satisfiedCriteria) ? task.executionResult.satisfiedCriteria.filter(Boolean) : [],
      unresolvedCriteria: Array.isArray(task?.executionResult?.unresolvedCriteria) ? task.executionResult.unresolvedCriteria.filter(Boolean) : [],
    },
    verification: {
      status: task?.verification?.status || 'pending',
      failureCategory: compactText(task?.verification?.failureCategory),
      reviewerNotes: compactText(task?.verification?.reviewerNotes),
      lastVerifiedAt: compactText(task?.verification?.lastVerifiedAt),
    },
    metrics: {
      runCount: Number.isFinite(task?.metrics?.runCount) ? task.metrics.runCount : 0,
      successCount: Number.isFinite(task?.metrics?.successCount) ? task.metrics.successCount : 0,
      errorCount: Number.isFinite(task?.metrics?.errorCount) ? task.metrics.errorCount : 0,
      lastRunAt: compactText(task?.metrics?.lastRunAt),
    },
  };
}

export function createTaskGraph(taskGraph = {}) {
  const rawTasks = Array.isArray(taskGraph.tasks) ? taskGraph.tasks : [];
  return {
    tasks: rawTasks.map(createTaskNode),
  };
}

export function createPromptPackage(pkg = {}) {
  return {
    taskId: pkg.taskId,
    systemPrompt: compactText(pkg.systemPrompt),
    projectPrompt: compactText(pkg.projectPrompt),
    taskPrompt: compactText(pkg.taskPrompt),
    outputContract: compactText(pkg.outputContract),
    verificationContract: compactText(pkg.verificationContract),
    promptText: compactText(pkg.promptText),
    version: Number.isFinite(pkg.version) ? pkg.version : 1,
    updatedAt: compactText(pkg.updatedAt),
  };
}
