import React from 'react';
import { useAppContext } from '../../context/AppContext';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export default function ApiCard({ index, data }) {
  const { dispatch } = useAppContext();

  const update = (field, value) => {
    dispatch({ type: 'UPDATE_API', index, field, value });
  };

  return (
    <div className="resource-card fade-in">
      <div className="resource-card-header">
        <div className="resource-card-title">🔌 接口 #{index + 1}</div>
        <button className="btn btn-danger btn-sm" onClick={() => dispatch({ type: 'REMOVE_API', index })}>删除</button>
      </div>
      <div className="form-group">
        <label className="form-label">接口名称</label>
        <input className="form-input" placeholder="如: 获取用户列表" value={data.name} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 10 }}>
        <div className="form-group">
          <label className="form-label">方法</label>
          <select className="form-select" value={data.method} onChange={(e) => update('method', e.target.value)}>
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">路径</label>
          <input className="form-input" placeholder="/api/v1/users" value={data.path} onChange={(e) => update('path', e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">说明</label>
        <input className="form-input" placeholder="接口功能描述" value={data.description} onChange={(e) => update('description', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">请求体示例（可选）</label>
        <textarea
          className="form-textarea"
          style={{ minHeight: 60, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
          placeholder='{ "username": "string", "email": "string" }'
          value={data.requestBody}
          onChange={(e) => update('requestBody', e.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="form-label">响应体示例（可选）</label>
        <textarea
          className="form-textarea"
          style={{ minHeight: 60, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
          placeholder='{ "code": 0, "data": { "list": [], "total": 0 } }'
          value={data.responseBody}
          onChange={(e) => update('responseBody', e.target.value)}
        />
      </div>
    </div>
  );
}
