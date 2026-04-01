import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { checkHealth, getEngines, listProjectFiles } from '../utils/aiService';

export default function Step1Requirement() {
  const { state, dispatch, showToast } = useAppContext();
  const tagInputRef = useRef(null);
  const [checkingEngine, setCheckingEngine] = useState(false);
  const engineLookup = Object.fromEntries((state.availableEngines || []).map((engine) => [engine.name, engine]));

  // Check server health and available engines on mount
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      setCheckingEngine(true);
      const online = await checkHealth();
      if (cancelled) return;
      dispatch({ type: 'SET_SERVER_ONLINE', online });

      if (online) {
        const engines = await getEngines();
        if (cancelled) return;
        dispatch({ type: 'SET_AVAILABLE_ENGINES', engines });
        // Auto-select first engine if none selected
        if (!state.aiEngine && engines.length > 0) {
          dispatch({ type: 'SET_ENGINE', engine: engines[0].name });
        }
      }
      setCheckingEngine(false);
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

  const goNext = () => {
    if (!state.projectPath.trim()) {
      shakeElement(document.getElementById('projectPath'));
      showToast('⚠️ 请先填写项目路径');
      return;
    }
    if (!state.aiEngine) {
      showToast('⚠️ 请选择 AI 引擎');
      return;
    }
    const selectedEngine = engineLookup[state.aiEngine];
    if (selectedEngine?.authenticated === false) {
      showToast(`⚠️ ${selectedEngine.authMessage || '当前引擎未完成认证，暂时无法执行'}`);
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
    dispatch({ type: 'SET_STEP', step: 2 });
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

  const refreshEngines = async () => {
    setCheckingEngine(true);
    const online = await checkHealth();
    dispatch({ type: 'SET_SERVER_ONLINE', online });
    if (online) {
      const engines = await getEngines();
      dispatch({ type: 'SET_AVAILABLE_ENGINES', engines });
      if (engines.length > 0) {
        const ready = engines.filter((engine) => engine.authenticated !== false).map((engine) => engine.name);
        const blocked = engines.filter((engine) => engine.authenticated === false).map((engine) => engine.name);
        if (blocked.length > 0) {
          showToast(`⚠️ 已检测到 ${engines.map(e => e.name).join(', ')}，其中 ${blocked.join(', ')} 未认证`);
        } else {
          showToast(`✅ 检测到 ${ready.join(', ')}`);
        }
      } else {
        showToast('⚠️ 未检测到可用的 AI CLI 工具');
      }
    } else {
      showToast('❌ 后端服务未启动，请运行 node server.js');
    }
    setCheckingEngine(false);
  };

  const engineOptions = [
    { key: 'claude', icon: '🤖', name: 'Claude Code', desc: 'Anthropic Claude CLI' },
    { key: 'cursor', icon: '⚡', name: 'Cursor CLI', desc: 'Cursor Agent CLI' },
  ];

  return (
    <div className="step-content active fade-in">
      {/* AI Engine Configuration */}
      <div className="ai-config-section">
        <div className="resource-section-title" style={{ marginBottom: 12 }}>
          🧠 AI 引擎配置
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
        </div>

        <div className="form-group">
          <label className="form-label">
            选择 AI 引擎 <span className="required">*</span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8, fontSize: 12 }} onClick={refreshEngines} disabled={checkingEngine}>
              {checkingEngine ? '检测中...' : '🔄 重新检测'}
            </button>
          </label>
          <div className="engine-grid">
            {engineOptions.map(eng => {
              const engineState = engineLookup[eng.key];
              const available = Boolean(engineState);
              const authenticated = engineState?.authenticated;
              const selected = state.aiEngine === eng.key;
              return (
                <div
                  key={eng.key}
                  className={`engine-card${selected ? ' selected' : ''}${!available ? ' disabled' : ''}${authenticated === false ? ' warning' : ''}`}
                  onClick={() => {
                    if (available) {
                      dispatch({ type: 'SET_ENGINE', engine: eng.key });
                      if (authenticated === false) {
                        showToast(`⚠️ ${engineState?.authMessage || `${eng.name} 已安装，但当前未认证`}`);
                      }
                    } else {
                      showToast(`⚠️ ${eng.name} CLI 未安装或不可用`);
                    }
                  }}
                >
                  <div className="engine-icon">{eng.icon}</div>
                  <div>
                    <div className="engine-name">{eng.name}</div>
                    <div className="engine-desc">{eng.desc}</div>
                    {available && engineState?.authMessage && (
                      <div className="engine-status-text">{engineState.authMessage}</div>
                    )}
                  </div>
                  {available && authenticated === false && <span className="engine-badge auth-warning">需认证</span>}
                  {available && authenticated !== false && <span className="engine-badge available">✓ 可用</span>}
                  {!available && <span className="engine-badge unavailable">未检测到</span>}
                </div>
              );
            })}
          </div>
          {state.aiEngine && engineLookup[state.aiEngine]?.authenticated === false && (
            <div className="form-hint" style={{ color: 'var(--orange)' }}>
              ⚠️ 当前选择的引擎已安装但未完成认证。请先在终端执行 <code>cursor agent login</code>，或配置 <code>CURSOR_API_KEY</code>。
            </div>
          )}
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
        <button className="btn btn-primary" onClick={goNext}>下一步: 资源配置 →</button>
      </div>
    </div>
  );
}
