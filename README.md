<div align="center">
  <strong>agentlinker</strong>
  <br />
  <em>One canonical .agents folder that powers all your AI tools.</em>

  <br /><br />
  <em>
    Simple setup • One source of truth • Safe to re-run anytime
  </em>
</div>

## Quick Start

Requirements: Node 18+ or Bun 1.3+.

Run the guided CLI:
```bash
npx agentlinker
```

Or with Bun:
```bash
bunx agentlinker
```

Choose a workspace (Global, Monorepo, or Project), select the clients you want to manage, and follow the prompts. You can run it again anytime to repair links or undo changes.

## Commands

### Initialize
Create a new `.agents` folder:
```bash
agentlinker init                    # Interactive
agentlinker init --scope=project    # Non-interactive (project scope)
agentlinker init --scope=global     # Non-interactive (global scope)
```

### Compose (Monorepo)
Selectively inherit from parent `.agents`:
```bash
agentlinker compose                 # Interactive picker
agentlinker compose --include-commands=build.md,test.md --agents-md=extend
```

### Watch (Monorepo)
Auto-rebuild merged content on file changes:
```bash
agentlinker --watch
```

### Dry Run
Preview changes without applying:
```bash
agentlinker --dry-run
```

## What it does

- Keeps `.agents` as the source of truth.
- Creates symlinks for Claude, Codex, Factory, Cursor, and OpenCode.
- Supports monorepos with hierarchical config inheritance.
- Always creates a backup before any overwrite so changes are reversible.

## Workspaces

### Global (~/.agents)
Affects all projects on your machine. Links agent files, commands, hooks, and skills to each client's global config directory.

### Project (.agents)
Standalone project configuration. Links only commands, hooks, and skills into the current project's client folders.

### Monorepo (.agents)
Hierarchical inheritance for monorepos. Child packages can extend or override parent configurations.

## Monorepo Support

agentlinker automatically detects when you're in a monorepo by walking up the directory tree looking for `.agents` folders.

### Inheritance Chain

```
~/.agents (global) → monorepo/.agents (root) → packages/foo/.agents (child)
```

When you select "Monorepo" scope, agentlinker prompts you to configure inheritance:

- **Inherit all** - Use parent config for everything
- **Standalone** - Ignore parent config completely
- **Configure per-resource** - Choose behavior for each resource type

### Configuration File

Create `.agents/config.yaml` to control inheritance:

```yaml
# Simple: inherit everything from parent
extends: true
```

```yaml
# Simple: standalone (ignore parent)
extends: false
```

```yaml
# Fine-grained control per resource
extends:
  AGENTS.md: extend      # Concatenate parent + child content
  commands: inherit      # Use parent's commands
  skills: extend         # Merge parent + child skills
  hooks: override        # Use only child's hooks
  default: inherit       # Default for unlisted resources

# Optionally exclude specific files
exclude:
  - commands/deprecated-*.md
```

### Extend Behaviors

| Behavior | Description |
|----------|-------------|
| `inherit` | Use parent's resource (child ignored if parent exists) |
| `extend` | Merge parent + child (markdown concatenated, directories unioned) |
| `override` | Use only child's resource (parent ignored) |
| `compose` | Cherry-pick specific items from parent + all from child |

### Selective Inheritance with Compose

Use `agentlinker compose` to interactively select which commands, skills, and hooks to inherit from parent `.agents` folders:

```bash
cd packages/web
agentlinker compose
```

Or use flags for non-interactive mode:

```bash
agentlinker compose \
  --include-commands=build.md,lint.md \
  --include-skills=shared-skill/ \
  --agents-md=extend
```

This creates a config with selective inheritance:

```yaml
extends:
  AGENTS.md: extend
  commands: compose
  skills: compose
  hooks: inherit

include:
  commands:
    - build.md
    - lint.md
  skills:
    - shared-skill/
```

### Example Monorepo Structure

```
my-monorepo/
├── .agents/                      # Root config
│   ├── AGENTS.md                 # Shared instructions
│   ├── commands/
│   │   └── build.md
│   └── skills/
│       └── shared-skill/
│
├── packages/
│   └── web/
│       ├── .agents/              # Child config
│       │   ├── config.yaml       # extends: { commands: extend }
│       │   ├── AGENTS.md         # Package-specific additions
│       │   └── commands/
│       │       └── deploy.md     # New command
│       └── package.json
```

When running `agentlinker` in `packages/web/`:
- AGENTS.md is merged (root + child content)
- Commands include both `build.md` (from root) and `deploy.md` (from child)
- Skills are inherited from root

## Where it links (global scope)

`.agents/CLAUDE.md` → `~/.claude/CLAUDE.md` (if present)

`.agents/AGENTS.md` → `~/.claude/CLAUDE.md` (fallback when no CLAUDE.md)

`.agents/commands` → `~/.claude/commands`

`.agents/commands` → `~/.factory/commands`

`.agents/commands` → `~/.codex/prompts`

`.agents/commands` → `~/.cursor/commands`

`.agents/commands` → `~/.opencode/commands`

`.agents/hooks` → `~/.claude/hooks`

`.agents/hooks` → `~/.factory/hooks`

`.agents/AGENTS.md` → `~/.factory/AGENTS.md`

`.agents/AGENTS.md` → `~/.codex/AGENTS.md`

`.agents/AGENTS.md` → `~/.config/opencode/AGENTS.md`

`.agents/skills` → `~/.claude/skills`

`.agents/skills` → `~/.factory/skills`

`.agents/skills` → `~/.codex/skills`

`.agents/skills` → `~/.cursor/skills`

`.agents/skills` → `~/.opencode/skills`

## Development

Run the CLI in dev mode:
```bash
bun run dev
```

Type-check:
```bash
bun run type-check
```

Run tests:
```bash
bun test
```

Build the CLI:
```bash
bun run build
```

## Notes

- Cursor supports `.claude/commands` and `.claude/skills` (global or project). agentlinker also links `.agents/commands` → `.cursor/commands` and `.agents/skills` → `.cursor/skills`.
- OpenCode uses `~/.config/opencode/AGENTS.md` and prefers AGENTS.md over CLAUDE.md when both exist.
- Codex prompts always symlink to `.agents/commands` (canonical source).
- Skills require a valid `SKILL.md` with `name` + `description` frontmatter.
- Claude prompt precedence: if `.agents/CLAUDE.md` exists, it links to `.claude/CLAUDE.md`. Otherwise `.agents/AGENTS.md` is used. After adding or removing `.agents/CLAUDE.md`, re-run agentlinker and apply/repair links to update the symlink. Factory/Codex always link to `.agents/AGENTS.md`.
- Project scope creates `.agents` plus client folders for commands/hooks/skills only. Rule files (`AGENTS.md`/`CLAUDE.md`) are left to the repo root so you can manage them explicitly.
- Backups are stored under `.agents/backup/<timestamp>` and can be restored via "Undo last change."
- Merged content (for monorepo `extend` mode) is stored in `.agents/merged/` and regenerated as needed.

## License

MIT
