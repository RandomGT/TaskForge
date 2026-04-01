import React from 'react';
import { useAppContext } from '../../context/AppContext';

export default function OtherResourceCard({ index, data }) {
  const { dispatch } = useAppContext();

  const update = (field, value) => {
    dispatch({ type: 'UPDATE_OTHER', index, field, value });
  };

  return (
    <div className="resource-card fade-in">
      <div className="resource-card-header">
        <div className="resource-card-title">📎 资源 #{index + 1}</div>
        <button className="btn btn-danger btn-sm" onClick={() => dispatch({ type: 'REMOVE_OTHER', index })}>删除</button>
      </div>
      <div className="form-group">
        <label className="form-label">名称</label>
        <input className="form-input" placeholder="如: 数据库设计文档" value={data.name} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">内容 / 链接</label>
        <textarea
          className="form-textarea"
          style={{ minHeight: 60 }}
          placeholder="粘贴内容或链接..."
          value={data.content}
          onChange={(e) => update('content', e.target.value)}
        />
      </div>
    </div>
  );
}
