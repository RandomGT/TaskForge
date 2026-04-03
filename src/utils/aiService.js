/**
 * AI Service - 与后端 API 通信，调用 Claude/Cursor CLI
 */

const API_BASE = 'http://localhost:3721/api';

// Check server health
export async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Get available engines
export async function getEngines() {
  try {
    const res = await fetch(`${API_BASE}/engines`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return data.engines || [];
  } catch {
    return [];
  }
}

// List project files
export async function listProjectFiles(projectPath) {
  try {
    const res = await fetch(`${API_BASE}/ls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.files || [];
  } catch {
    return [];
  }
}

export async function savePromptResources(projectPath, files) {
  const res = await fetch(`${API_BASE}/prompt-resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, files }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) detail += ` - ${body}`;
    } catch {}
    throw new Error(`保存 Prompt 资源失败: ${detail}`);
  }

  return res.json();
}

export async function createStepCheckpoint(projectPath, step) {
  const res = await fetch(`${API_BASE}/step-checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, step }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) detail += ` - ${body}`;
    } catch {}
    throw new Error(`创建步骤回退点失败: ${detail}`);
  }

  return res.json();
}

export async function rollbackToStepCheckpoint(projectPath, checkpoint) {
  const res = await fetch(`${API_BASE}/step-rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, checkpoint }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) detail += ` - ${body}`;
    } catch {}
    throw new Error(`回退步骤失败: ${detail}`);
  }

  return res.json();
}

export async function normalizeTaskOrchestration(payload) {
  const res = await fetch(`${API_BASE}/normalize-orchestration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) detail += ` - ${body}`;
    } catch {}
    throw new Error(`规范化任务编排失败: ${detail}`);
  }

  return res.json();
}

/** 读取项目 git 分支（git branch -a）与当前分支 */
export async function fetchGitBranches(projectPath) {
  const res = await fetch(`${API_BASE}/git/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.error || `HTTP ${res.status}`,
      current: '',
      branches: [],
    };
  }
  return data;
}

/**
 * 按执行前约定切换/新建分支。返回 { ok, logs, error?, current }。
 */
export async function ensureGitBranch(projectPath, checkoutTarget, newBranchName = '') {
  const res = await fetch(`${API_BASE}/git/ensure-branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      checkoutTarget,
      newBranchName: newBranchName || undefined,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `分支操作失败 HTTP ${res.status}`);
  }
  return data;
}

export async function getRecommendedSkills(payload) {
  const res = await fetch(`${API_BASE}/recommended-skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) detail += ` - ${body}`;
    } catch {}
    throw new Error(`获取推荐 Skills 失败: ${detail}`);
  }

  return res.json();
}

/**
 * 将 Skill 对应 npm 包拉取到临时目录后，写入 projectPath/.cursor/skills/（projectPath 与第一步表单一致）（SSE）
 */
export function installSkillPackages(projectPath, packages, callbacks) {
  const controller = new AbortController();

  (async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}/install-skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, packages }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        callbacks.onAborted?.();
        return;
      }
      callbacks.onError?.(`无法连接安装接口: ${err.message}`);
      return;
    }

    if (!res.ok) {
      let errText = `HTTP ${res.status}`;
      try {
        errText += ` - ${await res.text()}`;
      } catch {}
      callbacks.onError?.(errText);
      return;
    }

    if (!res.body) {
      callbacks.onError?.('后端响应没有 body');
      return;
    }

    let receivedDoneOrError = false;
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6);
            try {
              const data = JSON.parse(raw);
              switch (eventType) {
                case 'status':
                  callbacks.onStatus?.(data.message);
                  break;
                case 'chunk':
                  callbacks.onChunk?.(data.text);
                  break;
                case 'done':
                  receivedDoneOrError = true;
                  callbacks.onDone?.(data.output || '');
                  break;
                case 'error':
                  receivedDoneOrError = true;
                  callbacks.onError?.(data.message || 'npm 安装失败', data.stderr);
                  break;
                default:
                  break;
              }
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (!receivedDoneOrError && !controller.signal.aborted) {
        callbacks.onError?.('安装流意外结束，未收到完成事件');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        callbacks.onAborted?.();
      } else {
        callbacks.onError?.(`SSE 读取错误: ${err.message}`);
      }
    }
  })();

  return () => controller.abort();
}

