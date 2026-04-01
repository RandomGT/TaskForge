import React from 'react';
import { useAppContext } from '../context/AppContext';

const stepLabels = [
  '需求 & AI 配置',
  '资源配置',
  '智能拆分',
  'Prompt & 执行',
];

export default function StepIndicator() {
  const { state, dispatch } = useAppContext();
  const currentStep = state.currentStep;

  const handleStepClick = (stepNum) => {
    if (stepNum > currentStep) {
      if (currentStep === 1) {
        if (!state.projectName.trim() || !state.requirementDesc.trim()) {
          return;
        }
      }
    }
    dispatch({ type: 'SET_STEP', step: stepNum });
  };

  return (
    <div className="steps">
      {stepLabels.map((label, i) => {
        const stepNum = i + 1;
        let className = 'step';
        if (stepNum === currentStep) className += ' active';
        else if (stepNum < currentStep) className += ' completed';

        return (
          <div
            key={stepNum}
            className={className}
            onClick={() => handleStepClick(stepNum)}
          >
            <div className="step-number">{stepNum}</div>
            <div className="step-label">{label}</div>
          </div>
        );
      })}
    </div>
  );
}
