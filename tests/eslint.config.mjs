// ESLint flat config for the three classic scripts (they share the page's global scope, so
// CONFIG and DEMO are globals only from app.js's point of view).
const browser = ['window','document','location','history','sessionStorage','localStorage','fetch','FileReader','Image','URLSearchParams','AbortController','setTimeout','clearTimeout','setInterval','clearInterval','console','Date','Math','Number','String','Object','Array','JSON','Promise','Set','Map','Infinity','NaN','isNaN','isFinite','parseInt','parseFloat','encodeURIComponent','decodeURIComponent','TypeError','Error','Symbol','navigator','requestAnimationFrame','alert','prompt','confirm','Event','Buffer','process'];
const globals = Object.fromEntries(browser.map((g) => [g, 'readonly']));
const rules = {
  'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }], 'no-redeclare': 'error',
  'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-duplicate-case': 'error',
  'no-unreachable': 'error', 'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-unsafe-negation': 'error', 'no-self-assign': 'error', 'no-self-compare': 'error',
  'no-cond-assign': 'error', 'no-constant-condition': 'error', 'no-fallthrough': 'error',
  'no-func-assign': 'error', 'no-import-assign': 'error', 'no-inner-declarations': 'off',
  'no-loss-of-precision': 'error', 'no-sparse-arrays': 'error', 'no-template-curly-in-string': 'warn',
  'no-unsafe-optional-chaining': 'error', 'use-isnan': 'error', 'valid-typeof': 'error',
  'eqeqeq': ['warn', 'smart'], 'no-var': 'warn', 'prefer-const': 'warn', 'no-shadow': 'warn',
  'no-use-before-define': ['warn', { functions: false, classes: true, variables: true }],
  'no-throw-literal': 'error', 'no-sequences': 'warn', 'no-void': 'warn',
  'no-async-promise-executor': 'error', 'no-promise-executor-return': 'warn',
  'no-unused-expressions': 'warn', 'no-lone-blocks': 'warn', 'no-useless-escape': 'warn', 'no-prototype-builtins': 'warn',
  'no-global-assign': 'error',
};
export default [
  { files: ['js/app.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals, CONFIG: 'readonly', DEMO: 'readonly' } }, rules },
  { files: ['js/config.js', 'js/demo.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals }, rules: { ...rules, 'no-unused-vars': 'off' } },
  { files: ['tests/**/*.mjs'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals }, rules: { ...rules, 'no-undef': 'off', 'no-shadow': 'off' } },
];
