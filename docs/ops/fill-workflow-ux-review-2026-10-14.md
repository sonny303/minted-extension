# Fill a payer form: UX review and target design

**Date:** Oct 14, 2026 · **For:** PM, scoping Workbench 0.1.8 · **Status:** evaluation only, no code changed

**Scope:** from the case page's "Work in portal" to logging the submission and closing the task.

**Short read:** sections 1, 5, 6, 7 and 8. Sections 2, 3 and 4 are the evidence and reference tables behind them.

> **Reviewer notes (added after checking the claims in code and in the production database)**
>
> 1. **The server fix is M, not S.** It is more than one validation line. `fill_sessions.case_step_id` is a uuid column, and two database functions compare step ids as uuids: the `validate_case_fill_context` trigger and `record_typed_enrollment_submission` (the "Mark submitted" path, four `::uuid` casts). With "step-0" those casts throw. So fixing only the route would move the failure from logging to close-out. All 32 Auto-fill tasks in production use ids like "step-0". Recommended path: add a new text column for the step id and update both functions (additive, no column dropped or retyped).
> 2. **Cut 0.1.8 item 5 (close-out stopgap).** The panel deploys through Vercel the same day. 0.1.8 waits on Chrome Web Store review. The real fix would land first, so the stopgap would ship already obsolete. We are pre-launch with no real coordinators blocked.
> 3. **Add a release gate.** Each of 0.1.5, 0.1.6 and 0.1.7 fixed one wall and missed the next, because nobody tested past the step being fixed. Before any Store upload, run the whole loop once: Work in portal, allow site, Fill, Continue, page 2, Submit, Log submission, task shows done.
> 4. **The page-2 risk (journey step 12) is real in code and cheap to check live.** The link to the case ends if Continue goes to a web address outside the form's starting path (`workFormUrlMatchesPage`, `src/shared/workContext.ts:237`). One click of Continue on Aetna answers it.

**Evidence key**

- **R1** = recording 1 (Fill failed). **R2** = recording 2 (Fill worked). `f_NN` = frame, 2 seconds apart.
- **Screenshot 1** = the red "capture helper" banner. **Screenshot 2** = the "Verified 0" result.
- **ext** = `minted-extension` (v0.1.7, `main`). **panel** = `mintedpanel` (`main`, includes MINT-67).
- Both recordings show case C-1090 (Joseph Knapp, Aetna, KS).

---

## 1. Bottom line

1. **The Fill button lies.** It stays clickable when Chrome has not allowed the site. The fix button sits at the very bottom of the panel.
2. **Messages appear far from the button that caused them.** The fill error lands at the top of the panel, off screen. Nothing scrolls. Nothing is announced.
3. **Every good fill reads like a failure.** "Verified 0; 3 setter attempts remain unverified" shows on every fill today, in engineer words.
4. **Fill is buried.** The panel is about 4 screens tall. The provider card pushes Fill 2 to 3 screens down. The same case shows 4 times.
5. **The ending is broken.** Every case fill fails to save its record today, which turns off "Mark submitted". The panel says so in a green box, and never says "your turn".

---

## 2. Today's journey, step by step

| #   | Step                           | What the user sees                                                                                                                                                                                                         | What they must figure out                         | Severity                                                     | Evidence                                                                                                                                            |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Case page                      | Task row with an "Auto-fill" label. In the videos: an "Open step" button and two banners above the tasks.                                                                                                                 | Where do I start?                                 | Minor (mostly fixed after the videos by MINT-67)             | R1 f_01. Now: inline "Work in portal" on the current step, panel `CaseTasksPanel.tsx:402-411`                                                       |
| 2   | Task drawer                    | Full-width "Mark complete" at the top. Below it, a box named "Aetna Direct Enrollment Enrollment E170b03a3b65 · Verified" with "Work in portal". Then "Waiting for exact work-tab validation…"                              | Do I click "Mark complete" now? What is that code? | Major                                                        | R1 f_02, R2 f_02. panel `TaskDrawer.tsx:231-259`, `PortalStepLink.tsx:61,121`, `WorkInPortalV2Button.tsx:30`                                        |
| 3   | New Aetna tab                  | The tab opens. The side panel does not. R2 shows a blank tab, then the user clicks the toolbar icon.                                                                                                                      | Where is Minted?                                  | Major                                                        | R2 f_03 to f_04. ext `activeWork.ts:444` opens the tab but never opens the panel. The older launch does (`activeCase.ts:414-424`)                    |
| 4   | Panel loads                    | "Exact Work context · case · aetna-direct-… · mapping 1" sits over a list of OTHER providers' overdue cases. Then provider, group, location and the quick card pop in and push everything down.                            | Is my case loaded? Why do I see Michael Mowery?   | Major                                                        | R1 f_03 to f_06, R2 f_04 to f_06. ext `main.ts:4317`, `main.ts:3160`                                                                                |
| 5   | Find the Fill button           | About 2 screens of provider, location, license, billing and malpractice details first. "Aetna · KS · Not Started" shows 4 times.                                                                                          | Where is the button?                              | Major                                                        | R1 f_05 to f_08                                                                                                                                     |
| 6   | Site access (first visit only) | Fill looks ready. The access ask ("Grant access to this Work site") is at the very bottom, under "Log a touch".                                                                                                           | That access is needed at all                      | **Blocker**                                                  | R1 f_15. ext `sidepanel.html:584-591` (outside the case area). `isFillReady()` at `main.ts:1783` never checks access                                |
| 7   | Click Fill without access      | Spinner for about 2 seconds. Button resets. The error goes to the top of the panel, off screen. The user clicks Fill again and again.                                                                                     | Did anything happen?                              | **Blocker**                                                  | R1 f_09 to f_21, Screenshot 1. `main.ts:3662-3663` writes to `#main-error` (`sidepanel.html:230`). No scroll, and no `aria-live` anywhere in the panel |
| 8   | Allow access                   | Chrome's dialog. After Allow, the box stays with a greyed button. No "done" message.                                                                                                                                      | Did it work?                                      | Minor                                                        | R2 f_08 to f_09. `main.ts:3105-3155`                                                                                                                |
| 9   | Fill (with access)             | "Filling…" for about 8 seconds with no change on the page. Then the three dropdowns fill, each with a green outline.                                                                                                      | Is it stuck?                                      | Minor                                                        | R2 f_10 to f_15                                                                                                                                     |
| 10  | Read the result                | "Verified 0; 3 setter attempts remain unverified…", three "#typeOfRFP" rows, an AI note, a red "telemetry" box, and a green check box that is really an error. The page itself shows all three values correctly.          | Did it work? Do I redo it?                        | Major (**every fill**: the engine never reads values back, so nothing is ever "verified") | Screenshot 2, R2 f_16 to f_18. `main.ts:2192-2205`; engine always reports "unverified" (`fillEngine.ts` ~1447)                                     |
| 11  | Log the submission             | No "Mark submitted" button. A green check box says to reopen the task. Below it, an always-open "Log a touch" form.                                                                                                        | How do I record that I submitted?                 | **Blocker (every case fill today)**                          | Screenshot 2. Cause: the server rejects the fill record (422, step id "step-0" is not a UUID), so there is no receipt and close-out turns off (`main.ts:1530`, `2103-2128`). The status box only ever drops a "partial" class (`main.ts:2122`), so it keeps the green success style (`sidepanel.css:700-721`) |
| 12  | Click Continue on Aetna        | No "your turn" cue. Not in the videos, but in code: if the next page has a different web address than the form, the Work link ends and is blocked. The panel then reloads and clears the fill report.                     | Why did Fill turn off? Where did my results go?   | **Blocker if confirmed** (needs a live check)                | ext `activeWork.ts:679-690` and `165-182`, then `main.ts:4648-4652` calls `loadOrgs`, which clears results (`main.ts:2825`)                          |
| 13  | Page 2 and later               | Click Fill again. No page number. No "we can fill N fields here", because the coverage check is off in Work mode.                                                                                                         | Is this page trained?                             | Major                                                        | `main.ts:1879-1883`                                                                                                                                 |
| 14  | After the final submit         | Happy path: "Mark submitted", plus an open "Log a touch" form, plus a step checkbox. "Mark submitted" also moves the case to Submitted, but the button does not say so.                                                    | Which one do I use?                               | Major                                                        | `sidepanel.html:487`, `493-552`. `main.ts:3752` (`bumpStatus: true`)                                                                                |
| 15  | Close the task in the web app  | When the extension logs, the server already completes the step. The drawer still leads with "Mark complete". Today the extension cannot log (step 11), so the user must do it all by hand: Mark complete, Update status, Add touch. | Am I done? Did it count?                          | Major                                                        | panel `TaskDrawer.tsx:231-259`; RPC `record_typed_enrollment_submission` (migration `20261006153000`)                                              |

