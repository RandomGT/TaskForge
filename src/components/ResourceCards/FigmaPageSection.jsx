import React from 'react';
import { useAppContext } from '../../context/AppContext';
import FigmaCard from './FigmaCard';

export default function FigmaPageSection({ pageIndex, page }) {
  const { dispatch } = useAppContext();
  const links = page.links || [];

  return (
    <div className="resource-card fade-in" style={{ borderColor: 'var(--purple, #8b5cf6)', marginBottom: 16 }}>
      <div className="resource-card-header" style={{ alignItems: 'center' }}>
        <div className="resource-card-title" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>📄 页面</span>
          <input
            className="form-input"
            style={{ maxWidth: 280, marginBottom: 0 }}
            placeholder="页面名称，如：登录页、首页、设置页"
            value={page.pageName}
            onChange={(e) =>
              dispatch({ type: 'UPDATE_FIGMA_PAGE_NAME', pageIndex, value: e.target.value })
            }
          />
        </div>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => dispatch({ type: 'REMOVE_FIGMA_PAGE', pageIndex })}
        >
          移除页面
        </button>
      </div>
      <div className="form-hint" style={{ marginBottom: 12 }}>
        同一产品页面下的多条 Figma 链接放在这里；拆分任务时会在<strong>拆分 Prompt</strong>里按页面聚合全部 URL，不会在每一个子任务 Prompt 里重复整表。
      </div>
      {links.map((link, li) => (
        <FigmaCard
          key={li}
          pageIndex={pageIndex}
          linkIndex={li}
          data={link}
          label={`${page.pageName?.trim() || `页面 ${pageIndex + 1}`} · 稿 ${li + 1}`}
        />
      ))}
      <button
        type="button"
        className="add-resource-btn"
        onClick={() => dispatch({ type: 'ADD_FIGMA_LINK', pageIndex })}
      >
        <span>＋</span> 在此页面下添加 Figma 链接
      </button>
    </div>
  );
}
