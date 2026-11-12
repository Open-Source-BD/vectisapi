import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import './app/globals.css';
// After globals.css: the
// icon class's 24px size must win over base.css's 20px.
import './assets/fonts/material-symbols.css';
import { VectisApi } from '@/features/vectisapi/VectisApi';

// Browser-only e2e/fidelity builds (`--mode e2e`) stand in for the Rust layer; Vite drops this otherwise.
if (import.meta.env.MODE === 'e2e') {
  const { installTauriMocks } = await import('./test/mockTauri');
  installTauriMocks();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <VectisApi />
  </React.StrictMode>,
);