**What works today. Keep it.**

- The breadcrumb strip (Org > Provider > Payer · State > Location). It answers "who am I working on" at a glance.
- The green outline on filled fields (R2 f_15). It is the best "it worked" signal in the whole flow.
- The label "Fill this page". It sets the one-page-per-click model.
- Cascading dropdowns filled in one click (R2 f_14 to f_15). The engine did its job.
- "⚠ Not on file" plus "Add missing details in Minted Panel ↗" on the quick card. Honest and actionable.
- Retry that keeps typed entries and cannot double-log. The duplicate-submission warning.

---

## 3. Jargon and copy audit

Quotes keep the original words. Long dashes in the originals are shown as " - ".

**Extension: arrival, status, access**

| Where                         | Today                                                                                                                         | Rewrite                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Work banner `main.ts:4317`    | "Exact Work context · case · aetna-direct-enrollment-enrollment-e170b03a3b65 · mapping 1. Fill is bound to its launched tab." | "Working on Joseph Knapp, Aetna, KS. Opened from Minted Panel." + link "Back to case"                |
| Page status `main.ts:558,1834` | "aetna-direct-enrollment-enrollment-e170b03a3b65 · selected Work form detected in the current tab."                           | "Aetna form found on this tab."                                                                      |
| `main.ts:1830`                | "Return to the exact launched portal tab to continue this Work context."                                                      | "Go back to the Aetna tab you opened from Minted Panel." + button "Go to tab"                        |
| `main.ts:1826`, `4309`        | "The exact Work tab or context ended. Relaunch the task from Minted Panel, or make a manual selection before filling."         | "This tab is no longer linked to the case. Open the case in Minted Panel and click Work in portal."  |
| `main.ts:4301`                | "This exact Work context expired after 60 minutes idle. Re-launch the task from Minted Panel to continue."                    | "This link timed out after 60 minutes. Click Work in portal again."                                  |
| `sidepanel.html:586-589`      | "Minted needs access to the selected Work form's site to read and fill this validated page." / "Grant access to this Work site" | "One-time setup: Chrome needs your OK before Minted can fill forms on aetna.com." / "Allow Minted on aetna.com" |
| `sidepanel.html:576-580`      | "On a payer portal? Give Minted access to this organization's portal sites…" / "Enable form capture & fill"                    | "Let Minted fill forms on your payer websites." / "Allow payer websites"                             |

**Extension: fill errors**

| Where              | Today                                                                                                           | Rewrite                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `inject.ts:93`     | "Could not load the capture helper into this page - grant access to this site and reload the portal page, then retry." | "Minted can't reach this page yet. Click Allow Minted on aetna.com, then click Fill again."   |
| `fill.ts:1016`     | "Could not reach the enrollment form - open the portal's enrollment page in the current tab and reload it."     | "We lost touch with the Aetna page. Reload it, then click Fill again."                        |
| `main.ts:3528`     | "The enrollment form is no longer the active tab - switch back to it and try again."                           | "Switch to the Aetna tab, then click Fill."                                                   |
| `main.ts:3631`     | "The portal page changed during AI review. Run Fill again."                                                     | "The page changed while we were filling. Click Fill again."                                   |
| `fill.ts:1096`     | "Fill failed on the page: {raw error text}"                                                                     | "Something on this page stopped the fill. Try again, or fill it by hand." (raw text goes in Details) |

**Extension: results**

| Where                         | Today                                                                                                                         | Rewrite                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `main.ts:2198`                | "Verified 0; 3 setter attempts remain unverified. 3 mapped fields have a confirmed current step. The page has ~1 fillable fields." | "Filled 3 fields on this page."                                                                         |
| `main.ts:2201-2205`           | "Attempted but not verified: #typeOfRFP - setter was attempted; the portal state was not checked"                             | Hide from coordinators. In admin Details: "I am interested in: filled".                                 |
| `main.ts:2212`                | "Confirmed static: 12 · AI suggestions: 2 of 14 actual writes."                                                               | "Filled 12 fields. 2 more are guesses to check (yellow)."                                               |
| `aiReviewController.ts:121`   | "On-device AI is unavailable; static fills still completed."                                                                  | Show nothing.                                                                                           |
| `aiReviewController.ts:123`   | "AI suggested 2 fields. Review amber fields, then accept or clear."                                                           | "We guessed 2 more fields (yellow). Check them, then Keep or Undo."                                     |
| `aiReviewController.ts:103`   | "Good Catch: 2 mappings confirmed for future fills."                                                                          | "Saved. These fields will fill on their own next time."                                                 |
| `main.ts:2224`                | "Form-wide planning items - page not checked:"                                                                                | "Fields you always fill by hand on this form:"                                                          |
| `fixit.ts:116`                | "Partial fill: 2 mapped fields have no Minted Panel value; 1 mapped field needs review from this fill. Review the lists above…" | "3 fields need you. Fill them on the Aetna page before you submit."                                     |
| Skip reasons (display only)   | "field not found on this page" / "field is hidden on this page" / "field belongs to another page"                             | "Not found on this page" / not shown / not shown. The wording sent to Minted Panel stays exactly the same. |
| `fill.ts:1200`                | "Fill applied, but telemetry could not be recorded to Minted Panel. Retry from the case record."                              | Grey, under a green "Filled 3 fields": "Minted Panel didn't save a record of this fill. That's on us. You can keep going." "Try again" only when the cause is a lost connection. (The case record has no retry today.) |
| `main.ts:1530` (in a green check box) | "The exact Enrollment Work case or fill receipt is unavailable. Reopen the task in Minted Panel."                       | Never shown as a dead end. Close-out stays open (section 6). If the extension can only add a note: "We added this to the case notes. One more step: mark the task done in Minted Panel." + "Open task" |
| `index.ts:2258`               | "Only a saved successful Enrollment Work fill can be marked submitted. Reopen the exact task and fill again."                  | "Fill this form once before you log it."                                                                |
| `main.ts:1544`                | "Submission logged, but the exact Work receipt could not be confirmed. Review the case activity."                             | "Logged. Please check the case to make sure the task closed."                                           |

**Extension: logging and labels**

| Today                                             | Rewrite                                  |
| ------------------------------------------------- | ---------------------------------------- |
| "Mark submitted"                                  | "Log submission"                         |
| "Payer reference / submission ID"                 | "Aetna confirmation number (optional)"   |
| "Log a touch" / "Context"                         | "Log a call, email, or note" / "What happened?" |
| "Cases that use this page" + "THIS PAGE" chip     | Remove in Work mode                      |
| "Pipeline" / "Progress (1)"                       | "Status" / "Task"                        |
| "Next best action"                                | "Up next"                                |

**Web app**

