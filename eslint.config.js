const expo = require('eslint-config-expo/flat');

module.exports = [
  ...expo,
  // bridge/ 是独立的 Node 服务（自带 package.json 与运行时），不适用 RN/Expo 规则
  { ignores: ['node_modules/**', '.expo/**', 'dist/**', 'scripts/**', 'tests/**', 'bridge/**'] },
  {
    rules: {
      // tsc --noEmit 是模块解析的权威检查；ESLint resolver 不认识 RN/Expo 的平台后缀
      'import/no-unresolved': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // 加载态/刷新态在 effect 内同步置位是这里的既定模式
      'react-hooks/set-state-in-effect': 'off',
    },
  },
];
