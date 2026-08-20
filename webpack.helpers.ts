import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

type PackageJson = {
  version: string;
  [key: string]: unknown;
};

type PluginJson = {
  id: string;
  [key: string]: unknown;
};

/** Reads and parses this plugin's package.json. */
export function getPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(dirname, 'package.json'), 'utf8')) as PackageJson;
}

/** Reads the plugin id from src/plugin.json. */
export function getPluginId(): string {
  const raw = fs.readFileSync(path.join(dirname, 'src', 'plugin.json'), 'utf8');
  return (JSON.parse(raw) as PluginJson).id;
}