| Where                                 | Today                                                                                         | Rewrite                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `WorkInPortalV2Button.tsx:30`         | "Waiting for exact work-tab validation…"                                                      | "Opening Aetna in a new tab…"                                                                     |
| `WorkInPortalV2Button.tsx:33`         | "The extension validated this step and opened its exact work tab."                            | "Aetna is open in a new tab. Use the Minted side panel there."                                    |
| `WorkInPortalV2Button.tsx:44`         | "No exact work-tab acknowledgement arrived. Refresh this step before retrying."               | "The Minted extension didn't answer. Check that it's installed and you're signed in. Then try again." |
| `WorkInPortalV2Button.tsx:47`         | "The extension did not accept this work context. Refresh and review the step configuration." | "This form isn't ready yet. Ask an admin to finish Form setup."                                   |
| `WorkInPortalV2Button.tsx:54`         | "The versioned extension handoff is unavailable in this browser."                             | "Install or update the Minted extension in Chrome, then try again."                               |
| `PortalStepLink.tsx:61,121`           | "Aetna Direct Enrollment Enrollment E170b03a3b65" + "Verified" chip                           | "Aetna: Join the network form". Drop the chip (the spike found it misleading).                    |
| `StepDetails.tsx:147`                 | "Complete this step in the portal, then mark it done below." ("Mark complete" is above)       | "Fill and submit this form on Aetna. Then click Log submission in the Minted side panel."         |
| `portalLaunchFeedback.ts:10`          | "Manual recovery: open the extension and use case search."                                    | "Or open the Minted side panel and search for this case."                                         |

---

## 4. Side panel layout in Work mode

The panel is about 640px tall in the videos. Below, one "screen" means one panel height.

**Today, in DOM order (case loaded, before a fill)**

| #   | Block                                                    | Size today          | Verdict                                                                         |
| --- | -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| 1   | Account row (org name, avatar)                           | small               | Keep                                                                            |
| 2   | Breadcrumb (org > provider > payer · state > location)   | small               | **Keep.** This is the case header.                                              |
| 3   | Mode switch (Search, Work cases, Train forms)            | small               | Keep                                                                            |
| 4   | Organization select                                      | small               | Hide once a Work case is applied. The breadcrumb already says it.              |
| 5   | Error box `#main-error`                                  | varies              | App-level errors only. Fill messages move under the Fill button.                |
| 6   | Work banner "Exact Work context…"                        | 2 lines             | Rewrite to one plain line + "Back to case"                                      |
| 7   | Queue "Pick up where you left off"                       | up to 1 screen      | Hide while a launch is loading                                                  |
| 8   | Provider bar "Knapp, Joseph - 1184071342 · Change"       | 1 line              | Remove in Work mode. "Change" would break the link to the case.                 |
| 9   | Quick card (provider, location, license, group, billing, malpractice) | **about 2 screens** | **Collapse** to "Provider details" below the action card                        |
| 10  | "Cases that use this page"                               | 2 lines             | Remove in Work mode                                                             |
| 11  | Group and Location                                       | 4 lines             | Show in the breadcrumb only. Show a picker only if a choice is needed.          |
| 12  | Page status line                                         | 2 lines             | Merge into the action card                                                      |
| 13  | Case select + status pill                                | 2 lines             | Remove in Work mode. The case is fixed.                                         |
| 14  | Case context: Pipeline, Progress, step checkbox          | about 1/3 screen    | One line: "Task: Fill online Join Provider Network form · due Oct 13"           |
| 15  | **Fill this page**                                       | 1 line              | **Move to the top of the case area**                                            |
| 16  | Results (after a fill)                                   | about 2/3 screen    | Rewrite (section 6)                                                             |
| 17  | Mark submitted area                                      | about 1/2 screen    | Becomes "Log submission". Reachable on any page once a fill has run.            |
| 18  | Log a touch form                                         | about 2/3 screen    | Collapse to a link: "Log a call, email, or note"                                |
| 19  | Up next (after logging)                                  | small               | Keep                                                                            |
| 20  | Two different site-access prompts                        | 3 lines each        | Move into the Fill button's spot. One prompt, one wording.                      |

**Height:** Fill sits about 2.5 screens down on first load. The whole panel is about 4 screens before a fill, and about 5 after. Target: Fill visible with no scrolling, about 200px from the top.

**The "status far from the button" problem.** Fill-related messages land in five places today:

- `#main-error` at the top (`sidepanel.html:230`): every Fill error.
- `#work-portal-access` at the very bottom (`sidepanel.html:584`): the fix for the most common first-visit error.
- `#fill-event-warn` and `#submit-status` inside the results (`sidepanel.html:455,490`).
- `#handoff-banner` near the top (`sidepanel.html:236`): Work link ended or expired.

None of these scroll into view or use `aria-live`. **Rule for the redesign:** one status line directly under the primary button. Every fill message goes there. It is announced to screen readers. The button stays in view.

**Small visual bug:** the step checkbox in the panel picks up the generic form-label style (uppercase, grey, 10px) from `sidepanel.css:325-331`. So the task step looks like a disabled field with an empty box (Screenshot 2, top). It is actually a live "complete this step" control.

---

## 5. The clean, lovable target workflow

**Principles**

- One primary button at a time. It always names the next step.
- Status sits right under that button. Same spot, every time.
- Plain words. Name the payer and the person, never a key.
- Calm and honest. Green means done. Amber means your turn. Red means nothing happened.
- Engineer detail is one click away, and only for admins.

**The action card.** In Work mode the panel always looks like this. Only the middle of the card changes.

```
+--------------------------------------+
| Kansas Fitness Physio            (S) |
| Joseph Knapp > Aetna KS > West Cen.. |
+--------------------------------------+
| Join Aetna network form              |
| Due Oct 13 .  Back to case ->        |
|                                      |
|   << state-specific content >>       |
|   [        PRIMARY BUTTON        ]   |
|   status line, always right here     |
+--------------------------------------+
| > Provider details                   |
| > Log a call, email, or note         |
+--------------------------------------+
```

### (a) Arriving from "Work in portal", first visit to a site

The side panel opens by itself. While it loads, it says "Opening Joseph Knapp, Aetna KS…". It shows no queue.

```
| Join Aetna network form              |
| Due Oct 13 .  Back to case ->        |
|                                      |
| One-time setup for aetna.com         |
| Chrome needs your OK before Minted   |
| can fill forms on this site.         |
|                                      |
| [   Allow Minted on aetna.com    ]   |
| Chrome will ask. Click Allow.        |
```

- The access button takes the exact spot where Fill will be. Fill does not show until access is granted.
- After Allow: "Done. Minted can now fill forms on aetna.com." Then the card turns into (b).
- After Deny: "Minted can't fill this site without your OK. You can still copy details below." The button stays.

### (b) Ready to fill

```
| Aetna form found on this tab.        |
|                                      |
| [         Fill this page         ]   |
| You click Continue and Submit on     |
| Aetna. Minted never submits.         |
```

Next slice adds one line: "We can fill 3 fields on this page."

### (c) Filling

```
| [  ( )  Filling...               ]   |
| Some questions appear only after     |
| others are answered. We wait for     |
| them. Stay on this tab.              |
```

Later: "Filling 2 of 3…" with live counts.

### (d) Page 1 filled: hand the wheel back

```
| (v) Filled 3 fields on this page.    |
|     Green outline = filled by Minted |
|                                      |
| Your turn                            |
| 1. Look over the fields.             |
| 2. Click Continue on the Aetna page. |
|                                      |
| [ Fill this page ]   (outline style) |
| Submitted on Aetna? Log it ->        |
| > Details              (admins only) |
```

- Fill drops to an outline button so it does not look like the next step.
- "Log it" stays reachable from here until the submission is logged.

### (e) Page 2 and later

When the linked tab moves to a new page of the same form, the panel keeps the case. It never fills on its own.

```
| Page 2 . Provider information        |
| New page found.                      |
|                                      |
| [         Fill this page         ]   |
| Page 1: filled 3 fields              |
```

The old result shrinks to a one-line history. Fill is the primary button again. This needs a rule change for what keeps the link alive (see Q3).

### (f) A page with no trained fields, or partial coverage

No trained fields:

```
| Page 3 . Ownership                   |
| Minted hasn't learned this page yet. |
| Please fill it by hand.              |
| Provider details are open below.     |
|                                      |
| v Provider details                   |
|   NPI (Type 1)  1184071342   [Copy]  |
|   CAQH ID       13838326     [Copy]  |
```

Partial:

```
| (v) Filled 12 fields.                |
| (!) 3 fields need you:               |
|   Suite: not in Minted Panel. Add -> |
|   Effective date: not in Minted.     |
|     Add ->                           |
|   Fax: not found on this page        |
| Fill these on Aetna, then Continue.  |
```

