import React, { useState, useEffect, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { getFigmaFlatList } from '../utils/figmaPages';

export default function TaskEditModal() {
  const { state, dispatch } = useAppContext();
  const { modalVisible, editingTaskIndex } = state;
  const figmaFlat = useMemo(() => getFigmaFlatList(state.figmaPages), [state.figmaPages]);
  const task = editingTaskIndex >= 0 && editingTaskIndex < state.tasks.length ? state.tasks[editingTaskIndex] : null;
  const intents = state.intentGraph?.intents || [];

  const [type, setType] = useState('implementation');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [description, setDescription] = useState('');
  const [extra, setExtra] = useState('');
  const [prompt, setPrompt] = useState('');
  const [filesText, setFilesText] = useState('');
  const [newFilesText, setNewFilesText] = useState('');
  const [forbiddenFilesText, setForbiddenFilesText] = useState('');
  const [forbiddenActionsText, setForbiddenActionsText] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [acceptanceText, setAcceptanceText] = useState('');
  const [intentIds, setIntentIds] = useState([]);
  const [figmaIds, setFigmaIds] = useState([]);
  const [apiIds, setApiIds] = useState([]);
  const [imageIds, setImageIds] = useState([]);

  useEffect(() => {
    if (task) {
      setType(task.type || 'implementation');
      setTitle(task.title || '');
      setGoal(task.goal || '');
      setDescription(task.description || '');
      setExtra(task.extra || '');
      setPrompt(task.prompt || '');
      setFilesText((task.allowedChanges?.files || task.files || []).join('\n'));
      setNewFilesText((task.allowedChanges?.newFiles || []).join('\n'));
      setForbiddenFilesText((task.forbiddenChanges?.files || []).join('\n'));
      setForbiddenActionsText((task.forbiddenChanges?.actions || []).join('\n'));
      setStepsText((task.steps || []).join('\n'));
      setAcceptanceText((task.acceptanceCriteria || []).join('\n'));
      setIntentIds(task.intentIds || []);
      setFigmaIds(task.figmaIds || []);
      setApiIds(task.apiIds || []);
      setImageIds(task.imageIds || []);
    }
  }, [task]);

  const handleClose = () => {
    dispatch({ type: 'CLOSE_MODAL' });
  };

  const handleSave = () => {
    if (editingTaskIndex < 0) return;
    const files = filesText.split('\n').map(s => s.trim()).filter(Boolean);
    const newFiles = newFilesText.split('\n').map(s => s.trim()).filter(Boolean);
    const forbiddenFiles = forbiddenFilesText.split('\n').map(s => s.trim()).filter(Boolean);
    const forbiddenActions = forbiddenActionsText.split('\n').map(s => s.trim()).filter(Boolean);
    const steps = stepsText.split('\n').map(s => s.trim()).filter(Boolean);
    const acceptanceCriteria = acceptanceText.split('\n').map(s => s.trim()).filter(Boolean);
    dispatch({
      type: 'UPDATE_TASK',
      index: editingTaskIndex,
      data: {
        type,
        title,
        goal,
        description,
        extra,
        prompt,
        files,
        steps,
        intentIds,
        acceptanceCriteria,
        allowedChanges: { files, newFiles },
        forbiddenChanges: { files: forbiddenFiles, actions: forbiddenActions },
        figmaIds,
        apiIds,
        imageIds,
      }
    });
    handleClose();
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) handleClose();
  };

  const handleMultiSelect = (e, setter) => {
    const selected = Array.from(e.target.selectedOptions).map(o => parseInt(o.value));
    setter(selected);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && modalVisible) {
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [modalVisible]);

  return (
    <div
      className={`modal-overlay${modalVisible ? ' visible' : ''}`}
      onClick={handleOverlayClick}
    >
      <div className="modal" style={{ width: 640 }}>
        <div className="modal-header">
          <div className="modal-title">
            {editingTaskIndex >= 0 ? `编辑任务 #${editingTaskIndex + 1}` : '编辑任务'}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={handleClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="intent-card-row">
            <div className="form-group">
              <label className="form-label">任务类型</label>
              <select className="form-select" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="implementation">通用实现</option>
                <option value="ui_implementation">UI 实现</option>
                <option value="api_integration">接口接入</option>
                <option value="component_extraction">组件抽取</option>
                <option value="bug_fix">问题修复</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">任务目标</label>
              <input className="form-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="这个任务要交付什么结果" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">任务标题</label>
            <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">任务描述</label>
            <textarea className="form-textarea" style={{ minHeight: 100 }} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {intents.length > 0 && (
            <div className="form-group">
              <label className="form-label">关联意图</label>
              <select
                className="form-select"
                multiple
                style={{ minHeight: 100 }}
                value={intentIds}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setIntentIds(selected);
                }}
              >
                {intents.map((intent) => (
                  <option key={intent.id} value={intent.id}>
                    {intent.type} · {intent.title}
                  </option>
                ))}
              </select>
              <div className="form-hint">按住 Ctrl/Cmd 多选，用来标记该任务服务于哪些意图。</div>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">验收标准 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（每行一个）</span></label>
            <textarea
              className="form-textarea"
              style={{ minHeight: 90 }}
              placeholder="例如：筛选条件会驱动列表查询"
              value={acceptanceText}
              onChange={(e) => setAcceptanceText(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">允许修改范围 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（每行一个路径/Glob）</span></label>
            <textarea
              className="form-textarea mono-input"
              style={{ minHeight: 60 }}
              placeholder="src/components/UserList.jsx&#10;src/pages/user-list/**"
              value={filesText}
              onChange={(e) => setFilesText(e.target.value)}
            />
          </div>
          <div className="intent-card-row">
            <div className="form-group">
              <label className="form-label">允许新增文件 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（每行一个）</span></label>
              <textarea
                className="form-textarea mono-input"
                style={{ minHeight: 60 }}
                placeholder="src/pages/user-list/components/*.jsx"
                value={newFilesText}
                onChange={(e) => setNewFilesText(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">禁止修改文件 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（每行一个）</span></label>
              <textarea
                className="form-textarea mono-input"
                style={{ minHeight: 60 }}
                placeholder="src/core/**"
                value={forbiddenFilesText}
                onChange={(e) => setForbiddenFilesText(e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">禁止事项 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（每行一个）</span></label>
            <textarea
              className="form-textarea"
              style={{ minHeight: 70 }}
              placeholder="不要顺手重构无关模块"
              value={forbiddenActionsText}
              onChange={(e) => setForbiddenActionsText(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">执行步骤 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（每行一个步骤）</span></label>
            <textarea
              className="form-textarea"
              style={{ minHeight: 60 }}
              placeholder="创建组件文件&#10;实现列表渲染逻辑&#10;对接 API"
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">AI 执行 Prompt <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（发给 AI CLI 的完整指令）</span></label>
            <textarea
              className="form-textarea mono-input"
              style={{ minHeight: 120 }}
              placeholder="详细的 AI 执行指令..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {figmaFlat.length > 0 && (
            <div className="form-group">
              <label className="form-label">关联 Figma（按页面扁平索引）</label>
              <select
                className="form-select"
                multiple
                style={{ minHeight: 80 }}
                value={figmaIds.map(String)}
                onChange={(e) => handleMultiSelect(e, setFigmaIds)}
              >
                {figmaFlat.map((f, fi) => (
                  <option key={fi} value={fi}>
                    {[f.pageName, f.name || `链接 ${fi + 1}`].filter(Boolean).join(' · ')}
                  </option>
                ))}
              </select>
              <div className="form-hint">按住 Ctrl/Cmd 多选；全量 URL 仅在任务 1 与拆分 Prompt 中聚合</div>
            </div>
          )}
          {state.apiResources.length > 0 && (
            <div className="form-group">
              <label className="form-label">关联接口</label>
              <select
                className="form-select"
                multiple
                style={{ minHeight: 60 }}
                value={apiIds.map(String)}
                onChange={(e) => handleMultiSelect(e, setApiIds)}
              >
                {state.apiResources.map((a, ai) => (
                  <option key={ai} value={ai}>{a.name || `${a.method} ${a.path}` || `接口 #${ai + 1}`}</option>
                ))}
              </select>
            </div>
          )}
          {state.imageResources.length > 0 && (
            <div className="form-group">
              <label className="form-label">关联切图</label>
              <select
                className="form-select"
                multiple
                style={{ minHeight: 60 }}
                value={imageIds.map(String)}
                onChange={(e) => handleMultiSelect(e, setImageIds)}
              >
                {state.imageResources.map((m, mi) => (
                  <option key={mi} value={mi}>{m.name || `切图 #${mi + 1}`}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">额外提示</label>
            <textarea
              className="form-textarea"
              style={{ minHeight: 60 }}
              placeholder="该任务的额外指令或注意事项..."
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  );
}
