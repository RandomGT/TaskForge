/** 按「页面」分组的 Figma 录入；扁平索引用于任务关联 figmaIds */

export function emptyFigmaLink() {
  return { name: '', url: '', nodeId: '', description: '' };
}

export function normalizeFigmaPagesFromLegacy(loaded) {
  if (loaded?.figmaPages?.length) {
    return loaded.figmaPages.map((p) => ({
      pageName: p.pageName ?? '',
      links: Array.isArray(p.links)
        ? p.links.map((l) => ({ ...emptyFigmaLink(), ...l }))
        : [],
    }));
  }
  if (loaded?.figmaResources?.length) {
    return [
      {
        pageName: '未命名页面',
        links: loaded.figmaResources.map((l) => ({ ...emptyFigmaLink(), ...l })),
      },
    ];
  }
  return [{ pageName: '', links: [emptyFigmaLink()] }];
}

export function getFigmaFlatList(figmaPages) {
  const out = [];
  (figmaPages || []).forEach((page, pageIndex) => {
    (page.links || []).forEach((link, linkIndex) => {
      out.push({
        pageIndex,
        linkIndex,
        pageName: page.pageName || '',
        name: link.name || '',
        url: link.url || '',
        nodeId: link.nodeId || '',
        description: link.description || '',
      });
    });
  });
  return out;
}

function normalizeTextForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）[\]【】\-_/\\|.,，。:：;；"'`·]/g, '');
}

function buildPageAliases(page, links = []) {
  const raw = [page.pageName, ...links.map((l) => l.name), ...links.map((l) => l.description)]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  const suffixPattern = /(页面|页|首页|主页|弹窗|对话框|列表|详情|表单|面板|视图|模块)$/;
  const aliases = new Set();

  raw.forEach((item) => {
    const normalized = normalizeTextForMatch(item);
    if (!normalized) return;
    aliases.add(normalized);
    const stripped = normalized.replace(suffixPattern, '');
    if (stripped && stripped.length >= 2) aliases.add(stripped);
  });

  return [...aliases];
}

export function matchTaskToFigmaIds(task, figmaPages) {
  const text = normalizeTextForMatch(`${task?.title || ''} ${task?.description || ''} ${task?.prompt || ''}`);
  if (!text) return [];

  const flat = getFigmaFlatList(figmaPages);
  const matched = new Set();

  (figmaPages || []).forEach((page, pageIndex) => {
    const pageLinks = flat.filter((item) => item.pageIndex === pageIndex && (item.url || '').trim());
    if (!pageLinks.length) return;

    const aliases = buildPageAliases(page, page.links || []);
    const hit = aliases.some((alias) => alias && text.includes(alias));
    if (!hit) return;

    pageLinks.forEach((item) => {
      const flatIndex = flat.findIndex((candidate) =>
        candidate.pageIndex === item.pageIndex && candidate.linkIndex === item.linkIndex
      );
      if (flatIndex >= 0) matched.add(flatIndex);
    });
  });

  return [...matched];
}

export function assignFigmaIdsToTasks(tasks, figmaPages) {
  const validPages = (figmaPages || []).filter((page) =>
    (page.links || []).some((link) => (link.url || '').trim())
  );

  if (!validPages.length) return tasks;

  return (tasks || []).map((task) => {
    const existing = Array.isArray(task.figmaIds) ? task.figmaIds.filter(Number.isInteger) : [];
    if (existing.length) return task;

    const matched = matchTaskToFigmaIds(task, figmaPages);
    if (matched.length) {
      return { ...task, figmaIds: matched };
    }

    if (validPages.length === 1) {
      const fallbackIds = getFigmaFlatList(figmaPages)
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (item.url || '').trim())
        .map(({ index }) => index);
      return { ...task, figmaIds: fallbackIds };
    }

    return task;
  });
}

export function countFigmaLinks(figmaPages) {
  return getFigmaFlatList(figmaPages).length;
}

export function hasAnyFigmaLink(figmaPages) {
  return getFigmaFlatList(figmaPages).some((l) => (l.url || '').trim());
}

/**
 * 任务拆分阶段专用：聚合所有页面的 Figma URL（不向每个子任务 Prompt 重复整表）
 */
export function formatFigmaPagesForSplitPrompt(figmaPages) {
  if (!hasAnyFigmaLink(figmaPages)) return '';
  const lines = [
    '## 页面级 Figma 设计稿（按页面聚合 · 全量清单仅出现在本节）',
    '',
    '以下按 **产品页面 / 画板维度** 分组。同一分组下的多条链接归属于 **同一业务页面**。',
    '',
    '**拆分约定**：',
    '- 生成 JSON 时，各任务的 `description` / `prompt` 中请用 **页面名称 + 画板说明** 指引实现，**不要**在每个任务的 `prompt` 里重复粘贴本节全部 URL（避免冗长）。',
    '- 实现阶段可通过 **页面名** 在任务 1 的完整提示词或 Figma MCP 中对齐设计稿。',
    '',
  ];
  for (const p of figmaPages || []) {
    const links = (p.links || []).filter((l) => (l.url || '').trim());
    if (!links.length && !(p.pageName || '').trim()) continue;
    const title = (p.pageName || '').trim() || '（未命名页面）';
    lines.push(`### 页面：${title}`);
    links.forEach((l, i) => {
      lines.push(`- **${l.name || `设计稿 ${i + 1}`}**`);
      lines.push(`  - URL: ${l.url.trim()}`);
      if ((l.nodeId || '').trim()) {
        lines.push(
          `  - Node ID: \`${l.nodeId.trim()}\`（来自 URL 时请将 node-id 中的 \`-\` 转为 \`:\`）`,
        );
      }
      if ((l.description || '').trim()) {
        lines.push(`  - 说明: ${l.description.trim()}`);
      }
    });
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