### (g) Something went wrong

Every message shows in the status line under the button, with one clear action.

| Problem                                   | Message under the button                                                        | Action button                 |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| Site not allowed                          | (screen a)                                                                      | Allow Minted on aetna.com     |
| Wrong tab is active                       | "Switch to the Aetna tab to fill."                                              | Go to Aetna tab               |
| Page not reachable                        | "We lost touch with the Aetna page. Reload it, then click Fill again."          | Reload page                   |
| Page changed during the fill              | "The page changed while we were filling. Click Fill again."                     | Fill this page                |
| Link to the case ended (tab closed)       | "This tab isn't linked to the case anymore."                                    | Back to case                  |
| Link timed out (60 minutes)               | "This link timed out after 60 minutes."                                         | Back to case                  |
| Fill worked, record not saved             | Green "Filled 3 fields." plus grey "Minted Panel didn't save a record of this fill. That's on us. You can keep going." | Try again, only after a lost connection. None for a server rejection. |
| Account is read-only                      | "Your account can view this case but not fill it. Ask an admin."                | none                          |
| Several locations, none picked            | "Pick the location for this form."                                              | inline location picker        |
| Signed out                                | "Sign in to keep going. Your case is saved."                                    | Sign in                       |

### (h) The end: submitted, logged, done

The human submits on Aetna. Then:

```
| Did you submit on Aetna?             |
| Aetna confirmation # (optional)      |
| [                                ]   |
| Note (optional)                      |
| [                                ]   |
| [x] Also move case to Submitted      |
|                                      |
| [         Log submission         ]   |
```

After logging:

```
| (v) Logged to the case.              |
|     Task "Fill online Join..." done. |
|     Case is now Submitted.           |
|                                      |
| Up next                              |
| Brian Hershberger . UHC MO  [Open]   |
```

In the web app, the task drawer shows "Submitted from the portal by Sowmya S, Oct 14" and the task is checked. No separate "Mark complete" is needed.

**When the fill record did not save (every case fill today).** The coordinator still sees the same "Log submission" form. She never sees a dead end. Until the server can accept a submission without a fill record, the extension saves what it can and says exactly what is left:

```
| (i) Added to the case notes:         |
|     "Submitted Join Aetna network    |
|     form on the portal. Conf #1234." |
|                                      |
| One more step:                       |
| Mark the task done in Minted Panel.  |
| [        Open task in Minted      ]  |
```

This is calm and honest. Her work is saved. The one leftover step has a direct button. The web app is the fallback, not the main path.

---

## 6. How a fill result should read

**What counts as success for a coordinator:** Minted put values into fields on this page. That is it. "Double-checked" is our quality signal, not hers.

**Why "Verified 0" shows every time.** The engine writes values and never reads them back, so it reports every field as "unverified" (`fillEngine.ts` ~1447). No code path ever produces "verified". In R2 all three dropdowns hold the right values, and the panel still says "Verified 0". Until a real read-back ships (slice S2 in the fill-engine review), the panel must not mention checking at all.

| What the engine reports                                | What the coordinator sees                              | Color          |
| ------------------------------------------------------ | ------------------------------------------------------ | -------------- |
| Written and checked (none today)                       | Counted in "Filled N fields"                           | Green          |
| Written, not checked (every field today)               | Counted in "Filled N fields"                           | Green          |
| Written, but the value did not stick (after read-back) | "Needs you: didn't take. Fill it by hand."             | Amber          |
| Not found on this page                                 | "Needs you: not found on this page."                   | Amber          |
| Belongs to another page                                | Nothing (it counts on its own page)                    | none           |
| Hidden on this page                                    | Nothing                                                | none           |
| Manual or file field                                   | "Fields you always fill by hand"                       | Amber, collapsed |
| No value in Minted Panel                               | "Needs you: not in Minted Panel. Add ->"               | Amber          |
| AI not available on this computer                      | Nothing                                                | none           |
| AI guessed some fields                                 | "We guessed 2 more fields (yellow). Keep or Undo."     | Amber          |
| Fill record not saved to Minted Panel                  | One grey line under the green result (see below)       | Grey           |
| Nothing filled at all                                  | "Nothing was filled on this page." + reason + action   | Red            |

**"Filled, but we couldn't double-check."** Count it as filled and say nothing about checking. The "Your turn: look over the fields" step in screen (d) is the honest stand-in, and the green outline on the page shows her where to look. Once read-back ships, only a value that did not stick speaks up (amber). Checked values stay quiet.

### Fill worked, but the fill record did not save

Today this is every case fill. The server rejects the record (422) because the task's step id ("step-0") is not a UUID. The fix is panel-side. The UI question is how to report it.

- **For her, nothing went wrong.** The form is filled. Her next step is the same: click Continue.
- **What she sees:** the green "Filled 3 fields" stays. Under it, one grey line: "Minted Panel didn't save a record of this fill. That's on us. You can keep going."
- **No "telemetry". No red. No "Retry from the case record"** (the case record has no retry).
- **"Try again" only for a temporary cause** (offline, timeout, a server outage). A rejection like today's 422 gets the same answer every time, so it gets no button. A button that can never work teaches her to ignore buttons.
- **It never blocks the next step or the close-out.**
- **Admins** see the real cause in Details ("Fill record rejected: 422, step id is not a UUID") with "Copy for support".

### Close-out: "I submitted it on the portal"

**Principle: the human's submission is a fact on its own.** It must never depend on whether the machine's fill record saved.

- **One button, "Log submission".** It shows in the action card while the case is linked. It survives page changes, because the final Submit usually lands on a new confirmation page.
- **Target behavior:** one click logs the submission, completes the task step, moves the case to Submitted (shown as a checkbox, Q5), then shows "Up next".
- **Today's gap:** for these cases the server refuses a submission without a fill record (`submissionTouches.ts:533-537`, a 422 for any typed case). So when the record failed, the extension cannot complete the step.
- **0.1.8 stopgap (extension only):** in that case, "Log submission" saves a note on the case through the existing "Log a touch" route (type "Portal Check", outcome "Successful", the confirmation number as tracking ID, text "Submitted Join Aetna network form on the portal"). The server takes these on typed cases (`submissionTouches.ts:494` runs before the guard). It cannot complete the step or move the status (`bump_status` is refused on this kind, line 476). So it then says: "Added to the case notes. One more step: mark the task done in Minted Panel." with an "Open task" button (screen h). If Q5 keeps the status move, that line also says "and set the case to Submitted".
- **Next (panel):** accept the submission without a fill record, mark it "no fill record", and complete the step. Then the stopgap goes away (Q4).
- **Never answer with "Reopen the task."** Re-launching and re-filling cannot fix a server-side rejection. That advice sends her in a loop.

**Color rules.** Green means done. Amber means your turn. Grey means "for your information". Red means nothing happened. A green check never sits on a problem. Today it does: the status box only ever removes a "partial" class and never gets an error style (`main.ts:2122`, `sidepanel.css:700-721`).

**Engineer detail.** One "Details" disclosure, closed by default, shown to admins only (the same gate as Train forms). Inside: checked and unchecked counts, selectors, skip reason codes, AI status, fill session id, and a "Copy for support" button. Never field values. Drop the "page has ~N fillable fields" number entirely: it is measured before hidden questions appear, so it is often wrong (it said "~1" on a page that ended with 3).

**Contract note.** All of this is display only. The skip reasons the extension sends to Minted Panel ("field not found on this page" and the other two) are pinned telemetry wording. They must not change.

---

## 7. Prioritized recommendations

### 0.1.8: small, extension-only, highest impact

