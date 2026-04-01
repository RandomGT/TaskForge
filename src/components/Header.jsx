import React from 'react';
import { useAppContext } from '../context/AppContext';

export default function Header() {
  const { dispatch } = useAppContext();

  const resetAll = () => {
    if (!confirm('确定要重置所有内容吗？此操作不可撤销。')) return;
    localStorage.removeItem('taskforge_state');
    dispatch({ type: 'RESET' });
  };

  return (
    <header className="header">
      <div className="header-inner">
        <div className="logo">
          <img src="/logo.svg" alt="TaskForge" className="logo-icon" />
          TaskForge
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary btn-sm" onClick={resetAll}>🔄 重置</button>
        </div>
      </div>
    </header>
  );
}
