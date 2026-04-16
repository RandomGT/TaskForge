import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import { checkHealth, listProjectFiles } from '../utils/aiService';
import { buildPersistableState } from '../utils/persistState';
import { createJob, updateJob } from '../utils/jobApi';

export default function Step1Requirement() {
  const { state, dispatch, showToast } = useAppContext();
  const navigate = useNavigate();
  const tagInputRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  // Check server health on mount
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const online = await checkHealth();
      if (cancelled) return;
      dispatch({ type: 'SET_SERVER_ONLINE', online });
    };
    check();
    return () => { cancelled = true; };
  }, []);

  // Load project files when path changes
  useEffect(() => {
    if (!state.projectPath.trim() || !state.serverOnline) return;
    const timer = setTimeout(async () => {
      const files = await listProjectFiles(state.projectPath);
      dispatch({ type: 'SET_PROJECT_FILES', files });
    }, 500);
    return () => clearTimeout(timer);
  }, [state.projectPath, state.serverOnline]);

  const shakeElement = useCallback((el) => {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetHeight;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 1000);
  }, []);

  const goNext = async () => {
    if (!state.projectPath.trim()) {
      shakeElement(document.getElementById('projectPath'));
      showToast('⚠️ 请先填写项目路径');
      return;
    }
    if (!state.projectName.trim()) {
      shakeElement(document.getElementById('projectName'));
      return;
    }
    if (!state.requirementDesc.trim()) {
      shakeElement(document.getElementById('requirementDesc'));
      return;
    }

    const payload = buildPersistableState(state);
    payload.currentStep = 2;

    if (state.currentJobId) {
      dispatch({ type: 'SET_STEP', step: 2 });
      try {
        await updateJob(state.currentJobId, payload);
      } catch (e) {
        showToast(`⚠️ 保存失败: ${e.message || '请确认后端已启动'}`);
      }
      return;
    }

    setSubmitting(true);
    try {
      const { id } = await createJob(payload);
      dispatch({ type: 'SET_JOB_ID', id });
      dispatch({ type: 'SET_STEP', step: 2 });
      showToast('✅ 已创建任务并保存');
      navigate(`/wizard/${id}`, { replace: true });
    } catch (e) {
      showToast(`❌ 创建任务失败: ${e.message || '请确认后端已启动 (npm start)'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      e.preventDefault();
      dispatch({ type: 'ADD_TECH_TAG', tag: e.target.value.trim() });
      e.target.value = '';
    }
    if (e.key === 'Backspace' && !e.target.value) {
      dispatch({ type: 'POP_TECH_TAG' });
    }
  };

  return (
    <div className="step-content active fade-in">
      <div className="ai-config-section">
        <div className="resource-section-title" style={{ marginBottom: 12 }}>
          📂 项目与连接
          {!state.serverOnline && (
            <span className="server-badge offline">● 服务离线</span>
          )}
          {state.serverOnline && (
            <span className="server-badge online">● 已连接</span>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">项目路径 <span className="required">*</span></label>
          <input
            className="form-input mono-input"
            id="projectPath"
            placeholder="/home/user/my-project"
            value={state.projectPath}
            onChange={(e) => dispatch({ type: 'SET_PROJECT_PATH', path: e.target.value })}
          />
          <div className="form-hint">
            {state.projectFiles.length > 0
              ? `📁 已扫描到 ${state.projectFiles.length} 个文件`
              : '输入你要让 AI 操作的项目根目录绝对路径'}
          </div>
          {!state.serverOnline && (
            <div className="form-hint" style={{ color: 'var(--orange)' }}>
              ⚠️ 后端服务未启动。请先运行: <code>node server.js</code>
            </div>
          )}
        </div>
      </div>

      <div className="section-divider" />

      {/* Original requirement fields */}
      <div className="form-group">
        <label className="form-label">项目名称 <span className="required">*</span></label>
        <input
          className="form-input"
          id="projectName"
          placeholder="例: 用户管理模块"
          value={state.projectName}
          onChange={(e) => dispatch({ type: 'SET_FIELD', field: 'projectName', value: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label className="form-label">需求描述 <span className="required">*</span></label>
        <textarea
          className="form-textarea"
          id="requirementDesc"
          placeholder={"详细描述你的需求，越详细拆分越精准...\n\n例：实现一个用户管理页面，包含用户列表（支持搜索、分页）、新增用户弹窗（表单验证）、编辑用户和删除用户功能。需要对接后端 RESTful API。"}
          style={{ minHeight: 200 }}
          value={state.requirementDesc}
          onChange={(e) => dispatch({ type: 'SET_FIELD', field: 'requirementDesc', value: e.target.value })}
        />
        <div className="form-hint">💡 描述功能点、交互逻辑、页面结构等，AI 会据此拆分任务</div>
      </div>
      <div className="form-group">
        <label className="form-label">技术栈</label>
        <div
          className="tags-input-wrapper"
          onClick={() => tagInputRef.current?.focus()}
        >
          {state.techStack.map((tag, i) => (
            <span key={i} className="tag tag-other">
              {tag}
              <span className="tag-remove" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REMOVE_TECH_TAG', index: i }); }}>×</span>
            </span>
          ))}
          <input
            className="tags-input"
            ref={tagInputRef}
            placeholder="输入后按回车添加，如 React, TypeScript, Tailwind..."
            onKeyDown={handleTagKeyDown}
          />
        </div>
        <div className="form-hint">按 Enter 添加标签，常用: React, Vue, TypeScript, Tailwind CSS, Next.js</div>
      </div>
      <div className="form-group">
        <label className="form-label">补充说明</label>
        <textarea
          className="form-textarea"
          placeholder="项目背景、设计规范、注意事项..."
          style={{ minHeight: 80 }}
          value={state.extraNotes}
          onChange={(e) => dispatch({ type: 'SET_FIELD', field: 'extraNotes', value: e.target.value })}
        />
      </div>

      <div className="step-nav">
        <div></div>
        <button className="btn btn-primary" onClick={goNext} disabled={submitting}>
          {submitting ? '创建并保存…' : '下一步: 资源配置 →'}
        </button>
      </div>
    </div>
  );
}