| #   | Change                                                                                                                                                                                                                                                                     | User problem it fixes                                 | Size | Touches a locked wire contract?                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---- | ----------------------------------------------------- |
| 1   | Put the site-access ask in the Fill button's spot. Hide Fill until the site is allowed. Confirm after Allow.                                                                                                                                                              | R1 blocker: Fill looked ready, the fix was at the bottom | S    | No                                                    |
| 2   | One status line under the Fill button for every fill message. Add `aria-live`. Keep the button in view. Stop sending fill errors to the top box.                                                                                                                          | Errors far from the button                            | S    | No                                                    |
| 3   | New result card: "Filled N fields", "N need you", admin-only "Details". Written fields count as filled; no checked or unchecked counts until read-back exists. No selectors, "setter", "telemetry", page counts, or "AI unavailable" for coordinators.                     | Every good fill reads as a failure ("Verified 0" on every fill) | M    | No (display only, pinned reasons unchanged)          |
| 4   | Fix false colors and the record-failure line. The status box gets real warning and error styles. "Fill record not saved" becomes one grey line under a green result. "Try again" (same fill record id, safe to resend) only for temporary causes, never for a 4xx rejection. | Green check on a dead end. Red alarm on a working fill. A retry that can't work. | S    | No (same route, same body)                            |
| 5   | **Cut (reviewer note 2).** Close-out stopgap: when there is no fill record, "Log submission" saves a case note through the existing structured touch, then shows "One more step: mark the task done in Minted Panel" with an "Open task" button. | Close-out blocked on every case fill today             | S    | No (existing `structured_touch` kind)                |
| 6   | Plain-language copy pass, extension side (section 3).                                                                                                                                                                                                                    | Jargon                                                | S    | No                                                    |
| 7   | Work-mode layout: three collapsible sections, all the same shape: the task card (open by default, with a status pill in its header), "Provider details", and "Log a call, email, or note". Hide org select, provider bar, case select and "Cases that use this page" once a Work case is applied. No queue while a launch loads. Keep every element id so the markup test still passes. **No regression on Provider details:** the existing quick card moves inside the collapsible section unchanged. Keep the Edit layout gear and picker (search, one group per catalog family, picked counts, Save layout / Cancel), the per-user saved layout (`GET/PUT /api/me/view-prefs`, follows the user across orgs), sections in catalog order (Provider, Provider group, Practice location, State license, Facility assignment, Malpractice / insurance, You, the contact families), Copy per field, license expiry badges, "Not on file" plus "Add missing details in Minted Panel", DOB, and "Open in Minted Panel". | Fill buried 2.5 screens down. The case repeated 4 times. | M    | No (view-prefs route and catalog unchanged)           |
| 8   | Open the side panel on a Work launch, like the older launch path already does.                                                                                                                                                                                           | Blank tab. User hunts for the icon.                   | S    | No                                                    |
| 9   | After a fill: "Your turn: click Continue on Aetna" and a "Submitted on Aetna? Log it" link that stays until logged. Rename "Mark submitted" to "Log submission" and show what it does to case status (Q5).                                                               | No next step. Unclear ending.                         | S    | No (`bump_status` is already optional per request)   |
| 10  | Small fixes: step checkbox styling (`sidepanel.css:325` bleeds into `.step-label` at `:1950`). "Filling" text explains the wait.                                                                                                                                          | Looks broken. Looks stuck.                            | S    | No                                                    |

### Next: needs a panel or web app change

| #   | Change                                                                                                                                                                                               | User problem it fixes                         | Size | Wire contract?                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---- | ----------------------------------------------------------- |
| 1   | **Urgent, ship before 0.1.8:** accept step ids like "step-0" end to end: `POST /api/fill-events` validation, a new text step-id column, and the `validate_case_fill_context` trigger plus `record_typed_enrollment_submission` (four `::uuid` casts). Every case fill fails to save its record today, which also blocks close-out. | Close-out blocked on every case fill            | M    | No shape change. Server and database only.                  |
| 2   | Close-out never depends on the fill record: accept "Log submission" without a fill record, mark it "no fill record", and still complete the step (Q4). Retires the 0.1.8 stopgap.               | A server hiccup should never block the human's close-out | M    | Semantics of a locked route change (`fill_session_id` is already optional). Coordinate both repos. |
| 3   | Keep the Work link alive when the portal moves to the next page of the same form. Rule per Q3.                                                                                                       | Page 2 may end the link and wipe the results  | M    | Maybe, if the panel must send the form's page list          |
| 4   | Show "We can fill N fields on this page" in Work mode. The coverage check is off for Work today.                                                                                                     | No idea whether a page is trained             | M    | Maybe (a Work-scoped coverage read)                         |
| 5   | Web app drawer: for Auto-fill steps, lead with Work in portal. Show "Waiting for you to submit on Aetna", then "Submitted from the portal". Demote "Mark complete" to a fallback link. Friendly portal names. Plain launch messages. | Two primary buttons. Code names.              | M    | No                                                          |
| 6   | The launch acknowledgement reports "site not allowed yet", so the web app can say: "First time on aetna.com: click Allow in the Minted side panel."                                                 | A surprise access step                        | S    | **Yes** (`SET_ACTIVE_WORK` ack shape, mirror in `apiTypes.ts`) |

### Later

| #   | Change                                                                                       | User problem it fixes            | Size  | Wire contract?                                         |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------- | ----- | ------------------------------------------------------ |
| 1   | Live progress ("Filling 2 of 3") and a "filled after a question appeared" signal.            | Long silent waits                | M     | Maybe (a new reason code is added panel-first)         |
| 2   | Read values back after writing (slice S2 in the fill-engine review), so a value that didn't stick can say so. | Trust                            | M to L | No                                                     |
| 3   | Page map: "Page 2 of 4" from trained pages, with a check per finished page.                  | Getting lost on long forms       | M     | Maybe                                                  |
| 4   | Setup step: allow all of the org's payer sites at once.                                      | Repeated first-visit asks        | S     | No                                                     |
| 5   | Make Search mode the home for the full quick card ("copy a value" work).                     | Quick card competes with Fill    | S     | No                                                     |

---

## 8. Questions for the PM

**Q1. When should Chrome's site permission be asked?**

- **A. In the side panel, in the Fill button's spot, on the first visit to each site. (Recommended for 0.1.8)**
- B. Once, during setup, for every payer site the org uses. One bigger Chrome dialog.
- C. Both. Setup offers all sites, and the per-site ask is the fallback.

**Q2. Until read-back exists, nothing is ever "checked". How should a fill result read, and who sees the detail?**

- **A. "Filled 3 fields." Green, every time values were written. The "Your turn: look over the fields" step does the checking job. Detail (selectors, reason codes, AI status) sits in a closed "Details" for admins only. (Recommended)**
- B. Same headline, but everyone can open "Details".
- C. Keep today's "Verified 0; 3 unverified" counts for everyone until read-back ships.

**Q3. After the human clicks Continue, the portal shows a new page. What keeps the case linked?**

- A. Same tab and same website. Fill is offered on any page.
- **B. Same tab and same website. Fill is offered only on pages trained for this form. Other pages say "not trained", but the link stays, so Log submission still works. (Recommended)**
- C. Today's rule. Leaving the form's web address ends the link.

**Q4. The fill record did not save. Can the coordinator still log "I submitted it"?**

- **A. Yes, fully. The server accepts the submission, marks it "no fill record", and completes the step. Needs a panel change. (Recommended. Ships through Vercel, so it does not wait on the Store.)**
- B. Yes, partly, now. The extension saves a case note, and she marks the task done in the web app with one click. Extension only. (Not recommended after review: see reviewer note 2.)
- C. No. Keep today's rule: no fill record, no close-out from the extension.

**Q5. What should "Log submission" do?**

- A. Log it, complete the task step, and move the case to Submitted, in one click. (Today, but the button does not say so.)
- **B. The same, with a visible, pre-checked box: "Also move case to Submitted." (Recommended)**
- C. Log it and complete the step only. Status changes stay in the web app.

---

## 9. PM decisions review (Oct 14)

**Question:** after the five removals, is every state still designed, with a clear way out?

**Short answer:** yes for removals 1, 2, 4 and 5, with small additions. Removal 3 needs AI turned off, not just its buttons removed. Two findings block a complete close-out. Neither is caused by the removals.

**Evidence:** extension code on this branch (same as v0.1.7), panel `main` plus the two Oct 14 server fixes, and read-only queries on production (Oct 14).

