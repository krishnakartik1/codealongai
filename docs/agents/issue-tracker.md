# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues for
`krishnakartik1/codealongai`. Use the `gh` CLI for all operations.

## Conventions

- Create, read, comment on, label, assign, and close issues using `gh issue`.
- Infer the repository from `git remote -v`.
- PRs are not a triage request surface.
- When a skill says “publish to the issue tracker,” create a GitHub issue.
- When a skill says “fetch the relevant ticket,” read the issue and its comments.

## Wayfinding operations

- A map is an issue labelled `wayfinder:map`.
- Decision tickets are native sub-issues labelled `wayfinder:research`,
  `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Claims use issue assignment; open and unassigned means unclaimed.
- Blocking uses GitHub’s native issue dependencies.
- The frontier contains open, unblocked, unassigned children.
- Resolution means commenting with the answer, closing the ticket, and adding
  a title-linked gist to the map’s Decisions-so-far section.
