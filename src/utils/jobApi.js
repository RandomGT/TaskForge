import { buildPersistableState } from './persistState';

const API_BASE = 'http://localhost:3721/api';

export async function fetchJobList({ q = '', offset = 0, limit = 30 } = {}) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (q.trim()) params.set('q', q.trim());
  const res = await fetch(`${API_BASE}/jobs?${params}`);
  if (!res.ok) throw new Error(`列表加载失败: ${res.status}`);
  return res.json();
}

export async function fetchJob(id) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`任务加载失败: ${res.status}`);
  return res.json();
}

export async function createJob(state) {
  const res = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`创建任务失败: ${res.status}`);
  return res.json();
}

export async function updateJob(id, state, options = {}) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
    keepalive: Boolean(options.keepalive),
  });
  if (!res.ok) throw new Error(`保存失败: ${res.status}`);
  return res.json();
}

export async function persistJobState(id, state, overrides = {}, options = {}) {
  if (!id) {
    throw new Error('缺少任务 ID，无法保存');
  }
  const payload = {
    ...buildPersistableState(state),
    ...overrides,
  };
  await updateJob(id, payload, options);
  return payload;
}

export async function deleteJob(id) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`删除失败: ${res.status}`);
  return res.json();
}
