# Spike: why nine BCBS KS fields logged `context_changed` without a write

**Date:** 2026-10-15 · **Fill:** `fill_sessions` 21813fea-f6e6-4553-bcbf-bb733db09b19
(case C-1095, portal `bcbs-ks-enrollment-1514e1bd8cbc`, 101 maps, 70 attempted) ·
**Scope:** finding + failing tests only, no behaviour change. Branch
`claude/spike-context-changed-dates-716311`.

## Finding in one paragraph

The nine fields were never refused *before* the write. Every one of them went
through `applyValue`, had its value set, and then failed the exact-string
readback check at `src/content/fillEngine.ts:739`
(`if (el.value !== nextValue) return { ok: false, reason: "field did not retain the requested value" }`).
That return carries **no `outcome` / `reasonCode`**, so `applyFillOnPage`
records nothing for the field (`src/content/fillEngine.ts:1213` gates
`recordOutcome` on both being present). The worker then sees an APPLY_FILL reply
with zero `fieldOutcomes` for a routed field and files it as
`unverified` / `context_changed` with `attempted: false`
(`src/background/frameMessaging.ts:844-871`, the `matchingOutcome` fallback).
So "context_changed, attempted=false" here means "the engine wrote and did not
say what happened", not "the page changed under us".

The working hypothesis (PrimeFaces widgets mutating or replacing their inputs
so the probe-time target or mutation version no longer matched) is **refuted**:
a MutationObserver over the live form records zero DOM mutations during the
engine's exact write sequence on any of these inputs, the target node is the
same element, and the strict-revalidation block at
`src/content/fillEngine.ts:1153-1172` is never the rejecting check.

## What the page actually does (measured live, 2026-10-15)

The form is public (`/allUsers/`, no login). PrimeFaces 10.0.0; every one of
the nine is a `p:inputMask`, or a `p:datePicker` with `mask="mm/dd/yyyy"`,
which installs the same `jquery.inputmask` on the `_input`. The widget defines
an **own `value` accessor on the input element**, re-masks on `input`, and runs
with `clearIncomplete: true`, `clearMaskOnLostFocus: true`.

The engine's sequence (`setNativeValue` → prototype `value` setter → `input`,
`change`, `blur`, `focusout`) produced:

| Field | Mask | Written | After `input` | After `blur` | Engine verdict |
|---|---|---|---|---|---|
| ContactPhone (and the other 4 phone/fax) | `(999)999-9999` | `(555) 555-0100` or `5555550100` | `(555)555-0100` | `(555)555-0100` | `!==` → "did not retain" |
| SubmitterPhoneNumber (control) | `(999)999-9999` | `(555)555-0100` | same | same | retained |
| ProviderNPI (was written in the real fill) | `9999999999` | 10 digits | same | same | retained |
| ProviderSupervisorNPI | `9999999999` | map's hardcoded `n/a` | `` | `` | "did not retain" (correctly: no digits) |
| ProviderEffectiveDate_input (`date_mmddyyyy` transform) | `mm/dd/yyyy` | `02/02/2026` | `02/02/2026` | **``** | "did not retain" |
| ProviderDOB_input, OrganizationEffectiveDate_input (no transform) | `mm/dd/yyyy` | ISO `1980-02-02` | `10/02/02__` | **``** | "did not retain" |

Two distinct page behaviours feed the same check:

1. **Phones/fax: the mask canonicalises.** The value is on the page in the
   mask's own shape (no space after the area code), so it almost certainly WAS
   visible to the coordinator in the real fill. The engine compares the raw
   string and calls it a failure. Only a value already in exact mask shape
   passes.
2. **Dates: the synthetic `blur` empties the field.** The prototype-setter
   write bypasses the mask's own setter, so the widget's internal buffer stays
   empty; the engine's synthetic `input` does not re-sync it for the
   `datetime` alias (it does for the phone mask); on `blur`,
   `clearIncomplete` writes that empty buffer back. Without the blur the date
   stays (`focusout` alone does not clear it). A write through the input's own
   `value` setter followed by the same four events **survives the blur**.
   The dashes theory is half right: DOB and OrganizationEffectiveDate also
   arrive as ISO because their maps have no `date_mmddyyyy` transform, and the
   mask mangles ISO to `10/02/02__` before clearing it. Fixing the transform
   alone would not have filled them.
3. **Supervisor NPI:** the map hardcodes `n/a`; a 10-digit mask reduces it to
   nothing. That refusal is correct and should read `write_rejected`, not
   `context_changed`.

## Failing tests

`src/content/fillEngine.test.ts`, describe
"PrimeFaces InputMask readback (spike, expected to fail until fixed)". The
fixture mimics the measured widget (own accessor, re-mask on `input`, buffer
write-back on `blur`), no portal markup copied. Four red tests:

- canonical readback is an **attempted** write with a reason code, never
  silence (today: `fieldOutcomes` is empty);
- a re-formatted phone counts as **filled** (today: skipped, though the digits
  are on the page);
- a DatePicker date **survives the engine's blur** (today: emptied);
- `n/a` into a digit mask is **`write_rejected`** with `attempted: true`.

Run: `npx vitest run src/content/fillEngine.test.ts` → 74 pass, 4 fail.

## Proposal: the smallest change that lets them fill

One locality, `setNativeValue` + the readback check in `applyValue`
(`src/content/fillEngine.ts:338-358` and `:736-739`): when the input carries
an inputmask (own `value` accessor, or `el.inputmask` / `.ui-inputmask`), write
through the element's **own** setter instead of the prototype's, and judge
retention by the mask's content rather than the raw string — compare the
alphanumerics of `el.value` with those of the requested value (the live form's
`inputmask.unmaskedvalue()` is the same thing when available). That makes the
five phones "filled", keeps the three dates through blur (own-setter write),
and keeps rejecting `n/a` into an NPI mask (no digits survive). Independently
of filling, the `ok: false` at `:739` should carry
`outcome: "write_rejected", reasonCode: "readback_mismatch"` so a rejected
write stops being filed as `context_changed` with `attempted: false` — that
telemetry fix is a two-line change and is what makes any future readback
failure diagnosable. **Risk:** the own-setter path must be gated on the mask
being present, or React/Lit-controlled inputs lose the prototype-setter
behaviour the engine depends on; and the relaxed comparison must compare
content, not accept any non-empty readback, or a mask that silently truncates
(ZIP+4 into a 5-digit mask) would be reported as a clean fill. A panel-side
follow-up, not an extension change: give `ProviderDOB_input` and
`OrganizationEffectiveDate_input` the `date_mmddyyyy` transform, and make
`ProviderSupervisorNPI` manual (or blank) instead of `n/a`.
