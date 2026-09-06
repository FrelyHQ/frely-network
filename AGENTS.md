# Repository Instructions

## Documentation Governance

Use the `project-governance` document-maintenance workflow for project-owned documentation:

1. Inspect the documentation scope before making lifecycle or structural changes.
2. Create a maintenance plan for non-trivial document changes.
3. Apply only the authorized document scope.
4. Verify contracts, lifecycle fields, links, identifiers, indexes, and traceability after changes.

Project-governed records—requirements, baselines, plans, evaluations, defects,
archives, coverage, verification, and traceability—must use a valid persistent
`queryable-markdown` contract. For level-2 records with structured IDs and the
standard governance labels, prefer the shared profile
`project-governance/governed-document-v1`.

Keep `README.md` as ordinary user-facing documentation; never add persistent
mdq metadata to it. Do not infer lifecycle status or semantic completion from
file location, document age, commit messages, or passing tests.
