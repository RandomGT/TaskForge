/** 与后端同步时可持久化的 workspace 状态（去掉运行时/会话字段） */
export function buildPersistableState(state) {
  const toSave = { ...state };
  delete toSave.toasts;
  delete toSave.modalVisible;
  delete toSave.editingTaskIndex;
  delete toSave.aiLoading;
  delete toSave.aiLog;
  delete toSave.aiStatus;
  delete toSave.executingTaskIndex;
  delete toSave.executionLog;
  delete toSave.executionStatus;
  delete toSave.serverOnline;
  delete toSave.availableEngines;
  delete toSave.projectFiles;
  delete toSave.currentJobId;
  return toSave;
}