### 9.1 Blocking findings

| #   | Finding | Why it blocks | Smallest fix | Where |
| --- | ------- | ------------- | ------------ | ----- |
| B1  | **"Also move case to Submitted" cannot really be unchecked.** A database trigger moves the case to Submitted on every extension submission touch, whether or not `bump_status` is sent. `bump_status` only asks the server to report what happened. | An unchecked box would lie. | Replace the checkbox with a plain line: "Logging moves this case to Submitted." Show it only when the case is Not started or In progress. Also send `bump_status: true` on the Work path, so the panel can confirm the move (today it is sent on the manual path only). | panel trigger `case_status_on_touch` (migration `20260719120200`, lines 98 to 104); ext `index.ts:2288` |
| B2  | **"Log submission" only exists after a Fill in this panel.** A coordinator who filled by hand (untrained page, or nothing filled) cannot log. The server now accepts a submission with no fill record, but the extension still refuses one on the Work path. | Close-out dead end | Show "Submitted on {payer}? Log it" whenever the case is linked (Work) or selected on a recognized form (manual), with or without a fill. Remove the two "fill record required" checks in the worker. | ext `main.ts:3706-3708`, `main.ts:2103-2128`, `index.ts:2244`, `index.ts:2250-2258` |

### 9.2 Removal by removal

**Verdicts**

| #   | Removal | Verdict |
| --- | ------- | ------- |
| 1   | Other open tasks and step ticking | **Safe.** Add an "Open task in Minted Panel" link and two after-log messages. |
| 2   | "Checklist task" picker | **Safe.** It never shows in production today. Replace it with a fixed, stated rule. |
| 3   | AI Accept, Clear, Retry | **Not safe alone.** Turn AI off in the fill flow for 0.1.8. |
| 4   | Engineer detail to admin-only Details | **Safe**, if the "Needs you" list stays for everyone and specialists get "Copy support code". |
| 5   | Work-context line to Details | **Safe.** Keep the plain "Opened from Minted Panel · Back to case" line for everyone. |

#### Removal 1: other open tasks and step ticking

| Question | Answer |
| -------- | ------ |
| What the code does today | The case card lists open tasks, with a checkbox per step that writes `PATCH /api/tasks/:id/steps` (`main.ts:1270-1335`, `main.ts:1392-1430`, worker `index.ts:1434`). |
| What she loses | Ticking a step from the panel. |
| How much that matters | Little. In production, all 12 open portal tasks have exactly one step. 14 of 62 open cases have other open tasks, and that work already lives in the web app. |
| Work mode: does Log submission complete the right step? | Yes. The server completes exactly the launched step (`complete_sop_task_step` inside `record_typed_enrollment_submission`). The task closes when that was its last open step. The server refuses (409) if an earlier step is open or the step changed after launch. |
| Manual mode | Legacy cases (case type empty, 64 of 68 cases): the server closes the whole matched task, not a step. Typed cases: the server refuses a manual submission ("Exact Work context is required for typed cases", `submissionTouches.ts:563`). That is latent today: 3 of the 4 typed cases use Work-only forms that manual mode cannot recognize, and the fourth points at a form key with no registration at all. (Two legacy tasks also point at unregistered keys, `aetna_direct` and `bcbs-nc-p2-enrollment-form`, so they have no fill path anywhere. Data cleanup, not a UX change.) |
| New gaps | (a) After logging, a task with more steps stays open and nothing says so. (b) A 409 (the task changed in the web app) offers only "Retry", which can never succeed (`main.ts:3765`). |
| Replacement | The task card shows the current task only, with "Open task in Minted Panel ↗" (`/tasks/{taskId}`, an existing panel route). After logging, re-read the case context: task gone means done; task still open means "This step is done. {N} more steps are in Minted Panel." A 409 shows "This task changed in Minted Panel. Open it to check." with no Retry. |
| Contract impact | None. `PATCH /api/tasks/:id/steps` loses its only extension caller. Leave the route in place. |

**Task card pill:** show the case status ("Not started", then "Submitted"). That is the status the extension changes. One pill only.

#### Removal 2: the "Checklist task" picker

**Today's rule** (`renderTaskLink`, `main.ts:1562-1598`):

- Work mode: "This fill is pinned to {task · step}". No picker. Nothing changes here: the launch already carries the exact task and step.
- Manual mode: 0 matching tasks, log with no task. 1 match, "Will close task: {title}". 2 or more, a picker preset to "Don't link a task".

**Production:** zero case and form pairs have 2 or more open tasks. The picker never shows today.

**New rule (manual mode).** Show the plan in one line above the button, then the matching result after logging.

| Tasks on this case that use this form | Line above the button | After logging |
| ------------------------------------- | --------------------- | ------------- |
| 1, and its other steps are done | "This also closes: {title}." | "Logged. Task done: {title}." |
| 1, with other open steps | "This logs to the case. The task has other steps." | "Logged to the case. Finish the task in Minted Panel." + Open task |
| 0 | "This logs to the case. No task uses this form." | "Logged to the case. No task was closed." + Open case |
| 2 or more | "This logs to the case. {N} tasks use this form." | "Logged to the case. Mark the right task done in Minted Panel." + Open case |

The "other steps" check uses the step list the case context already returns. No new data.

#### Removal 3: AI suggestion controls

| If only the buttons go | Effect |
| ---------------------- | ------ |
| AI values are amber and stay on the page | No way to keep or undo them. |
| Any selection change clears them silently | `clearFillResults` sends `CLEAR_AI_FILL` and restores the old values (`main.ts:1713-1722`). Values she relied on vanish with no message. |
| "Good Catch" learning | Never runs. It needs an accepted receipt (`readAcceptedAiFillReceipt`, `index.ts:280`), and Accept is gone. |
| Who gets AI | Any computer where Chrome's built-in model is already downloaded (`canUseNano`, `src/shared/nanoAi.ts:380`). There is no switch. The same case fills differently on two desks. |

**Recommendation: turn AI off in the fill flow for 0.1.8.** Add one flag (for example `AI_FILL_ENABLED = false` in `src/shared/config.ts`). When it is off, skip `canUseNano` and `PREPARE_AI_FILL` (`main.ts:3584`) and never render `#fill-ai-review`. Nothing amber is written, the "On-device AI is unavailable" line goes away, and Fill starts sooner. Keep the code for a later, designed return. No server or contract change.

#### Removals 4 and 5: detail moves to admin-only Details

| Check | Answer |
| ----- | ------ |
| Admin gate | Use the role in the **current** org. `canTrainForms` means "admin in any org" (`src/shared/panelMode.ts:29`). That is right for training and wrong for case detail. |
| What must stay for everyone | The "Needs you" list: field label, plain reason, and "Add in Minted Panel ↗" for missing provider data. Without it, "3 fields need you" does not say which three. Only selectors, reason codes, checked counts, mapping version and receipt ids move. |
| Fix-it links | "Fix mapping" opens the training flow, which is admin work. Show it only inside Details. |
| A specialist's way out when a fill goes wrong | Every error line and the "record not saved" line get **"Copy support code"**. |
| Support code | Version, short case id, short fill id, time, error code. Example: `MP 0.1.8 · case 74354240 · fill 3f2a9c1e · 14:32 · 422`. No names, no values. The fill id is made in the browser before saving (`fill.ts:869`), so the code exists even when the record did not save. |
| Plain context line | Everyone keeps "Opened from Minted Panel · Back to case". Only the portal key and mapping version move into Details. |

### 9.3 State matrix after the removals

**Modes:** W = launched from "Work in portal". M = manual (Search, queue or picker). S = sandbox. **In prototype:** Yes = in your list. Check = in the section 5 storyboard but not in your list. No = not designed. **NO EXIT** marks a state with no way forward today.

**A. Session and organization**

