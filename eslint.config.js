import tseslint from 'typescript-eslint';
import prahari from 'eslint-plugin-prahari';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-chrome/**',
      '**/dist-firefox/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/coverage/**',
      // A Python virtualenv is not our source. It also ships vendored JS that trips
      // the choke-point rule, which would be a false positive on every run.
      'server/.venv/**',
      'server/**/__pycache__/**',
      // Fixtures exist to be violations; linting them would be circular.
      'tools/eslint-plugin-prahari/test/fixtures/**',
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { prahari },
    rules: {
      /**
       * THE RULE. RULES.md P1 in mechanical form: network APIs live in exactly one
       * module, behind the KAVACH egress guard. Everything else is network-denied.
       */
      'prahari/no-network-outside-net': [
        'error',
        { allow: ['packages/extension/src/background/net.ts'] },
      ],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // P9: no PII in logs. A console call with a non-literal argument in the privacy
      // engine is how page values end up in devtools.
      'no-console': 'off',
    },
  },

  {
    /**
     * Node tooling and tests, none of which is bundled into the extension.
     *
     * This exemption is narrow on purpose. The invariant is about SHIPPED code, and
     * the real backstop for shipped code is `scripts/check-bundle.mjs`, which greps
     * the built output and does not care what any config file says. Tests must be
     * able to drive a real HTTP request at the mock server, or the integration test
     * cannot prove the loop closes.
     *
     * Scoped to `*.test.ts` rather than `test/**` so that the deliberate-violation
     * fixture, which lives under `test/fixtures/`, is still a violation.
     */
    files: ['tools/mock-server/**', '**/scripts/**', '**/*.test.ts', 'eslint.config.js'],
    rules: { 'prahari/no-network-outside-net': 'off' },
  },

  {
    files: ['packages/kavach/src/**'],
    rules: {
      // RULES.md P9, enforced where it matters most.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='console'] > :not(Literal)",
          message:
            'RULES.md P9: no non-literal argument may be logged from kavach. A page value must never reach devtools.',
        },
      ],
    },
  },
);
