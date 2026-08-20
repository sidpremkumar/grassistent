import type { Configuration } from 'webpack';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import ReplaceInFileWebpackPlugin from 'replace-in-file-webpack-plugin';
import { getPackageJson, getPluginId } from './webpack.helpers';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Webpack build for the plugin frontend. Emits into `dist/`, copies static
 * assets (plugin.json, README, img) and stamps %VERSION%/%TODAY% into
 * plugin.json so the manifest matches package.json at build time.
 */
const config = async (env: Record<string, unknown>): Promise<Configuration> => {
  const production = Boolean(env.production);
  const pluginId = getPluginId();
  const pkg = getPackageJson();

  return {
    mode: production ? 'production' : 'development',
    context: path.join(dirname, 'src'),
    devtool: production ? 'source-map' : 'eval-source-map',
    entry: {
      module: './module.ts',
    },
    externals: [
      'react',
      'react-dom',
      '@grafana/data',
      '@grafana/runtime',
      '@grafana/ui',
      '@emotion/css',
      // Grafana loads plugins as AMD modules; these are provided by the host.
      ({ request }, callback) => {
        const prefix = 'grafana/';
        if (request?.startsWith(prefix)) {
          return callback(undefined, `amd ${request}`);
        }
        return callback();
      },
    ],
    output: {
      clean: true,
      filename: '[name].js',
      path: path.join(dirname, 'dist'),
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
          { from: '../CHANGELOG.md', to: '.', noErrorOnMissing: true },
          { from: '../LICENSE', to: '.', noErrorOnMissing: true },
          { from: 'img/**/*', to: '.', noErrorOnMissing: true },
        ],
      }),
      new ReplaceInFileWebpackPlugin([
        {
          dir: path.join(dirname, 'dist'),
          files: ['plugin.json'],
          rules: [
            { search: /%VERSION%/g, replace: pkg.version },
            { search: /%TODAY%/g, replace: new Date().toISOString().slice(0, 10) },
          ],
        },
      ]),
      new ForkTsCheckerWebpackPlugin({
        typescript: { configFile: path.join(dirname, 'tsconfig.json') },
      }),
    ],
  };
};

export default config;
