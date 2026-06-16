# Documentation project instructions

## About this project

- Documentation for **Filecheck**, a preflight and file-upload policy layer.
- Built on [Mintlify](https://mintlify.com). Pages are MDX with YAML frontmatter; configuration is in `docs.json`.
- Run locally with `mint dev` (install with `npm i -g mint`).
- Source of truth for the Element/API surface is the engineering integration reference. Keep code samples consistent with it.
- `openapi.json` is generated, not hand-edited. Regenerate it with `node scripts/build-openapi.mjs`, which reads the request schemas from the sibling `filecheck-api` repo. Re-run it whenever the API changes.

## Terminology

- Use **Workflow** (`workflowId`, `wf_…`), never "rule" or `ruleId`. This is the most common integration mistake.
- Use **Element** for the embeddable widget, **job** (`job_…`) for one run of a file through a Workflow.
- Keys: **publishable key** (`pk_…`, browser) and **secret key** (`sk_…`, server-side only).
- Gate the submit button on **`canProceed`**; never re-derive it.

## Style preferences

- Active voice, second person ("you").
- Concise sentences, one idea each. Sentence case for headings.
- Bold for UI elements (Click **Settings**); code formatting for file names, commands, ids, and code.
- Prefer `workflowId` in every snippet. Dimensions from `facts` are millimetres.

## Content boundaries

- Document the public Element API, integrations, and server-side verification.
- Do not document internal admin implementation or the monorepo.
- The secret key is server-side only; never show it in browser snippets.
