# API catalog schema

The catalog is the ground truth the verifier (`src/lib/apiCheck.js`), the
`lookup_api` agent tool and the API Explorer panel read. Its job is to stop the
model (and people) from calling ServiceNow methods that do not exist, from using
a server API in a client script (or the reverse), and from using deprecated
APIs. **Accuracy beats coverage: never invent a method.** If you are not sure a
method exists on the platform, leave it out.

Each data file exports an array of entries:

```js
export const SOME_APIS = [
  {
    name: 'g_form',                 // global variable name, or class name
    kind: 'global',                 // 'global' = predefined variable, 'class' = constructor or static utility
    side: 'client',                 // 'client' | 'server'
    summary: 'One sentence.',
    instantiate: 'new GlideAjax(scriptIncludeName)',   // classes only, optional
    scope: { global: true, scoped: true },             // where it is available (server APIs; default both true)
    unsupportedIn: ['portal', 'mobile'],               // client only: UIs where the whole API is not supported
    complete: false,                // true ONLY when `methods` lists every public method of the API
    methods: [
      {
        name: 'setValue',
        sig: 'setValue(fieldName, value, [displayValue])',
        returns: 'void',            // a class name from the catalog when it returns one (e.g. 'GlideRecord'), else a plain type
        summary: 'One sentence.',
        static: false,              // true for static methods (GlideDateTime has none; GlideSession.get() is static)
        deprecated: null,           // null, or a string "Use X instead." when deprecated or discouraged
        scopedOnly: false,          // only available in scoped applications
        globalOnly: false,          // only available in the global scope
        unsupportedIn: [],          // client only: ['portal', 'mobile', 'workspace'] when this method does not work there
        notes: '',                  // gotchas worth showing a developer
        example: '',                // optional short snippet
      },
    ],
  },
];
```

Rules:
- `side: 'client'` APIs must never appear in server scripts and vice versa; the
  verifier flags that as an error. Put an API in the side where it actually runs.
- Properties that are not methods (for example `g_user.userName`) go in a
  `properties` array of `{ name, type, summary }` on the entry.
- Keep `summary` and `notes` short and factual. No marketing language.
- `deprecated` is for APIs ServiceNow documents as deprecated, or that are
  unsupported in Next Experience / Service Portal and have a supported
  replacement.
