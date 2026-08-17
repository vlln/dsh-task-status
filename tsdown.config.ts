/** dsh-task-status 双 half 构建：Node（esm）+ 官方 client bundle（cjs，__ModuleLoader__ 契约）。 */

export default [
  {
    entry: ['src/index.mjs'],
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outDir: 'lib',
    clean: true,
    // Node half 是 .mjs 纯 JS：dts 生成器不产出声明，改用手写 src/index.d.mts 随构建拷入。
    copy: { from: 'src/index.d.mts', to: 'lib' },
  },
  {
    name: '@vlln/dsh-task-status/client',
    entry: { client: 'src/client/task-status.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [/@deepseek-ai\/dsh-client-/, 'react', 'react-dom'],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@vlln/dsh-task-status", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
