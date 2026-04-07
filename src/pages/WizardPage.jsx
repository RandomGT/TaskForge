import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import Header from '../components/Header';
import StepIndicator from '../components/StepIndicator';
import Step1Requirement from '../components/Step1Requirement';
import Step2Resources from '../components/Step2Resources';
import Step3TaskSplit from '../components/Step3TaskSplit';
import Step5Prompts from '../components/Step5Prompts';
import TaskEditModal from '../components/TaskEditModal';
import Toast from '../components/Toast';
import { buildPersistableState } from '../utils/persistState';
import { fetchJob, updateJob } from '../utils/jobApi';

function WizardInner() {
  const { state, dispatch, showToast } = useAppContext();
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [booting, setBooting] = useState(() => Boolean(jobId && jobId !== 'new'));

  useEffect(() => {
    if (!jobId || jobId === 'new') {
      setBooting(false);
      dispatch({ type: 'RESET' });
      dispatch({ type: 'SET_JOB_ID', id: null });
      return;
    }

    let cancelled = false;
    setBooting(true);
    dispatch({ type: 'RESET' });
    dispatch({ type: 'SET_JOB_ID', id: null });

    (async () => {
      try {
        const job = await fetchJob(jobId);
        if (cancelled) return;
        dispatch({ type: 'LOAD_STATE', state: job.state });
        dispatch({ type: 'SET_JOB_ID', id: jobId });
      } catch (e) {
        if (!cancelled) {
          showToast('❌ 加载任务失败，请确认后端已启动');
          navigate('/', { replace: true });
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId, dispatch, navigate, showToast]);

  useEffect(() => {
    if (booting || !state.currentJobId) return;
    if (!jobId || jobId === 'new') return;
    if (state.currentJobId !== jobId) return;

    const t = setTimeout(() => {
      const payload = buildPersistableState(state);
      updateJob(state.currentJobId, payload).catch(() => {
        showToast('⚠️ 自动保存失败，请检查后端服务');
      });
    }, 700);

    return () => clearTimeout(t);
  }, [state, booting, jobId, state.currentJobId, showToast]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!state.currentJobId) {
          showToast('完成第 1 步并进入下一步后会自动创建任务');
          return;
        }
        const payload = buildPersistableState(state);
        updateJob(state.currentJobId, payload)
          .then(() => showToast('✅ 已保存到服务端'))
          .catch(() => showToast('❌ 保存失败'));
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state, showToast]);

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

  if (booting) {
    return (
      <>
        <Header />
        <div className="app-container task-list-page">
          <div className="wizard-booting">载入任务中…</div>
        </div>
        <Toast />
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="app-container">
        <div className="main-content">
          <div className="panel">
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

export default function WizardPage() {
  return <WizardInner />;
}
