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
