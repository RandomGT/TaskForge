import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import { fetchJobList } from '../utils/jobApi';

const STEP_LABELS = ['', '需求 & AI 配置', '资源配置', '智能拆分', 'Prompt & 执行'];
const PAGE_SIZE = 24;

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(iso);
  }
}

export default function TaskListPage() {
  const navigate = useNavigate();
  const { showToast } = useAppContext();
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [jobs, setJobs] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef(null);
  const listVersionRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const runFetch = useCallback(
    async (params, version) => {
      try {
        return await fetchJobList(params);
      } catch (e) {
        if (listVersionRef.current === version) {
          showToast('❌ 无法加载任务列表，请确认后端已启动 (node server.js)');
        }
        throw e;
      }
    },
    [showToast],
  );

  useEffect(() => {
    listVersionRef.current += 1;
    const v = listVersionRef.current;
    setLoading(true);
    setJobs([]);
    setOffset(0);
    setHasMore(true);

    runFetch({ q: debouncedQ, offset: 0, limit: PAGE_SIZE }, v)
      .then((data) => {
        if (listVersionRef.current !== v) return;
        setJobs(data.jobs || []);
        setHasMore(Boolean(data.hasMore));
        setOffset((data.jobs || []).length);
      })
      .catch(() => {
        if (listVersionRef.current !== v) return;
        setJobs([]);
        setHasMore(false);
      })
      .finally(() => {
        if (listVersionRef.current !== v) return;
        setLoading(false);
      });
  }, [debouncedQ, runFetch]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading || loadingMore) return;
    const nextOffset = offset;
    setLoadingMore(true);
    const v = listVersionRef.current;
    runFetch({ q: debouncedQ, offset: nextOffset, limit: PAGE_SIZE }, v)
      .then((data) => {
        if (listVersionRef.current !== v) return;
        const rows = data.jobs || [];
        setJobs((prev) => [...prev, ...rows]);
        setHasMore(Boolean(data.hasMore));
        setOffset((prev) => prev + rows.length);
      })
      .catch(() => {
        if (listVersionRef.current !== v) return;
        setHasMore(false);
      })
      .finally(() => {
        if (listVersionRef.current !== v) return;
        setLoadingMore(false);
      });
  }, [debouncedQ, hasMore, loading, loadingMore, offset, runFetch]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || loadingMore) return;

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '160px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, loadingMore, loadMore]);

  return (
    <div className="task-list-page">
      <header className="header">
        <div className="header-inner">
          <Link to="/" className="logo" style={{ textDecoration: 'none', color: 'inherit' }}>
            <img src="/assets/logo2.png" alt="TaskForge" className="logo-icon" />
            TaskForge
          </Link>
          <div className="header-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/wizard/new')}>
              ＋ 新建任务
            </button>
          </div>
        </div>
      </header>

      <div className="app-container" style={{ paddingTop: 8, paddingBottom: 48 }}>
        <div className="task-list-toolbar">
          <input
            type="search"
            className="form-input task-list-search"
            placeholder="搜索项目名称或需求描述…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索任务"
          />
        </div>

        {loading && jobs.length === 0 ? (
          <div className="task-list-empty">加载中…</div>
        ) : jobs.length === 0 ? (
          <div className="task-list-empty">
            {debouncedQ ? '没有匹配的任务' : '暂无任务，点击「新建任务」开始'}
          </div>
        ) : (
          <div className="task-grid">
            {jobs.map((job) => {
              const stepLabel = STEP_LABELS[job.currentStep] || `步骤 ${job.currentStep}`;
              const stats = job.taskStats || {};
              const statLine =
                stats.total > 0
                  ? `子任务 ${stats.done}/${stats.total} 完成`
                  : '尚未生成子任务';

              return (
                <button
                  key={job.id}
                  type="button"
                  className="task-card"
                  onClick={() => navigate(`/wizard/${job.id}`)}
                >
                  <div className="task-card-title">{job.projectName || '未命名项目'}</div>
                  <div className="task-card-step">{stepLabel}</div>
                  <p className="task-card-preview">{job.requirementPreview || '—'}</p>
                  <div className="task-card-meta">
                    <span className="task-card-stat">{statLine}</span>
                    <span className="task-card-time">{formatTime(job.updatedAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {loadingMore && <div className="task-list-loading-more">加载更多…</div>}
        {!loading && hasMore && jobs.length > 0 && (
          <div ref={sentinelRef} className="task-list-sentinel" aria-hidden />
        )}
      </div>
    </div>
  );
}