/**
 * Parse SSE buffer and call appropriate callbacks
 */
function processSSEBuffer(buffer, eventType, callbacks) {
  const lines = buffer.split('\n');
  const remaining = lines.pop() || '';
  let currentEventType = eventType;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      const raw = line.slice(6);
      try {
        const data = JSON.parse(raw);
        console.log(`[aiService] SSE event: ${currentEventType}`, data);
        switch (currentEventType) {
          case 'status':
            callbacks.onStatus?.(data.message);
            break;
          case 'chunk':
            callbacks.onChunk?.(data.text);
            break;
          case 'result':
            callbacks.onResult?.(data);
            break;
          case 'raw':
            callbacks.onRaw?.(data.text);
            break;
          case 'done':
            callbacks.onDone?.(data.output);
            break;
          case 'error':
            callbacks.onError?.(data.message || 'Unknown error', data.stderr);
            break;
          default:
            console.warn(`[aiService] Unknown SSE event type: ${currentEventType}`);
        }
      } catch (e) {
        console.warn('[aiService] Failed to parse SSE data:', raw, e);
      }
    }
  }

  return { remaining, eventType: currentEventType };
}

/**
 * AI-powered task split (SSE streaming)
 */
export function aiSplitTasks(params, callbacks) {
  const controller = new AbortController();

  console.log('[aiService] aiSplitTasks called with:', params);

  (async () => {
    let res;
    try {
      console.log('[aiService] Fetching /api/split ...');
      res = await fetch(`${API_BASE}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      console.log('[aiService] /api/split response status:', res.status);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[aiService] Split request aborted');
        callbacks.onDone?.();
        return;
      }
      const msg = `无法连接后端服务 (${API_BASE}/split): ${err.message}. 请确认 node server.js 正在运行`;
      console.error('[aiService] Fetch error:', msg);
      callbacks.onError?.(msg);
      callbacks.onDone?.();
      return;
    }

    if (!res.ok) {
      const msg = `后端返回错误: HTTP ${res.status}`;
      console.error('[aiService]', msg);
      callbacks.onError?.(msg);
      callbacks.onDone?.();
      return;
    }

    if (!res.body) {
      callbacks.onError?.('后端响应没有 body (可能浏览器不支持 ReadableStream)');
      callbacks.onDone?.();
      return;
    }

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('[aiService] Split SSE stream ended');
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const result = processSSEBuffer(buffer, eventType, callbacks);
        buffer = result.remaining;
        eventType = result.eventType;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[aiService] Stream read error:', err);
        callbacks.onError?.(`SSE 读取错误: ${err.message}`);
      }
    } finally {
      callbacks.onDone?.();
    }
  })();

  return () => controller.abort();
}

export function aiOrchestrateSplit(params, callbacks) {
  const controller = new AbortController();

  (async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}/orchestrate-split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        callbacks.onDone?.();
        return;
      }
      callbacks.onError?.(`无法连接后端服务 (${API_BASE}/orchestrate-split): ${err.message}`);
      callbacks.onDone?.();
      return;
    }

    if (!res.ok) {
      callbacks.onError?.(`后端返回错误: HTTP ${res.status}`);
      callbacks.onDone?.();
      return;
    }

    if (!res.body) {
      callbacks.onError?.('后端响应没有 body');
      callbacks.onDone?.();
      return;
    }

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const result = processSSEBuffer(buffer, eventType, callbacks);
        buffer = result.remaining;
        eventType = result.eventType;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        callbacks.onError?.(`SSE 读取错误: ${err.message}`);
      }
    } finally {
      callbacks.onDone?.();
    }
  })();

  return () => controller.abort();
}

export function aiOrchestrateStage(params, callbacks) {
  const controller = new AbortController();

  (async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}/orchestrate-stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        callbacks.onDone?.();
        return;
      }
      callbacks.onError?.(`无法连接后端服务 (${API_BASE}/orchestrate-stage): ${err.message}`);
      callbacks.onDone?.();
      return;
    }

    if (!res.ok) {
      callbacks.onError?.(`后端返回错误: HTTP ${res.status}`);
      callbacks.onDone?.();
      return;
    }

    if (!res.body) {
      callbacks.onError?.('后端响应没有 body');
      callbacks.onDone?.();
      return;
    }

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const result = processSSEBuffer(buffer, eventType, callbacks);
        buffer = result.remaining;
        eventType = result.eventType;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        callbacks.onError?.(`SSE 读取错误: ${err.message}`);
      }
    } finally {
      callbacks.onDone?.();
    }
  })();

  return () => controller.abort();
}

/**
 * Execute a single task via AI CLI (SSE streaming)
 */
export function aiExecuteTask(params, callbacks) {
  const controller = new AbortController();

  console.log('[aiService] aiExecuteTask called with:', {
    engine: params.engine,
    projectPath: params.projectPath,
    taskTitle: params.task?.title,
    promptLength: params.task?.prompt?.length,
  });

  (async () => {
    let res;
    try {
      console.log('[aiService] Fetching /api/execute ...');
      res = await fetch(`${API_BASE}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      console.log('[aiService] /api/execute response status:', res.status);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[aiService] Execute request aborted');
        callbacks.onDone?.('');
        return;
      }
      const msg = `无法连接后端服务 (${API_BASE}/execute): ${err.message}. 请确认 node server.js 正在运行 (端口 3721)`;
      console.error('[aiService] Fetch error:', msg);
      callbacks.onError?.(msg);
      // NOTE: DO NOT call onDone here — onError already resolves the promise in Step5
      return;
    }

    if (!res.ok) {
      let errText = `HTTP ${res.status}`;
      try {
        const body = await res.text();
        errText += ` - ${body}`;
      } catch {}
      const msg = `后端返回错误: ${errText}`;
      console.error('[aiService]', msg);
      callbacks.onError?.(msg);
      return;
    }

    if (!res.body) {
      callbacks.onError?.('后端响应没有 body');
      return;
    }

    let receivedDone = false;

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';
      let totalChunks = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[aiService] Execute SSE stream ended. Total chunks: ${totalChunks}`);
          break;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;
        totalChunks++;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6);
            try {
              const data = JSON.parse(raw);
              console.log(`[aiService] Execute SSE event: ${eventType}`, typeof data === 'object' ? Object.keys(data) : data);
              switch (eventType) {
                case 'status':
                  callbacks.onStatus?.(data.message);
                  break;
                case 'chunk':
                  callbacks.onChunk?.(data.text);
                  break;
                case 'done':
                  receivedDone = true;
                  callbacks.onDone?.(data.output || '');
                  break;
                case 'error':
                  callbacks.onError?.(data.message || 'CLI 执行错误', data.stderr);
                  break;
              }
            } catch (e) {
              console.warn('[aiService] Failed to parse SSE data:', raw);
            }
          }
        }
      }

      // If stream ended without a done/error event, call onDone
      if (!receivedDone) {
        console.log('[aiService] Stream ended without done event, calling onDone');
        callbacks.onDone?.('');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // 用户点击停止时会 abort fetch；须回调 onDone，否则 runTaskWithCli 的 Promise 永不 resolve
        console.log('[aiService] Execute stream read aborted by user');
        if (!receivedDone) {
          callbacks.onDone?.('');
        }
        return;
      }
      console.error('[aiService] Stream read error:', err);
      callbacks.onError?.(`SSE 读取错误: ${err.message}`);
    }
  })();

  return () => controller.abort();
}
