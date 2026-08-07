# Named classes: what the source hint can read

The source-hint bridge (`pairs[].source`, `fix_plan` — see the
[tutorial, Step 6](design-qa-tutorial.md#step-6--navigate-to-the-code-source-hints-and-fix_plan))
parses a code address out of CSS-module class names. It is deliberately conservative: a false
address is worse than a missing one, so anything the parser is not sure about yields no hint and
one honest note — *"the DOM nodes have classes, but none was recognized as a CSS module"*. Which
tier you get is decided by a single bundler setting, and this page is that setting per bundler.

## Check what your build emits

One line in the DevTools console of the rendered page:

```js
document.querySelector('<your selector>').className
```

Three shapes parse today (`mcp-server/src/domain/layout-spec/class-source.ts`):

| Shape | Example | Typical origin | The hint carries |
| --- | --- | --- | --- |
| `name-module-scss-module__hash__local` | `product-card-module-scss-module__pQ_r7S__title` | Turbopack (Next.js) production builds | module file **and** local — full bridge |
| `name_local__hash` / `name__local___hash` | `ProductCard_title__a1b2c3` | webpack css-loader with `[name]` and `[local]` in `localIdentName` | module **and** local — full bridge |
| `_local_hash` | `_button_1a2b3` | Vite production default | local only |
| anything else (pure hash, utility, BEM) | `ab12cd`, `mt-4`, `card__title--big` | minified `localIdentName`, utility CSS | no address, honest note |

## Enable named classes

**webpack (css-loader)** — the production default is a hash-only class, so names must be asked for:

```js
{
  loader: 'css-loader',
  options: { modules: { localIdentName: '[name]__[local]___[hash:base64:5]' } },
}
```

**Next.js (webpack mode)** — the same key, through the webpack override in `next.config.js`
(find the existing css-loader rule and set `modules.localIdentName` on it).

**Vite** — the production default (`_[local]_[hash]`) already gives the local-only tier out of the
box; add the module name for the full bridge:

```js
// vite.config.js
export default { css: { modules: { generateScopedName: '[name]__[local]___[hash:base64:5]' } } }
```

**Turbopack (Next.js)** — production classes observed from Turbopack builds already carry the long
`name-module-scss-module__hash__local` form, underscores in the hash included — nothing to enable;
verify with the one-liner above.

One honest residual: the webpack/Vite shapes require a digit somewhere in the hash tail — a fully
alphabetic hash parses as *no address* by design (a false address is worse), and base64 hashes
carry a digit in almost every emission.

## What each tier buys

| Your classes | `source` / `fix_plan` |
| --- | --- |
| full `name`+`local` | module-file candidate + authored class — edits are routed to the file |
| `local` only | the authored class without its module — grep the local across the codebase |
| pure hash | no address; rows still carry the measured values and the note names this page's fix |

Named classes pay outside this tool too: DevTools shows which component a node belongs to, and a
support screenshot of the Elements panel becomes readable.
