import { hasAnyFigmaLink } from './figmaPages';

/**
 * 基于 EARS（Easy Approach to Requirements Syntax）的需求优化器
 * 参考 OpenSpec / SpecKit 方法论
 *
 * 自动将用户的模糊需求转化为结构化、可测试的规范
 */

// 主函数：对单个任务生成优化后的结构化需求
export function optimizeTask(task, state) {
  const desc = (task.description || '').trim();
  if (!desc) return '';
  
  const sections = [];
  
  // 1. 功能规范（EARS 格式）
  sections.push(generateEARSRequirements(desc, task, state));
  
  // 2. 技术约束
  const techConstraints = generateTechConstraints(state.techStack);
  if (techConstraints) sections.push(techConstraints);
  
  // 3. 资源关联约束
  const resourceConstraints = generateResourceConstraints(task, state);
  if (resourceConstraints) sections.push(resourceConstraints);
  
  // 4. 验收场景（Given/When/Then）
  sections.push(generateScenarios(desc, task, state));
  
  // 5. 质量基线
  sections.push(generateQualityBaseline());
  
  return sections.filter(s => s).join('\n\n');
}

// 将自然语言需求转化为 EARS 格式的需求规范
function generateEARSRequirements(desc, task, state) {
  const lines = ['#### 功能规范'];
  
  // 解析关键动作和对象
  const actions = extractActions(desc);
  
  if (actions.length > 0) {
    actions.forEach(action => {
      lines.push(`WHEN 用户${action.trigger}，`);
      lines.push(`the system SHALL ${action.outcome}。`);
    });
  } else {
    // 如果无法解析出明确的动作，生成通用的 EARS 格式
    lines.push(`WHEN 用户执行该功能时，`);
    lines.push(`the system SHALL ${desc}。`);
  }
  
  return lines.join('\n');
}

// 从自然语言中提取动作-结果对
function extractActions(desc) {
  const results = [];
  
  // 中文动作模式匹配
  const patterns = [
    // "点击XX按钮" -> trigger: "点击XX按钮", outcome: 后续描述
    /(?:点击|单击|双击|按下|触发)([\u4e00-\u9fff\w「」【】\u201c\u201d\u2018\u2019]+(?:按钮|链接|菜单|选项|图标))/g,
    // "输入XX" -> trigger
    /(?:输入|填写|编辑|修改)([\u4e00-\u9fff\w]+)/g,
    // "提交XX" -> trigger
    /(?:提交|发送|保存|确认|删除|创建|新增|添加|上传|下载|导入|导出)([\u4e00-\u9fff\w]*)/g,
    // "查看/浏览XX"
    /(?:查看|浏览|搜索|筛选|排序|切换|展开|收起|刷新)([\u4e00-\u9fff\w]*)/g,
  ];
  
  // 按句子拆分
  const sentences = desc.split(/[，。；,;.\n]+/).filter(s => s.trim());
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 3) continue;
    
    let matched = false;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(trimmed);
      if (match) {
        results.push({
          trigger: trimmed.slice(0, match.index + match[0].length),
          outcome: trimmed.slice(match.index + match[0].length).trim() || '完成对应操作并给予用户反馈',
        });
        matched = true;
        break;
      }
    }
    
    // 未匹配的句子，尝试通用格式
    if (!matched && trimmed.length > 5) {
      // 检查是否包含动作词
      const actionWords = ['实现', '开发', '创建', '添加', '支持', '包含', '完成', '需要', '集成', '设计', '构建', '展示', '显示', '渲染'];
      const hasAction = actionWords.some(w => trimmed.includes(w));
      
      if (hasAction) {
        results.push({
          trigger: '进入该功能模块',
          outcome: trimmed,
        });
      }
    }
  }
  
  return results;
}