| #   | State | Mode | In prototype | Primary action | Copy (if not designed) | Exit |
| --- | ----- | ---- | ------------ | -------------- | ---------------------- | ---- |
| A1  | Panel loading | All | No | none | "Loading…" | Automatic |
| A2  | Signed out | All | No | Sign in | Keep today's form | Sign in |
| A3  | Signed out, a launched case is waiting | W, M | No | Sign in | "Sign in to open the case you sent from Minted Panel." | Sign in |
| A4  | Sign-in expired during work | All | No | Sign in | "Your sign-in expired. Sign in again. The case stays linked." | Sign in |
| A5  | Several orgs, none picked | M | No | Pick org | "Pick the organization you're working in." | Pick |
| A6  | Old-style launch for another org | M | No | Switch org | "This case is in {org}." [Switch to {org}] | **NO EXIT.** The prompt sits inside the hidden case area (`sidepanel.html:236`), and picking the wrong org deletes the launch. Fix: move `#handoff-banner` above `#org-field`. |
| A7  | Launch for an org she is not in | W, M | No | Search | "This case is in an organization your account isn't part of. Sign in with the right account, or search." | Search |
| A8  | Read-only role (billing) | All | Yes | none | Show it before Fill, not after a failed save. | Open case |

**B. Arrival, page and selection**

| #   | State | Mode | In prototype | Primary action | Copy (if not designed) | Exit |
| --- | ----- | ---- | ------------ | -------------- | ---------------------- | ---- |
| B1  | Work launch opening | W | No | none | "Opening {provider}, {payer} {state}…" No queue under it. | Automatic |
| B2  | Nothing selected (queue) | M | No | Pick a row | Keep "Pick up where you left off". Empty: "Nothing needs you right now." Error: "Can't load your list right now. Use Search." | Search |
| B3  | Linked, but another tab is active | W | Yes ("wrong tab") | Go to tab | | Go to tab |
| B4  | No form on this tab | M | No | none | "Open the payer's form in this tab to fill it." | Open form |
| B5  | Work-only form opened by hand (Aetna, BCBS KC, BCBS NC) | M | No | Open case | "This form opens from the case. In Minted Panel, click Work in portal." [Open case] | Misleading today: it says "Open a registered payer portal" while she is on one. Copy fix only. |
| B6  | No forms set up for the org | M | No | none | "No payer forms are set up yet. Ask an admin." | none needed |
| B7  | Needs site access | W, M, S | Yes | Allow on {site} | | Allow |
| B8  | Access denied | W, M, S | Yes | Allow on {site} | | Allow again |
| B9  | Provider is in several groups | M | No | Pick group | "Pick the group for this case." | Pick |
| B10 | Several locations, none picked | W, M | No | Pick location | "Pick the location for this form." Picker inline, in the status spot. | Pick |
| B11 | Provider has no open cases | M | No | Search | "{provider} has no open cases. Search for another, or open Minted Panel." | Search |
| B12 | No case picked yet | M | No | Pick case | "Pick the case you're working on." | Pick |
| B13 | "No case · Ad hoc fill" picked | M | No | Fill | **Conflicts with the locked rule** "a case is required before Fill" (sandbox is the only exception). PM: remove it from the picker for 0.1.8, or approve a second exception and update both CLAUDE.md files. | n/a |
| B14 | Case logged as submitted recently (pickup warning) | W, M | No | Continue | "This case was logged as submitted {3 days ago}. Check before you work it again." [Continue] [Open case] | Continue |
| B15 | CAQH form | M | No | Record attestation | "CAQH last attested {date}." [Record attestation]. Future date: "That date is in the future." | Done |
| B16 | Coverage offer (manual only) | M | No | Fill | Light card, not today's dark one: "We can fill {12} of {18} fields on this form." Untested form: "This form hasn't had a test run. Check the result before you submit." Drift detail goes to admin Details. | Fill |

**C. Fill**

| #   | State | Mode | In prototype | Primary action | Copy (if not designed) | Exit |
| --- | ----- | ---- | ------------ | -------------- | ---------------------- | ---- |
| C1  | Ready | W, M | Yes | Fill this page | | |
| C2  | Filling | W, M | Yes | none | | |
| C3  | Filled | W, M | Yes | Your turn | | Continue on portal |
| C4  | Partial: some fields need her | W, M | Check | Your turn | "Filled {12} fields. {3} need you:" then one row each: label, plain reason, "Add in Minted Panel ↗" | Continue on portal |
| C5  | Nothing filled | W, M | Yes | | | |
| C6  | No trained fields on this page | W, M | Check | Provider details | "Minted hasn't learned this page yet. Fill it by hand. Provider details are open below." | Continue on portal |
| C7  | Page changed during the fill | W, M | Yes | Fill this page | | |
| C8  | Wrong tab at click | W, M | Yes | Go to tab | | |
| C9  | Page not reachable | W, M | No | Reload page | "We lost touch with the {payer} page. Reload it, then click Fill again." [Reload page] [Copy support code] | Reload |
| C10 | Fill failed on the page (unexpected) | W, M | No | Try again | "Something on this page stopped the fill. Try again, or fill it by hand." [Copy support code] | Try again |
| C11 | Selection changed during the fill | M | No | Fill this page | "You changed the case while we were filling. The form may be partly filled. Check it, then click Fill again." Today the result is dropped with no message (`main.ts:3661`). | Fill |
| C12 | Record not saved, temporary | W, M | Yes | Try again | | |
| C13 | Record not saved, rejected | W, M | Partial | Keep going | "Minted Panel didn't save a record of this fill. That's on us. You can keep going." [Copy support code]. No Try again. | Continue on portal |
| C14 | Result restored after reopening the panel | W, M | No | Your turn | "From {9:42 PM}" above the result. Keep today's behavior. | |

**D. Page 2 and the link to the case**

| #   | State | Mode | In prototype | Primary action | Copy (if not designed) | Exit |
| --- | ----- | ---- | ------------ | -------------- | ---------------------- | ---- |
| D1  | Page 2, trained | W | Yes | Fill this page | | |
| D2  | Page 2, not trained | W | Check (C6) | Provider details | | |
| D3  | Portal left the form's address | W | Partial | Back to case | Until the page-2 rule ships: "This page isn't part of the form you opened. Go back, or open the case in Minted Panel." | **NO EXIT** until the page-2 rule (Q3) ships: Fill closes and the result clears. |
| D4  | Link timed out (60 minutes) | W | Yes | Back to case | | |
| D5  | Work tab closed | W | No | Back to case | "The {payer} tab was closed. Click Work in portal again." | Back to case |
| D6  | Another launch replaced this one | W | No | none | "You opened another case from Minted Panel. This panel now shows {provider}, {payer} {state}." | |
| D7  | Contract or recredentialing Work | W | No | Open task | "Log this work in Minted Panel." [Open task] | Open task |

**E. Close-out**

| #   | State | Mode | In prototype | Primary action | Copy (if not designed) | Exit |
| --- | ----- | ---- | ------------ | -------------- | ---------------------- | ---- |
| E1  | Log submission form | W, M | Yes, but drop the checkbox (B1) | Log submission | Plan line from 9.2 above the button | |
| E2  | Submitted by hand, never used Fill | W, M | No | Log submission | The same form, reachable without a fill (B2) | **NO EXIT** today |
| E3  | Already logged as submitted recently | W, M | No | Log again | "This case was already logged as submitted {earlier today}. Log it again?" [Log again] [Cancel]. Today there is no Cancel. | Cancel |
| E4  | Logging | W, M | No | none | "Logging…" | Automatic |
| E5  | Logged, task done | W, M | Yes | Up next | "Logged. Task done: {title}. Case moved to Submitted." | |
| E6  | Logged, task has more steps | W, M | No | Open task | "Logged. This step is done. {N} more steps are in Minted Panel." | Open task |
| E7  | Logged, no task closed (manual, 0 or 2+ matches) | M | No | Open case | See the table in 9.2 | Open case |
| E8  | Logged, case already past Submitted | W, M | No | Up next | "Logged. The case stays at {status}." | |
| E9  | Log failed, offline or server down | W, M | No | Try again | "Not logged yet. Your entries are kept. Try again." | Try again |
| E10 | Log failed, task changed in the web app (409) | W | No | Open task | "This task changed in Minted Panel. Open it to check." No Try again. | **NO EXIT** today: only Retry, which repeats the 409 (`main.ts:3765`). |
| E11 | Log failed, typed case in manual mode (422) | M | No | Open case | "Log this from the case: in Minted Panel, click Work in portal." | Latent today |
| E12 | Up next | W, M | Check | Open | Empty: "Nothing else needs you right now." | |

