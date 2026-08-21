import { AppPlugin } from '@grafana/data';
import { createRoot } from 'react-dom/client';
import { App } from './pages/App';
import { ConfigPage } from './pages/ConfigPage';
import { FloatingChat } from './components/FloatingChat';
import { initErrorCapture } from './lib/error-log';

/**
 * Plugin entry. Registers:
 *  - the app root page (full-page chat),
 *  - the admin configuration page.
 *
 * Global entry point: Grafana 13 hardcodes every top-bar and extension-sidebar
 * slot to its internal Setup Guide plugin (see `renderLimitedComponents` with
 * `SETUPGUIDE_PLUGIN_ID` in Grafana's `TopBar` components, and issue #128185),
 * so a third-party plugin cannot render "next to Sign in" via any extension
 * point. Instead we rely on `"preload": true` in plugin.json: the module below
 * runs on every page, and we mount a floating action button directly into
 * <body>. This works for anonymous users and keeps them on their current page.
 */
export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: ConfigPage,
    id: 'configuration',
  });

mountFloatingChat();
/* Start capturing error toasts immediately so the agent's page context can
 * include failures that happened before the chat was even opened. */
initErrorCapture();

/**
 * Mounts the global floating chat once. Guards against double-mounting when the
 * module is evaluated more than once (e.g. HMR or repeated preload).
 */
function mountFloatingChat(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const containerId = 'mcpagent-floating-root';
  if (document.getElementById(containerId)) {
    return;
  }
  const container = document.createElement('div');
  container.id = containerId;
  document.body.appendChild(container);
  createRoot(container).render(<FloatingChat />);
}
