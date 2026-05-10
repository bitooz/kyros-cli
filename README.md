<img width="990" height="702" alt="image" src="https://github.com/user-attachments/assets/a1f0d29b-44c4-40e0-b824-34907088ae1c" />

# Kyros CLI

Kyros is a multi-agent command-line workspace for running Claude Code, Codex, and OpenCode from one terminal UI.

Learn more at [kyros.team](https://kyros.team).

## What It Does

- Opens an interactive terminal UI for the current folder.
- Runs single-agent sessions with Claude Code, Codex, or OpenCode.
- Runs project teams from `.kyros` context files and role definitions.
- Saves and reuses local or global team definitions.
- Installs MCP servers across supported providers.
- Checks GitHub release manifests for CLI updates.

## Install

This repository currently contains the source for the CLI.

```sh
pnpm install
pnpm build
pnpm start
```

For local development:

```sh
pnpm dev
```

## Usage

```sh
kyros
kyros team "ship the next milestone"
kyros --team api
kyros teams
kyros models --json
kyros mcp add context7
kyros mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-env GITHUB_TOKEN
```

Common options:

```sh
kyros --provider codex
kyros --provider claudeCode
kyros --provider opencode
kyros --model <model>
kyros --cwd ~/code/app
```

## Project Teams

Kyros can auto-enter team mode when a project includes these files:

```text
.kyros/goal.md
.kyros/plan.md
.kyros/spec.md
.kyros/tasks.md
.kyros/roles.json
```

Saved teams can also live in `.kyros/teams/` for a repository or in the global Kyros config directory.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

The CLI is written in TypeScript, uses Ink for the terminal UI, and Vitest for tests.

## License

MIT
