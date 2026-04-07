import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import TaskListPage from './pages/TaskListPage';
import WizardPage from './pages/WizardPage';

export default function App() {
  return (
    <AppProvider>
      <Routes>
        <Route path="/" element={<TaskListPage />} />
        <Route path="/wizard/new" element={<WizardPage />} />
        <Route path="/wizard/:jobId" element={<WizardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppProvider>
  );
}
