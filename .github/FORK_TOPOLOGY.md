# Fork branch topology

This fork keeps upstream source and local daemon patches on separate refs.

- `upstream-main` is an exact, force-updated mirror of
  `PrimeIntellect-ai/prime-agent:main`. It contains no fork commits.
- `daemon-durability` is the default and tested integration branch. Its local
  commits are replayed on each fetched upstream revision.
- `daemon-durability-base` is a lightweight tag. It records the upstream commit
  under the currently published integration patch range. Do not move it by
  hand.

The default branch must be `daemon-durability`. GitHub only schedules workflows
from the default branch. Enable Issues on the fork so a blocked integration can
raise its managed alert. The repository Actions policy must allow the ephemeral
`GITHUB_TOKEN` to write contents and issues. Branch and tag rules must allow the
workflow to force-update both managed branches and the marker tag. No personal
access token is needed or used. Checkout does not persist credentials; the
job-scoped contents token is present only in the two Git write steps and is not
placed in a remote URL.

After this workflow is pushed, set the two repository prerequisites:

```sh
gh repo edit gildrb/prime-agent \
  --default-branch daemon-durability \
  --enable-issues
```

Configure the Actions and managed-ref rules in repository settings before the
first dispatch.

## Automated update

`.github/workflows/sync-daemon-durability.yml` runs daily at 07:17 UTC and on
manual dispatch. It performs these steps:

1. Fetch the fork refs and `PrimeIntellect-ai/prime-agent:main`. Resolve the
   durability patch range from `daemon-durability-base`, not a hardcoded commit.
   On the first run only, the workflow safely bootstraps the tag from
   `upstream-main` when that commit is an ancestor of `daemon-durability`.
2. Force-update `upstream-main` with a lease, so it points to the exact fetched
   upstream commit. A failed integration does not leave the mirror stale.
3. Rebase the saved patch range onto that commit in a temporary branch. Merge
   commits or an invalid marker fail closed instead of guessing a patch range.
4. Restore the npm cache, try `npm ci --ignore-scripts --offline`, and fall back
   to `npm ci --ignore-scripts` only when the cache is incomplete. Run
   `npm run check`. Then derive the changed
   `packages/coding-agent/test/**/*.test.ts` files from the rebased patch range
   and pass each path directly to Vitest. The workflow never runs a generic
   test, build, or development command.
5. After the check and every affected Vitest file pass, atomically force-update
   `daemon-durability` and advance `daemon-durability-base`. Force-with-lease
   checks prevent a concurrent branch rewrite from being overwritten.

A conflict, check failure, test failure, dirty checked tree, or publication race
leaves `daemon-durability` and its base tag unchanged. The `upstream-main`
mirror can still advance. The workflow creates or updates the managed
`daemon-durability integration is blocked` issue with a link to the failed run.
The next successful run closes that issue.

Run it manually after changing the patch series:

```sh
gh workflow run sync-daemon-durability.yml --ref daemon-durability
```
