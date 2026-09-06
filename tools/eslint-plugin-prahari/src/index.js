/**
 * eslint-plugin-prahari
 *
 * One rule, and it is the mechanical form of the project's central invariant
 * (RULES.md P1): network-capable APIs may appear only in the designated egress
 * module. Everywhere else, a network call is a lint error that fails CI.
 *
 * This is what stops "one choke point" from being a promise someone can quietly
 * break at 2am to unblock a demo.
 */

const NETWORK_IDENTIFIERS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
]);

/** `navigator.sendBeacon(...)` and `navigator.serviceWorker` style member calls. */
const NETWORK_MEMBERS = new Set(['sendBeacon']);

/** Paths (posix-normalised, substring match) permitted to hold network calls. */
const DEFAULT_ALLOW = ['packages/extension/src/background/net.ts'];

function normalise(filename) {
  // Windows paths arrive backslash-separated; the allow list is written posix-style.
  return filename.split('\\').join('/');
}

const noNetworkOutsideNet = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Network APIs may only be used in the egress module that sits behind the KAVACH guard.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "'{{name}}' reaches the network. RULES.md P1: network APIs live only in {{allowed}}, behind guard(). Route this through the background message bus instead.",
      remoteImport:
        'Dynamic import of a remote URL is a network call and is forbidden outside {{allowed}}.',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const allow = options.allow ?? DEFAULT_ALLOW;
    const filename = normalise(context.filename ?? context.getFilename());

    if (allow.some((a) => filename.includes(a))) return {};

    const allowed = allow.join(', ');

    function reportIdentifier(node, name) {
      context.report({ node, messageId: 'forbidden', data: { name, allowed } });
    }

    return {
      // Bare `fetch(...)`, `new WebSocket(...)`, `new XMLHttpRequest()`.
      'CallExpression > Identifier.callee'(node) {
        if (NETWORK_IDENTIFIERS.has(node.name)) reportIdentifier(node, node.name);
      },
      'NewExpression > Identifier.callee'(node) {
        if (NETWORK_IDENTIFIERS.has(node.name)) reportIdentifier(node, node.name);
      },
      // `globalThis.fetch(...)`, `window.fetch(...)`, `navigator.sendBeacon(...)`.
      'MemberExpression[computed=false] > Identifier.property'(node) {
        if (NETWORK_IDENTIFIERS.has(node.name) || NETWORK_MEMBERS.has(node.name)) {
          reportIdentifier(node, node.name);
        }
      },
      // `import('https://...')` pulls remote code past the CSP story.
      ImportExpression(node) {
        if (
          node.source?.type === 'Literal' &&
          typeof node.source.value === 'string' &&
          /^(https?:)?\/\//.test(node.source.value)
        ) {
          context.report({ node, messageId: 'remoteImport', data: { allowed } });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'eslint-plugin-prahari', version: '0.1.0' },
  rules: { 'no-network-outside-net': noNetworkOutsideNet },
};

export default plugin;
export { plugin, noNetworkOutsideNet };
