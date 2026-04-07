import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import { deleteJob } from '../utils/jobApi';

export default function Header() {
  const { state, dispatch, showToast } = useAppContext();
  const navigate = useNavigate();

  const resetAll = async () => {
    if (!confirm('确定要重置所有内容吗？此操作不可撤销。')) return;
    const hadJob = Boolean(state.currentJobId);
    const jobId = state.currentJobId;
    if (jobId) {
      try {
        await deleteJob(jobId);
      } catch {
        showToast('⚠️ 删除服务端记录失败，仍将清空当前界面');
      }
    }
    dispatch({ type: 'RESET' });
    navigate(hadJob ? '/' : '/wizard/new', { replace: true });
  };

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo" style={{ textDecoration: 'none', color: 'inherit' }}>
          <img src="/assets/logo2.png" alt="TaskForge" className="logo-icon" />
          TaskForge
        </Link>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
            ← 任务列表
          </Link>
          <button type="button" className="btn btn-secondary btn-sm" onClick={resetAll}>🔄 重置</button>
        </div>
      </div>
    </header>
  );
}
