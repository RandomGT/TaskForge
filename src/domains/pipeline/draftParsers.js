import { createExecutionPlan, createIntentGraph, createTaskGraph, createTaskNode, createIntent } from './models';

function extractSection(text, title) {
  const pattern = new RegExp(`###\\s*${title}[\\s\\S]*?(?=\\n###\\s|$)`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[0] : '';
}

function getBulletLines(sectionText) {
  return String(sectionText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, '').trim());
}

export function parseIntentDraft(intentText) {
  const coreIntentSection = extractSection(intentText, '1\\.\\s*核心意图');
  const userStoriesSection = extractSection(intentText, '2\\.\\s*用户故事');
  const mustHaveSection = extractSection(intentText, '必须包含');
  const constraintsSection = extractSection(intentText, '5\\.\\s*隐含约束');
  const clarificationSection = extractSection(intentText, '6\\.\\s*待澄清项');

  const rootGoal = coreIntentSection
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^###/.test(line) && !/^用一句话/.test(line)) || '';

  const intents = [];
  getBulletLines(userStoriesSection).forEach((story, index) => {
    intents.push(createIntent({
      id: `intent-story-${index + 1}`,
      type: 'user_interaction',
      title: story.slice(0, 32),
      summary: story,
      acceptanceSignals: [story],
    }, index));
  });

  getBulletLines(mustHaveSection).forEach((item, index) => {
    intents.push(createIntent({
      id: `intent-must-${index + 1}`,
      type: 'business_goal',
      title: item.slice(0, 32),
      summary: item,
      acceptanceSignals: [item],
    }, intents.length + index));
  });

  const constraintLines = getBulletLines(constraintsSection).filter((line) => !/^无隐含约束/.test(line));
  constraintLines.forEach((item, index) => {
    intents.push(createIntent({
      id: `intent-constraint-${index + 1}`,
      type: 'engineering_constraint',
      title: item.slice(0, 32),
      summary: item,
      constraints: [item],
    }, intents.length + index));
  });

  const questions = getBulletLines(clarificationSection);

  return createIntentGraph({
    rootGoal,
    intents,
    questions,
    assumptions: [],
    risks: [],
  });
}

export function parseExecutionPlanDraft(planText) {
  const overviewSection = extractSection(planText, '1\\.\\s*技术架构概览');
  const riskSection = extractSection(planText, '7\\.\\s*技术风险与应对');
  const resourceSection = extractSection(planText, '6\\.\\s*资源配置');

  const summary = overviewSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^###/.test(line) && !/^-?$/.test(line))
    .slice(0, 4)
    .join(' ');

  const affectedAreas = getBulletLines(overviewSection);
  const blockingQuestions = getBulletLines(riskSection);
  const reuseCandidates = getBulletLines(resourceSection).map((line, index) => ({
    target: `资源 ${index + 1}`,
    file: line,
    reason: '来自执行计划中的资源配置',
  }));

  return createExecutionPlan({
    summary,
    reuseCandidates,
    affectedAreas,
    proposedSlices: [],
    blockingQuestions,
  });
}

export function parseTaskOrchestrationDraft(taskText) {
  const lines = String(taskText || '').split('\n');
  const tasks = [];
  let current = null;

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    const taskMatch = line.match(/^- \[([ xX])\]\s+\*\*\[([^\]]+)\]\*\*\s+(.+)$/);
    if (taskMatch) {
      if (current) tasks.push(current);
      current = {
        id: taskMatch[2],
        title: taskMatch[3],
        description: '',
        acceptanceCriteria: [],
        dependencies: [],
        files: [],
        steps: [],
        type: 'implementation',
        status: String(taskMatch[1]).toLowerCase() === 'x' ? 'completed' : 'pending',
      };
      return;
    }

    if (!current) return;
    if (/^- 描述[:：]/.test(line)) {
      current.description = line.replace(/^- 描述[:：]\s*/, '');
    } else if (/^- 产出[:：]/.test(line)) {
      current.steps.push(`产出：${line.replace(/^- 产出[:：]\s*/, '')}`);
    } else if (/^- 依赖[:：]/.test(line)) {
      const depText = line.replace(/^- 依赖[:：]\s*/, '').trim();
      if (depText && depText !== '无') {
        current.dependencies = depText.split(/[，,、]/).map((item) => item.trim()).filter(Boolean);
      }
    } else if (/^- 验收[:：]/.test(line)) {
      current.acceptanceCriteria.push(line.replace(/^- 验收[:：]\s*/, ''));
    }
  });

  if (current) tasks.push(current);

  return createTaskGraph({
    tasks: tasks.map((task, index) => createTaskNode({
      ...task,
      id: task.id || `draft-task-${index + 1}`,
      goal: task.description || task.title,
      allowedChanges: { files: [], newFiles: [] },
      forbiddenChanges: { files: [], actions: [] },
    }, index)),
  });
}
