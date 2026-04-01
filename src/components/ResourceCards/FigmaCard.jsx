import React from 'react';
import { useAppContext } from '../../context/AppContext';

export default function FigmaCard({ pageIndex, linkIndex, data, label }) {
  const { dispatch } = useAppContext();

  const update = (field, value) => {
    dispatch({ type: 'UPDATE_FIGMA_LINK', pageIndex, linkIndex, field, value });
  };

  return (
    <div className="resource-card fade-in">
      <div className="resource-card-header">
        <div className="resource-card-title">{label || `🎨 设计稿 #${linkIndex + 1}`}</div>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => dispatch({ type: 'REMOVE_FIGMA_LINK', pageIndex, linkIndex })}
        >
          删除
        </button>
      </div>
      <div className="form-group">
        <label className="form-label">名称</label>
        <input className="form-input" placeholder="如: 列表主界面" value={data.name} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">Figma URL</label>
        <input className="form-input" placeholder="https://www.figma.com/file/..." value={data.url} onChange={(e) => update('url', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">Node ID（可选）</label>
        <input className="form-input" placeholder="Figma 节点 ID" value={data.nodeId} onChange={(e) => update('nodeId', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">说明</label>
        <input className="form-input" placeholder="该链接覆盖的界面范围" value={data.description} onChange={(e) => update('description', e.target.value)} />
      </div>
    </div>
  );
}
