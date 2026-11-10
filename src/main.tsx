import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import 'material-symbols/outlined.css';
import './app/globals.css';
import { ApiClient } from '@/features/api-client/ApiClient';

// Browser-only e2e/fidelity builds (`--mode e2e`) stand in for the Rust layer; Vite drops this otherwise.
if (import.meta.env.MODE === 'e2e') {
  const { installTauriMocks } = await import('./test/mockTauri');
  installTauriMocks();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApiClient />
  </React.StrictMode>,
);
