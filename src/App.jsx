import React, { useEffect } from 'react';
import { AppProvider, useAppContext } from './context/AppContext';
import Header from './components/Header';
import StepIndicator from './components/StepIndicator';
import Step1Requirement from './components/Step1Requirement';
import Step2Resources from './components/Step2Resources';
import Step3TaskSplit from './components/Step3TaskSplit';
import Step5Prompts from './components/Step5Prompts';
import TaskEditModal from './components/TaskEditModal';
import Toast from './components/Toast';

function AppInner() {
  const { state, dispatch } = useAppContext();

  // Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        try {
          const toSave = { ...state };
          delete toSave.toasts;
          delete toSave.modalVisible;
          delete toSave.editingTaskIndex;
          localStorage.setItem('taskforge_state', JSON.stringify(toSave));
        } catch (err) { /* ignore */ }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state]);

  /** 同时挂载各步内容，避免切换 Step 时卸载导致本地状态（如 Step5 执行过程）丢失 */
  const stepPanels = (
    <>
      <div className="step-panel" hidden={state.currentStep !== 1}>
        <Step1Requirement />
      </div>
      <div className="step-panel" hidden={state.currentStep !== 2}>
        <Step2Resources />
      </div>
      <div className="step-panel" hidden={state.currentStep !== 3}>
        <Step3TaskSplit />
      </div>
      <div className="step-panel" hidden={state.currentStep !== 4}>
        <Step5Prompts />
      </div>
    </>
  );

  return (
    <>
      <Header />
      <div className="app-container">
        <div className="main-content">
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">🛠️ 任务工坊</div>
            </div>
            <div className="panel-body">
              <StepIndicator />
              {stepPanels}
            </div>
          </div>
        </div>
      </div>
      <TaskEditModal />
      <Toast />
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