**F. Log a call, email, or note**

| #   | State | Mode | In prototype | Primary action | Copy (if not designed) |
| --- | ----- | ---- | ------------ | -------------- | ---------------------- |
| F1  | Form open | W, M | Yes | Save | Errors: "Pick a type." and "Add one line about what happened." |
| F2  | Saved | W, M | No | none | "Saved to the case." |
| F3  | Save failed | W, M | No | Try again | "Not saved yet. Your entries are kept. Try again." |

**G. Sandbox (entered from Search)**

| #   | State | In prototype | Primary action | Copy (if not designed) |
| --- | ----- | ------------ | -------------- | ---------------------- |
| G1  | Test profile row in Search | No | Open | "Test profile: {provider}. No case needed." |
| G2  | Org has no test provider | No | none | Keep today's note |
| G3  | Test mode, ready | No | Run test fill | Banner: "Test mode. Nothing is saved to a case." |
| G4  | Test fill done | No | Clear form | Same result card as C3, plus [Clear form] [Leave test mode] |
| G5  | Clear form, nothing to clear | No | none | "Nothing to clear." |

**States with no exit today:** A6, D3, E2, E10. **Misleading or silent (exit exists, but she cannot tell):** B5, C11. **Latent:** E11. **Rule conflict:** B13.

### 9.4 Size spec for 0.1.8

One size per job. Every value maps to an existing token, or adds one where none exists.

| Component | 0.1.8 spec | Token or rule | Today |
| --------- | ---------- | ------------- | ----- |
| Primary button | 40px tall, full width, 14px/500 | `--mp-r-btn` (4px) | 44px (`sidepanel.css:403`) |
| Secondary button | 36px tall, 13px/500 | `--mp-r-ctl` | 38px (`:457`) |
| Text link button | 12px/500, primary ink | `--mp-primary` | 11px |
| Input and select | 36px tall, 13px/500 | `--mp-r-ctl`, `--mp-border` | 36px. Matches. |
| Checkbox and radio | 16px square, `accent-color: var(--mp-primary)`, label text 13px sentence case | new reset rule | Inherits the 100% wide, 36px tall input rule (`:349`) |
| Card (task card, result card, notices) | 12px padding, 1px border, 6px radius, 12px between cards | `--mp-r-card`, `--mp-border` | 8, 9, 10 and 11px paddings; 4px or 6px radius |
| Collapsible section header | 36px row, 13px/600 sentence case title, 12px chevron, optional pill on the right | new | n/a |
| Status pill | 20px tall, 0 8px padding, 11px/600, tone tint background | `--mp-r-ctl`, `--mp-*-tint` | about 17px (`:522`) |
| Status line under the button | 12px/1.45, 12px icon, 8px top margin, left aligned. Tones: ok, warn, danger, neutral. | `--mp-ok`/`--mp-warn`/`--mp-danger` and their tints | `.error` 11.5px, `.logged` bold 12.5px, `.btn-note` 11px centered |
| Field label | 11px/600, uppercase, 0.06em spacing, secondary ink. Only above a field, never beside a checkbox. | `--mp-ink-secondary` (about 4.8:1 contrast) | 10px/700 in `--mp-label` (about 2.4:1, fails WCAG AA) (`:325`) |
| Helper and caption text | 11px/400, secondary ink | `--mp-ink-secondary` | `--mp-ink-faint` (about 2.5:1, fails AA) |
| Mode switch | 32px segmented control | `--mp-r-ctl` | about 30px. Close enough. |
| Icon button | 28px hit area, 16px icon | `--mp-r-ctl` | gear 24px. Fine. |
| Type scale | Title 14/600 · Body 13/400 · Small 12/400 · Caption 11/500 · Mono IDs 12/400 | `--mp-font`, `--mp-mono` | 12 sizes in use: 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13 and 14px |
| Spacing | 14px panel gutter, 12px between blocks, 8px inside blocks | `main` padding | Mostly matches |
| Warning and error colors | Token tints only | `--mp-warn-tint`, `--mp-danger-tint` | Hard-coded hex in `.error` (`:675`), `.gap-flag`, `.dup-warn`, `.dup-pickup`, `.sandbox-bar` (`:616`) |

**Current violations to fix in 0.1.8**

1. The step checkbox: the input rule (`:349`) makes it 100% wide and 36px tall, and the label rule (`:325`) makes its text 10px grey uppercase. It goes away with removal 1, but the cause stays. **Any new checkbox**, including one for "Also move case to Submitted", would look the same. Fix the two generic rules: add a checkbox and radio reset, and scope the uppercase style to `.field > label`.
2. `.capture-row-tick` (`:2107`) in Train forms has the same oversized box.
3. Three heights stacked together: primary 44, secondary 38, inputs 36.
4. Tiny labels: `.case-note-label` (`:939`) and `.case-context-label` (`:971`) at 9.5px. `.section-title` and `.exec-chip` at 10px.
5. `.logged` (`:700`) is bold 12.5px with a green check, and it is used for problems too. `.error` (`:675`) is 11.5px. Status lines need one size and four tones.
6. Mixed radius: `.handoff-banner`, `.nba-card` and `.sandbox-bar` use 4px; other cards use 6px.
7. `.offer-card` is a dark green slab in a light panel. Make it a light card like the others.

### 9.5 Prototype changes needed

| #   | State | Change |
| --- | ----- | ------ |
| 1   | E1 Log submission | Remove the "Also move case to Submitted" checkbox. Add the plain line "Logging moves this case to Submitted." (only when Not started or In progress). Add the plan line from 9.2 above the button. |
| 2   | E2 Filled by hand | Show "Submitted on {payer}? Log it" whenever the case is linked or selected on a recognized form, even with no fill. |
| 3   | E5 to E11 After logging | Add variants: task done; step done but task has more steps (Open task); no task closed (Open case); case already past Submitted; offline (Try again); task changed (Open task, no Try again); manual typed case (Open case). |
| 4   | Task card | Current task only: title, due date, plain "Auto-fill" text, one case-status pill, "Open task in Minted Panel ↗". Manual variants: "No task on this case uses this form" and "{N} tasks use this form". No step checkboxes. |
| 5   | C3, C4 Results | No amber AI guesses and no Keep or Undo anywhere (AI is off). Partial keeps a "Needs you" list for everyone: label, plain reason, Add link. |
| 6   | Errors | Add "Copy support code" to every error and to "record not saved". Add a "Details" link for admins of the current org only. "Fix mapping" lives inside Details. |
| 7   | A3, A4, A5, A6, A7 | Add the session and org states. The org-switch prompt sits above the org picker, never inside the case area. |
| 8   | B1, B5, B9 to B16 | Add launch loading; "This form opens from the case" (Work-only form opened by hand); group, location and case picking; no open cases; pickup warning; CAQH; the manual coverage card as a light card. |
| 9   | C9 to C11, C13, C14 | Add page not reachable; fill failed on the page; selection changed during the fill; record rejected (no Try again); restored result label. |
| 10  | D3, D5, D6, D7 | Add the link-ended, tab-closed, launch-replaced, and contract or recredentialing states. |
| 11  | E3 | Duplicate submission warning with [Log again] and [Cancel]. |
| 12  | F2, F3 | "Saved to the case." and the save-failed state for "Log a call, email, or note". |
| 13  | G1 to G5 | Sandbox states, using the same result card with a "Test mode" banner. |
| 14  | B13 | Remove "No case · Ad hoc fill" from the case picker, pending the PM's call. |
| 15  | All | Apply the 9.4 size spec: 40 / 36 / 36 heights, 16px checkboxes, 20px pills, 36px section headers, 12px card padding with 6px radius, 11px labels in secondary ink. |
