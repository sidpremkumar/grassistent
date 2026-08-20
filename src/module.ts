import { AppPlugin } from '@grafana/data';
import { App } from './pages/App';
import { ConfigPage } from './pages/ConfigPage';
import { SidebarChat } from './components/SidebarChat';

/**
 * Plugin entry. Registers:
 *  - the app root page (chat),
 *  - the admin configuration page,
 *  - a sidebar extension component so the chat can slide out globally and
 *    prefill from the current page.
 */
export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: ConfigPage,
    id: 'configuration',
  })
  .addComponent({
    title: 'MCP Agent',
    description: 'Slide-out MCP agent chat, prefilled from the current page.',
    targets: ['grafana/extension-sidebar/v0-alpha'],
    component: SidebarChat,
  });
