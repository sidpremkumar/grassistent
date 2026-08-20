import { AppRootProps } from '@grafana/data';
import { AppPage } from './AppPage';

/**
 * App root. This plugin has a single primary page (the chat), so the root simply
 * renders it. Additional pages can branch on `props.path` here later.
 */
export function App(_props: AppRootProps) {
  return <AppPage />;
}
