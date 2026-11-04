import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { initTheme } from './lib/themeStore';
import { initChartSettings } from './lib/chartSettingsStore';
import './styles/globals.css';

// Before the first paint, so a saved theme never flashes the default palette.
initTheme();
// Likewise, so the first ticks are handled in the saved candle-update mode.
initChartSettings();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
