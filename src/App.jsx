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

  const renderStep = () => {
    switch (state.currentStep) {
      case 1: return <Step1Requirement />;
      case 2: return <Step2Resources />;
      case 3: return <Step3TaskSplit />;
      case 4: return <Step5Prompts />;
      default: return <Step1Requirement />;
    }
  };

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
              {renderStep()}
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
