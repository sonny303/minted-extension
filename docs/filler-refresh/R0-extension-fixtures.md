# R0 extension DOM fixtures

**Fixture set:** `portal-dom-r0-synthetic-v1`
**Status:** local fixture integrity checks only
**Evidence date:** 2026-09-25

| Version evidence | Value |
|---|---|
| Extension source baseline before fixture additions | `76b99a196986aadf21b22db55245f61b53a5a5c9` |
| Extension package version | `0.1.1` |
| Installed extension build | Unavailable |
| Live payer form versions | Unavailable |

| Scenario | Built fixture |
|---|---|
| Static-URL wizard | Seven generic step snapshots at the same `/enrollment` URL, each with a unique active step identifier |
| Step identity edge cases | No active identity, two active identities, and the same heading under two distinct active step identifiers |
| Delayed visibility | A conditional panel remains hidden, then appears after a controlled delay |
| Duplicate labels across frames | Separate frame documents each contain a `State` label and different control names |
| Date reversion | A generic text date input changes to a synthetic `02/02/6100` value after a scheduled delay |
| Identifier constraints | Illustrative spaced group NPI and provider ID patterns, lengths, and placeholders |

## Provenance and evidence limit

Every page and value is generated locally by `src/__fixtures__/dom/portalScenarios.ts`. The fixtures contain no provider data, copied payer markup, captured selectors, or production identifiers. They are not actual Aetna, BCBS, or Optum captures or reproductions. Authenticated live pages, installed-extension evidence, and payer form versions were unavailable for this fixture pass.

The identifier patterns are illustrative test inputs, not authoritative payer rules. The date scenario encodes a delayed-reversion shape mentioned in the requirements; it does not establish that a current extension build or a live payer mask causes it. Tests assert only that the builders produce the documented synthetic cases. They do not exercise or prove current production behavior or a fix.

## Verification

Run the focused fixture integrity suite from the extension root:

```sh
node_modules/.bin/vitest run src/__fixtures__/dom/portalScenarios.test.ts
```

No production source, dependency manifest, lockfile, portal capture, build artifact, or release target is changed by this fixture pack.
