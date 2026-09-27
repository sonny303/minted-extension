# Accepted AI fill learning loop

## Behavior

The worker stores an accepted AI receipt in `chrome.storage.session`. It holds
only successful selector/token/confidence/field-type tuples, a canonical page
origin and path, and the provider/case/portal/facility/org/actor/fill-session
binding. The side panel and page never send profile values to the learning
route.

`MARK_SUBMITTED` posts the normal idempotent portal touch first. After that
touch succeeds, the worker marks the receipt touch-bound and sends accepted
mappings through the authenticated batch-learn API. A learning error leaves
the successful touch intact. `RETRY_AI_LEARNING` repeats only the learning
request; it cannot create or replay a touch. A stopped worker can restore the
receipt and expose a learning-only retry. Batch outcomes drive the Good Catch
count, so preserved conflicts are never reported as new mappings.

Each write retains the source frame's URL until it is canonicalized; iframe
frame IDs are transient. Missing or unsafe page scope is skipped. A refill,
context switch, Clear, or sign-out revokes the receipt. Clear remains available
after Accept until the touch succeeds and undoes only the AI writes whose DOM
values have not changed since the extension wrote them. After a logged touch,
the stored map is not offered for undo. The next Fill fetches maps normally and
uses learned approved rows in the static green lane.

## Verification

Focused local checks passed:

```sh
npm run typecheck
npx vitest run src/sidepanel/aiReviewController.test.ts src/background/fill.ai.test.ts src/background/activeCase.test.ts src/content/controlScanner.test.ts src/content/aiFillEngine.test.ts src/background/frameMessaging.test.ts src/sidepanel/panelMarkup.test.ts
npx vitest run src/harness/workbench.test.ts src/background/fill.ai.test.ts
```

The workbench harness binds its synthetic API to `127.0.0.1`; run that second
command in an environment that permits local loopback. The lifecycle coverage
includes accepted and cleared/unaccepted receipts, touch and learning failures,
learning-only retry, replay counts, worker restart recovery, context generation
changes, per-frame page URLs, value-free persistence, and next-fill static-map
resolution. Whole-extension gates are recorded in the draft PR checks after
they complete.
