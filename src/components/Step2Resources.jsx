import React from 'react';
import { useAppContext } from '../context/AppContext';
import FigmaPageSection from './ResourceCards/FigmaPageSection';
import ApiCard from './ResourceCards/ApiCard';
import ImageCard from './ResourceCards/ImageCard';
import OtherResourceCard from './ResourceCards/OtherResourceCard';

export default function Step2Resources() {
  const { state, dispatch } = useAppContext();

  return (
    <div className="step-content active fade-in">
      {/* Figma MCP — 按页面分组 */}
      <div className="resource-section">
        <div className="resource-section-title">🎨 Figma MCP 设计稿（按页面）</div>
        <div className="form-hint" style={{ marginBottom: 14 }}>
          每个「页面」可填多条设计链接；AI <strong>拆分任务</strong>时会收到<strong>所有页面</strong>的完整 Figma 清单。子任务执行时的 Prompt 仅在**任务 1**附带全量链接表，其余任务用页面名引用即可。
        </div>
        {state.figmaPages.map((page, i) => (
          <FigmaPageSection key={i} pageIndex={i} page={page} />
        ))}
        <button type="button" className="add-resource-btn" onClick={() => dispatch({ type: 'ADD_FIGMA_PAGE' })}>
          <span>＋</span> 添加新页面分组
        </button>
      </div>

      {/* API Endpoints */}
      <div className="resource-section">
        <div className="resource-section-title">🔌 后端服务接口</div>
        {state.apiResources.map((a, i) => (
          <ApiCard key={i} index={i} data={a} />
        ))}
        <button className="add-resource-btn" onClick={() => dispatch({ type: 'ADD_API' })}>
          <span>＋</span> 添加接口
        </button>
        <div className="form-hint" style={{ marginTop: 8 }}>支持手动输入或粘贴 Swagger/OpenAPI JSON URL</div>
      </div>

      {/* Image Assets */}
      <div className="resource-section">
        <div className="resource-section-title">🖼️ 切图 / 静态资源</div>
        {state.imageResources.map((m, i) => (
          <ImageCard key={i} index={i} data={m} />
        ))}
        <button className="add-resource-btn" onClick={() => dispatch({ type: 'ADD_IMAGE' })}>
          <span>＋</span> 添加切图资源
        </button>
      </div>

      {/* Other Resources */}
      <div className="resource-section">
        <div className="resource-section-title">📎 其他资源</div>
        {state.otherResources.map((r, i) => (
          <OtherResourceCard key={i} index={i} data={r} />
        ))}
        <button className="add-resource-btn" onClick={() => dispatch({ type: 'ADD_OTHER' })}>
          <span>＋</span> 添加其他资源
        </button>
      </div>

      <div className="step-nav">
        <button className="btn btn-secondary" onClick={() => dispatch({ type: 'SET_STEP', step: 1 })}>← 上一步</button>
        <button className="btn btn-primary" onClick={() => dispatch({ type: 'SET_STEP', step: 3 })}>下一步: 任务拆分 →</button>
      </div>
    </div>
  );
}
