import React from 'react';
import { useAppContext } from '../../context/AppContext';

export default function ImageCard({ index, data }) {
  const { dispatch } = useAppContext();

  const update = (field, value) => {
    dispatch({ type: 'UPDATE_IMAGE', index, field, value });
  };

  return (
    <div className="resource-card fade-in">
      <div className="resource-card-header">
        <div className="resource-card-title">🖼️ 切图 #{index + 1}</div>
        <button className="btn btn-danger btn-sm" onClick={() => dispatch({ type: 'REMOVE_IMAGE', index })}>删除</button>
      </div>
      <div className="form-group">
        <label className="form-label">资源名称</label>
        <input className="form-input" placeholder="如: logo.svg, banner.png" value={data.name} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">文件路径 / URL</label>
        <input className="form-input" placeholder="/assets/images/logo.svg 或 https://..." value={data.path} onChange={(e) => update('path', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">说明</label>
        <input className="form-input" placeholder="用途、尺寸等" value={data.description} onChange={(e) => update('description', e.target.value)} />
      </div>
    </div>
  );
}
