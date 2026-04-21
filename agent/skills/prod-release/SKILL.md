---
name: prod-release
description: Create or update a staging-to-production release PR. Use when user asks to create a production release, release PR, promote staging to production, or fix an existing release PR description.
user_invocable: true
---

# prod-release

Create or update a staging → production release PR for the current repo.

## Arguments

- No args: create a new release PR
- `<PR number>`: update an existing PR's description to match the release format

## Branch names

- **Production branch**: `production` (all repos that use this skill)
- **Source branch**: `staging`

Do NOT guess or probe for branch names. Do NOT run `git remote show`, `git branch -r | grep`, or similar exploratory commands.

## Steps

1. Determine the correct production branch name from the mapping above.

2. Fetch latest from both branches:
   git fetch origin staging

3. List commits on staging not in the production branch:
   git log --oneline origin/..origin/staging

4. For each commit, determine:
   - Whether it came from a PR (parse commit message for PR numbers like `(#123)`)
   - The author (use `git log --format='%aN' -1 <hash>`, then look up their GitHub @handle via `gh api` if needed)
   - The type: Feature, Enhancement, Fix, or Chore (infer from commit message prefix: `Feat` → Feature, `Enh` → Enhancement, `Fix` → Fix, `Chore` → Chore)
   - For PRs: fetch the PR body via `gh pr view <number> --json body` to extract:
     - A two-line summary of the change
     - Any deployment dependencies (e.g. env vars, config changes, migrations, dependent service deployments)
   - If a PR body is empty or missing: flag it in the Change Details section (see format below) and tag the author asking them to add a description

5. Determine the current ISO week number for the title.

6. If **creating**: use `gh pr create --base <production-branch> --head staging`
   If **updating**: use `gh pr edit <number> --body`
   - **Title**: `Production Release | Week {N}`
   - **Body**: A numbered table (see format below)

## Body format

```markdown
## Production Release | Week {N}

| # | PR / Commit | Author | Type |
|---|-------------|--------|------|
| 1 | [#123](https://github.com/{org}/{repo}/pull/123) — Short description | @github-handle | Feature |
| 2 | Fix: Short description | @github-handle | Fix |
| 3 | Chore: Short description | @github-handle | Chore |

### Change Details

**#123 — Short description**
First sentence of summary. Second sentence of summary.

---

**#456 — Short description**
First sentence of summary. Second sentence of summary.

---

**#789 — Short description**
First sentence of summary. Second sentence of summary.

---

**#101 — Short description**
**Missing PR description.** @github-handle please add a description to [#101](https://github.com/{org}/{repo}/pull/101).

### Deployment Dependencies

> - #123: Requires `NEW_ENV_VAR` to be set before deploy
> - #456: Deploy `other-service` first

If no PRs have deployment dependencies, omit this section entirely.
```

## Rules

- Link to the PR when one exists; otherwise use the commit message directly
- Use the GitHub @handle for authors
- Types: Feature, Enhancement, Fix, Chore
- Keep descriptions short — one line per row
- For Change Details, use a ### Change Details section. Each PR gets a bold heading line (**#N — Short description**) with a two-sentence summary below it, separated by --- dividers.
- If a PR has an empty or missing body, replace its summary with a warning: **Missing PR description.** @github-handle please add a description to [#N](url). — this tags the author so they get a GitHub notification.
- For deployment dependencies, scan each PR body for mentions of env vars, config changes, migrations, infrastructure changes, or dependent service deployments. Only include the section if at least one PR has dependencies.
- Do NOT run exploratory commands to find branch names (no git remote show, no git branch -r | grep). Use the mapping above.
- Reference example: dashboard-service PR #4573