// 根据技术栈生成技术约束
function generateTechConstraints(techStack) {
  if (!techStack || techStack.length === 0) return null;
  
  const lines = ['#### 技术约束'];
  
  techStack.forEach(tech => {
    const lower = tech.toLowerCase();
    if (lower.includes('typescript') || lower.includes('ts')) {
      lines.push('- SHALL 使用 TypeScript 编写，确保所有 Props、State、API 响应类型完整定义');
    }
    if (lower.includes('react')) {
      lines.push('- SHALL 使用 React 函数组件 + Hooks，禁止 class 组件');
      lines.push('- SHALL 合理拆分组件粒度，单个组件不超过 200 行');
    }
    if (lower.includes('vue')) {
      lines.push('- SHALL 使用 Vue 3 Composition API（setup 语法糖）');
    }
    if (lower.includes('tailwind')) {
      lines.push('- SHALL 使用 Tailwind CSS 工具类，避免自定义 CSS');
    }
    if (lower.includes('next')) {
      lines.push('- SHALL 遵循 Next.js App Router 约定，合理使用 Server/Client Components');
    }
    if (lower.includes('nuxt')) {
      lines.push('- SHALL 遵循 Nuxt 3 约定式路由和自动导入');
    }
  });
  
  return lines.length > 1 ? lines.join('\n') : null;
}

// 根据关联资源与工作台全局资源生成约束
function generateResourceConstraints(task, state) {
  const lines = ['#### 资源约束'];
  let hasContent = false;

  const globalFigma = hasAnyFigmaLink(state.figmaPages);
  const globalApi = (state.apiResources || []).length > 0;
  const globalImg = (state.imageResources || []).length > 0;
  const taskFigma = task.figmaIds && task.figmaIds.length > 0;
  const taskApi = task.apiIds && task.apiIds.length > 0;
  const taskImg = task.imageIds && task.imageIds.length > 0;

  if (taskFigma || globalFigma) {
    lines.push('- WHERE 存在 Figma 设计稿（含工作台登记），SHALL 通过 **Figma MCP** 读取规格后再实现 UI，并 SHALL 布局/间距/字体/颜色与稿一致（关键屏像素级偏差不超过 2px）');
    hasContent = true;
  }

  if (taskApi || globalApi) {
    lines.push('- WHEN 调用后端接口，SHALL 使用方法/路径/请求响应体与登记契约一致，禁止臆造字段');
    lines.push('- SHALL 实现完整请求生命周期：Loading → Success/Error → 用户反馈，并处理超时与 4xx/5xx');
    hasContent = true;
  }

  if (taskImg || globalImg) {
    lines.push('- SHALL 使用工作台或任务登记的切图/图标路径，保证资源可加载；位图须合适密度，矢量优先');
    hasContent = true;
  }

  return hasContent ? lines.join('\n') : null;
}

// 生成验收场景（Given/When/Then）
function generateScenarios(desc, task, state) {
  const lines = ['#### 验收场景'];
  
  // 正向场景
  lines.push('**场景 1: 正常流程**');
  lines.push('GIVEN 用户已登录且具有相应权限');
  lines.push(`WHEN 用户正常使用该功能`);
  lines.push('THEN 功能按预期执行，页面正确渲染');
  lines.push('AND 操作结果有明确的视觉反馈');
  
  // 异常场景
  lines.push('');
  lines.push('**场景 2: 异常处理**');
  
  if (task.apiIds && task.apiIds.length > 0) {
    lines.push('GIVEN 后端接口不可用或返回错误');
    lines.push('WHEN 用户执行涉及接口调用的操作');
    lines.push('THEN 系统显示友好的错误提示');
    lines.push('AND 不会导致页面崩溃或白屏');
  } else {
    lines.push('GIVEN 用户输入异常数据或执行非预期操作');
    lines.push('WHEN 系统检测到异常');
    lines.push('THEN 给出明确的错误提示并引导用户修正');
    lines.push('AND 不会导致数据丢失或页面崩溃');
  }
  
  // 边界场景
  lines.push('');
  lines.push('**场景 3: 边界情况**');
  lines.push('GIVEN 数据为空或数据量极大时');
  lines.push('WHEN 用户访问该功能');
  lines.push('THEN 空数据显示占位提示，大数据量有分页或虚拟滚动');
  
  return lines.join('\n');
}

// 质量基线
function generateQualityBaseline() {
  return [
    '#### 质量基线',
    '- SHALL 组件化设计，可复用、可测试',
    '- SHALL 实现 Loading / Empty / Error 三种状态',
    '- SHALL 确保可访问性（键盘导航、ARIA 标签）',
    '- SHALL 代码可直接运行，无 TypeScript 类型错误和 ESLint 警告',
  ].join('\n');
}

// 批量优化所有任务
export function optimizeAllTasks(tasks, state) {
  const result = {};
  tasks.forEach(task => {
    result[task.id] = optimizeTask(task, state);
  });
  return result;
}
