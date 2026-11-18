import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ClientPortal from './ClientPortal';
import '../index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientPortal />
  </StrictMode>,
);
