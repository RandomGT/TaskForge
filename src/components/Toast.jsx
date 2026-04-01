import React, { useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';

function ToastItem({ toast }) {
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFadeOut(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`toast${fadeOut ? ' fade-out' : ''}`}>
      {toast.message}
    </div>
  );
}

export default function Toast() {
  const { state } = useAppContext();

  if (state.toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {state.toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
