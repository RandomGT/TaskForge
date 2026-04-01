let taskIdCounter = 0;

export function getNextTaskId() {
  return ++taskIdCounter;
}

export function setTaskIdCounter(val) {
  taskIdCounter = val;
}

export function autoSplitTasks(state) {
  const desc = state.requirementDesc;
  if (!desc.trim()) return [];

  if (state.splitStrategy === 'feature' || state.splitStrategy === 'component') {
    return splitByFunction(desc, state);
  }

  return [{
    id: getNextTaskId(),
    title: '自定义任务',
    description: '',
    figmaIds: [],
    apiIds: [],
    imageIds: [],
    extra: ''
  }];
}

function splitByFunction(desc, state) {
  const segments = desc.split(/[，。；\n,;.]/).map(s => s.trim()).filter(s => s.length > 4);

  const funcKeywords = ['实现', '开发', '创建', '添加', '支持', '包含', '需要', '完成', '对接', '集成', '设计', '构建'];
  let currentFunc = [];
  let funcGroups = [];

  segments.forEach(seg => {
    const isNewFunc = funcKeywords.some(k => seg.includes(k));
    if (isNewFunc && currentFunc.length > 0) {
      funcGroups.push([...currentFunc]);
      currentFunc = [];
    }
    currentFunc.push(seg);
  });
  if (currentFunc.length) funcGroups.push(currentFunc);

  if (funcGroups.length <= 1 && segments.length > 1) {
    funcGroups = segments.map(s => [s]);
  }

  const tasks = funcGroups.map((group) => {
    const title = group[0].length > 30 ? group[0].slice(0, 30) + '...' : group[0];
    return {
      id: getNextTaskId(),
      title: title,
      description: group.join('；'),
      figmaIds: [],
      apiIds: [],
      imageIds: [],
      extra: ''
    };
  });

  if (tasks.length === 0) {
    return [{
      id: getNextTaskId(),
      title: state.projectName || '任务',
      description: desc,
      figmaIds: [],
      apiIds: [],
      imageIds: [],
      extra: ''
    }];
  }

  return tasks;
}
