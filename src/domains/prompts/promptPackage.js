import { optimizeTask } from '../../utils/optimizer';
import { buildPromptForTask } from '../../utils/promptBuilder';
import { createPromptPackage } from '../pipeline/models';

function buildSystemPrompt(task) {
  return [
    '你是当前仓库中的受控实现代理。',
    '必须在允许范围内工作，优先复用现有组件、样式 Token 和 API 封装。',
    task?.type ? `当前任务类型: ${task.type}` : '',
  ].filter(Boolean).join('\n');
}

function buildProjectPrompt(state) {
  return [
    state.projectName ? `项目名称: ${state.projectName}` : '',
    state.projectPath ? `项目路径: ${state.projectPath}` : '',
    state.techStack?.length ? `技术栈: ${state.techStack.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function buildOutputContract(task) {
  const lines = [
    '- 先输出实施计划，再开始改代码',
    '- 说明将修改的文件、组件、函数',
    '- 完成后输出改动摘要和风险点',
  ];
  if (Array.isArray(task?.acceptanceCriteria) && task.acceptanceCriteria.length) {
    lines.push(`- 验收标准: ${task.acceptanceCriteria.join('；')}`);
  }
  return lines.join('\n');
}

function buildVerificationContract(task) {
  const lines = [
    '- 是否只修改了允许范围内的文件',
    '- 是否复用了现有实现，若未复用需说明原因',
    '- 是否存在未说明的假设',
  ];
  if (Array.isArray(task?.acceptanceCriteria) && task.acceptanceCriteria.length) {
    lines.push(`- 是否满足验收标准: ${task.acceptanceCriteria.join('；')}`);
  }
  return lines.join('\n');
}

export function composePromptTextFromPackage(pkg = {}, fallbackText = '') {
  const sections = [
    pkg.systemPrompt ? `## System\n${pkg.systemPrompt}` : '',
    pkg.projectPrompt ? `## Project\n${pkg.projectPrompt}` : '',
    pkg.taskPrompt ? `## Task\n${pkg.taskPrompt}` : '',
    pkg.outputContract ? `## Output Contract\n${pkg.outputContract}` : '',
    pkg.verificationContract ? `## Verification Contract\n${pkg.verificationContract}` : '',
  ].filter(Boolean);

  if (!sections.length) return fallbackText || '';
  return sections.join('\n\n');
}

export function buildDefaultPromptPackageForTask(task, index, state) {
  const optimizedDesc = optimizeTask(task, state);
  const fallbackPromptText = buildPromptForTask(task, index, state.templateStyle, state, optimizedDesc);
  const draft = createPromptPackage({
    taskId: task.id,
    systemPrompt: buildSystemPrompt(task),
    projectPrompt: buildProjectPrompt(state),
    taskPrompt: task.description || task.goal || task.title,
    outputContract: buildOutputContract(task),
    verificationContract: buildVerificationContract(task),
    promptText: '',
  });
  return createPromptPackage({
    ...draft,
    promptText: composePromptTextFromPackage(draft, fallbackPromptText) || fallbackPromptText,
  });
}

export function getStoredPromptPackage(taskId, state) {
  const packages = Array.isArray(state?.promptPackages) ? state.promptPackages : [];
  return packages.find((pkg) => String(pkg.taskId) === String(taskId)) || null;
}

export function getPromptPackageForTask(task, index, state) {
  const stored = getStoredPromptPackage(task.id, state);
  if (stored) {
    const fallback = buildPromptForTask(task, index, state.templateStyle, state, optimizeTask(task, state));
    return createPromptPackage({
      ...stored,
      promptText: composePromptTextFromPackage(stored, stored.promptText || fallback) || fallback,
    });
  }
  return buildDefaultPromptPackageForTask(task, index, state);
}

export function updatePromptPackageText(pkg = {}) {
  const next = createPromptPackage(pkg);
  return createPromptPackage({
    ...next,
    promptText: composePromptTextFromPackage(next, next.promptText),
  });
}

export function buildPromptPackagesForTasks(tasks = [], state) {
  return (tasks || []).map((task, index) => getPromptPackageForTask(task, index, state));
}

export function getPromptTextForTask(task, index, state) {
  return getPromptPackageForTask(task, index, state).promptText;
}
