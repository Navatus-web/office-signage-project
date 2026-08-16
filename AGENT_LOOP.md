# AI Agent Loop

This project now has a repo-level agent loop runner. It is separate from the signage app itself.

Run one dry cycle:

```sh
npm run agent:loop -- --cycles=1
```

Run with OpenAI:

```sh
OPENAI_API_KEY=... npm run agent:loop -- --cycles=3
```

On Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="..."
npm run agent:loop -- --cycles=3
```

By default the loop is dry-run. It observes `git status`, runs `npm test`, lists project files, asks the model for the next bounded action, and stores state in `.agent-loop/state.json`.

To let it write notes to `.agent-loop/notes.md`:

```sh
npm run agent:loop -- --cycles=3 --dry-run=false
```

Allowed actions are intentionally narrow:

- `check`: rerun `status`, `test`, or `files`
- `note`: append a Markdown note
- `stop`: end the loop

It does not execute arbitrary shell commands or edit application code. That keeps the loop useful as a project watcher and planner while leaving code changes to a human-reviewed coding pass.
