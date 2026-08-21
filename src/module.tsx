import { AppPlugin } from '@grafana/data';
import { createRoot } from 'react-dom/client';
import { App } from './pages/App';
import { ConfigPage } from './pages/ConfigPage';
import { TopBarChat } from './components/TopBarChat';
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
 * runs on every page and portals a single trigger icon into the top nav
 * toolbar. This works for anonymous users and keeps them on their current page.
 */
export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: ConfigPage,
    id: 'configuration',
  });

mountTopBarChat();
/* Start capturing error toasts immediately so the agent's page context can
 * include failures that happened before the chat was even opened. */
initErrorCapture();

/**
 * Mounts the global chat controller once. Guards against double-mounting when
 * the module is evaluated more than once (e.g. HMR or repeated preload).
 */
function mountTopBarChat(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const containerId = 'mcpagent-root';
  if (document.getElementById(containerId)) {
    return;
  }
  const container = document.createElement('div');
  container.id = containerId;
  document.body.appendChild(container);
  createRoot(container).render(<TopBarChat />);
}
