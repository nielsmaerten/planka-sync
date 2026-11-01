---
name: planka-issue-workflow
description: Resolve planka-sync GitHub issues through reproduction, a targeted fix, and Codex PR review; cut a release when requested. Use for issue implementation, not issue summaries.
---

# Issue to reviewed PR

1. Read the selected issue and its discussion in `nielsmaerten/planka-sync`, then trace the
   affected code. Follow `REVIEW.md`. Preserve unrelated work and record the starting branch.
2. Reproduce locally before fixing. Prefer a regression test using the real sync engine,
   temporary mirror, and isolated Planka state; establish that it fails for the reported reason.
   If the premise does not hold, explain the evidence before changing behavior.
3. Make the smallest targeted fix that addresses the shared cause. Preserve data-loss guards.
   Document deliberate limitations with `ponytail:`, including when to revisit them.
4. Verify the reproduction now passes and relevant boundaries still hold. Run the project
   gates: `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
5. Inspect the staged diff, commit as `ember <ember@niels.me>`, push a topic branch, and open
   a PR describing the bug, resulting behavior, reproduction, and validation. Link the issue
   with `Fixes #N` when appropriate.
6. Monitor CI and the automatic Codex review. If no review starts, request `@codex review`
   once; avoid duplicating a running review. Read comments and review findings, not just status.
7. Evaluate findings against `REVIEW.md`: fix valid findings, verify, and push to the same PR;
   explain declined findings in their threads. Ensure Codex reviews the new head, requesting
   another review if needed. Continue until CI passes and Codex gives a thumbs-up or an explicit
   clean review for the current commit. Silence, an eyes reaction, or approval of an older head
   does not count. If access, CI infrastructure, or review availability blocks progress, report
   the concrete blocker; never treat it as approval or bypass a required check.
8. **Wait by default after approval.** Report the PR and checks, leaving it open for Niels.
   Merge only if Niels explicitly authorized merging, including an earlier instruction to
   merge once approved. Verify the reviewed head is unchanged when merging, then verify the
   merge and linked issue state. Release only when requested.

# Requested releases

- Release metadata may go **directly on `main`; no extra release PR is needed**. Update from
  origin without overwriting local work. Choose a patch bump for a bug fix unless specified
  otherwise; update `package.json` and date `CHANGELOG.md` using DD/MM/YYYY.
- Verify formatting and build, inspect the staged diff, and commit as Ember. Push the release
  commit to `main`, then tag that exact commit `v<version>` and push the tag. Confirm the tag
  matches `package.json`; never move or replace an existing release tag.
- `.github/workflows/publish.yml` starts on a pushed `v*` tag; creating a GitHub Release is not
  needed to trigger it. Verify the workflow run for the tag and report its link and actual state.
  The workflow runs CI and uses the `npm` environment approval gate. Leave that approval to
  Niels; do not report the package as published until publication is confirmed.
