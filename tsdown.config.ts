/** dsh-task-status 双 half 构建：Node 数据路由 + 官方 client bundle。 */

export default [
  {
    entry: ['src/index.mjs'],
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outDir: 'lib',
    clean: true,
  },
  {
    entry: ['src/client/task-status.tsx'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    // 官方 client 契约：__ModuleLoader__.load({id, factory})；外部走官方模块表
    external: [/@deepseek-ai\/dsh-client-/, 'react', 'react-dom'],
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-external/dsh-task-status", factory: (require) => {',
    footer: 'return module.exports; } });',
  },
]
