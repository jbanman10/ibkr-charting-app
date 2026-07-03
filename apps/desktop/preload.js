// Preload stub. The renderer talks to the backend over HTTP/WS (same origin in
// production), so no IPC bridge is needed today. Kept as a placeholder for
// future native integrations (e.g. native menus, file export). contextIsolation
// stays on and nodeIntegration off — do not expose Node here without a reason.
