# Direct-push cards and backfill PRs

These cards were merged straight into `main` by direct push, which violates process (every card = branch `l3/<card>` + PR with specific title + tests/CI + review before merge).

Each was backfilled with a PR from `l3/<card>` into `l3/pre-<card>` (the parent of the card's first commit). The backfill PRs carry the label `backfill`, are the review/audit record only, and are NOT counted as real merges to main. Nothing on `main` was rewritten.

| Card | Card commits | Main commit | Backfill PR | Status |
|---|---|---|---|---|
| adapter-types | e7bdc20..e7bdc20 | e7bdc20 | #22 | merged |
| router | a2b6fdd..a2b6fdd | a2b6fdd | #23 | merged |
| adapter-claude | ce488e7..ce488e7 | ce488e7 | #24 | merged |
| adapter-dsh | 87885ac..87885ac | 87885ac | #25 | merged |
| adapter-agy | c70c822..c70c822 | c70c822 | #26 | merged |
| adapter-copilot | 065600e..065600e | 065600e | #27 | merged |
| adapter-codex | dd623b3..dd623b3 | dd623b3 | #28 | merged |
| probe | e421746..e421746 | e421746 | #29 | merged |

Cards that could not be isolated: none.

Note: the backfill PRs are merged into their `l3/pre-*` branches, not main. No independent review has happened; the content still needs a real review.
