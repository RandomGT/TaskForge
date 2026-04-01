function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function pickSectionLines(lines, patterns) {
  const section = [];
  let inSection = false;

  for (const line of lines) {
    const hit = patterns.some((pattern) => pattern.test(line));
    const looksLikeNewSection = /^(#+\s|【|[A-Z][A-Za-z ]+:|[-*]\s)/.test(line) && !hit;

    if (hit) {
      inSection = true;
      continue;
    }
    if (inSection && looksLikeNewSection && section.length) {
      break;
    }
    if (inSection) {
      section.push(line.replace(/^[-*]\s*/, ''));
    }
  }

  return section;
}

export function parseExecutionOutput(output, task = {}) {
  const lines = splitLines(output);
  const risks = [
    ...pickSectionLines(lines, [/风险/i, /risk/i, /待确认/i]),
  ];
  const assumptions = [
    ...pickSectionLines(lines, [/假设/i, /assumption/i, /前提/i]),
  ];
  const manualChecks = [
    ...pickSectionLines(lines, [/人工验证/i, /manual/i, /测试建议/i, /验证项/i]),
  ];

  const acceptanceCriteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
  const satisfiedCriteria = acceptanceCriteria.filter((criteria) =>
    lines.some((line) => line.includes(criteria.slice(0, Math.min(criteria.length, 8))))
  );
  const unresolvedCriteria = acceptanceCriteria.filter((criteria) => !satisfiedCriteria.includes(criteria));

  const summaryLine = lines.find((line) => /改动摘要|summary|已完成|完成了|done/i.test(line)) || lines[0] || '';

  return {
    summary: summaryLine,
    risks: [...new Set(risks)].slice(0, 8),
    assumptions: [...new Set(assumptions)].slice(0, 8),
    manualChecks: [...new Set(manualChecks)].slice(0, 8),
    satisfiedCriteria,
    unresolvedCriteria,
  };
}
