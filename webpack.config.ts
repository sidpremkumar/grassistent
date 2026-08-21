import type { Configuration } from 'webpack';
import * as fs from 'node:fs';
import * as path from 'node:path';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';

/* eslint-disable @typescript-eslint/no-var-requires */
// Untyped plugin; require avoids a missing-declaration compile error under ts-node.
const ReplaceInFileWebpackPlugin = require('replace-in-file-webpack-plugin');

/**
 * Webpack build for the plugin frontend. Emits into `dist/`, copies static
 * assets (plugin.json, README, img) and stamps %VERSION%/%TODAY% into
 * plugin.json so the manifest matches package.json at build time.
 *
 * Helpers are inlined (rather than imported) to keep this config loadable by
 * webpack-cli's ts-node bridge without ESM/extension resolution issues.
 */

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')) as Record<string, unknown>;
}

const config = async (env: Record<string, unknown>): Promise<Configuration> => {
  const production = Boolean(env.production);
  const pkg = readJson('package.json');
  const pluginId = (readJson('src/plugin.json').id as string) ?? 'mcpagent-app';
  /*
   * Release builds stamp the version from the git tag (see scripts/package.sh),
   * so the packaged plugin.json can never drift from the tag it ships under.
   * Local/dev builds fall back to package.json.
   */
  const version = process.env.PLUGIN_VERSION || (pkg.version as string) || '0.0.0';

  return {
    mode: production ? 'production' : 'development',
    context: path.join(__dirname, 'src'),
    devtool: production ? 'source-map' : 'eval-source-map',
    entry: {
      module: './module.tsx',
    },
    externals: [
      'react',
      'react-dom',
      'react-dom/client',
      '@grafana/data',
      '@grafana/runtime',
      '@grafana/ui',
      '@emotion/css',
      // Grafana loads plugins as AMD modules; these are provided by the host.
      ({ request }: { request?: string }, callback: (err?: null, result?: string) => void) => {
        const prefix = 'grafana/';
        if (request?.startsWith(prefix)) {
          return callback(null, `amd ${request}`);
        }
        return callback();
      },
    ],
    output: {
      // Clean only frontend build artifacts; preserve the Go backend binaries
      // (gpx_*) that are emitted into dist/ by `mage`/`go build`.
      clean: {
        keep: /gpx_/,
      },
      filename: '[name].js',
      path: path.join(__dirname, 'dist'),
      libraryTarget: 'amd',
      publicPath: `public/plugins/${pluginId}/`,
      uniqueName: pluginId,
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
    module: {
      rules: [
        {
          test: /\.[tj]sx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'swc-loader',
            options: {
              jsc: {
                parser: { syntax: 'typescript', tsx: true },
                transform: { react: { runtime: 'automatic' } },
                target: 'es2022',
              },
            },
          },
        },
        {
          test: /\.(png|jpe?g|gif|svg)$/,
          type: 'asset/resource',
          generator: { filename: 'img/[name][ext]' },
        },
      ],
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'plugin.json', to: '.' },
          { from: '../README.md', to: '.', noErrorOnMissing: true },
          { from: '../LICENSE', to: '.', noErrorOnMissing: true },
          { from: 'img/**/*', to: '.', noErrorOnMissing: true },
        ],
      }),
      new ReplaceInFileWebpackPlugin([
        {
          dir: path.join(__dirname, 'dist'),
          files: ['plugin.json'],
          rules: [
            { search: /%VERSION%/g, replace: version },
            { search: /%TODAY%/g, replace: new Date().toISOString().slice(0, 10) },
          ],
        },
      ]),
      new ForkTsCheckerWebpackPlugin({
        typescript: { configFile: path.join(__dirname, 'tsconfig.json') },
      }),
    ],
  };
};

export default config;
