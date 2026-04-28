import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Silence AbortError from noisy inspector scripts
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && (event.reason.name === 'AbortError' || event.reason.message === 'The user aborted a request.')) {
    event.preventDefault();
  }
});

window.addEventListener('error', (event) => {
  if (event.error && (event.error.name === 'AbortError' || event.error.message?.includes('AbortError'))) {
    event.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
