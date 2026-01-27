# agentlinker - AI Assistant Skill Guide

## Overview

agentlinker is a CLI tool that manages a canonical `.agents` folder, creating symlinks to distribute configuration across multiple AI coding assistants (Claude, Cursor, Codex, Factory, OpenCode).

**Core concept**: One source of truth (`.agents/`) that automatically syncs to all AI tool config directories.

## When to Use agentlinker

Use agentlinker when a user wants to:
- Set up shared AI assistant configuration across tools
- Manage commands, skills, hooks, or AGENTS.md files
- Configure monorepo inheritance for AI configs
- Sync `.agents` folder to Claude, Cursor, Codex, Factory, or OpenCode

## CLI Commands

### Basic Usage

```bash
# Interactive mode - guided setup
agentlinker

# Initialize a new .agents folder
agentlinker init
agentlinker init --scope=project    # Non-interactive
agentlinker init --scope=global     # Non-interactive

# Selective inheritance in monorepos
agentlinker compose                 # Interactive picker
agentlinker compose --include-commands=build.md,test.md --agents-md=extend

# Preview changes without applying
agentlinker --dry-run

# Watch mode for monorepos (auto-rebuild on changes)
agentlinker --watch
```

### Command Flags

| Flag | Description |
|------|-------------|
| `--scope=global\|project` | Skip interactive scope selection |
| `--dry-run` | Preview changes without applying |
| `--watch` | Watch for file changes and rebuild |
| `--include-commands=a.md,b.md` | Compose: select commands from parent |
| `--include-skills=skill-a/` | Compose: select skills from parent |
| `--include-hooks=hook-a/` | Compose: select hooks from parent |
| `--agents-md=inherit\|extend\|override` | How to handle AGENTS.md |
| `--yes`, `-y` | Skip confirmation prompts |

## Directory Structure

### .agents Folder Layout

```
.agents/
├── AGENTS.md           # Main AI instructions (or CLAUDE.md)
├── CLAUDE.md           # Optional: Claude-specific override
├── config.yaml         # Monorepo inheritance config
├── commands/           # Slash commands (markdown files)
│   └── build.md
├── skills/             # Reusable skill directories
│   └── my-skill/
│       └── SKILL.md
├── hooks/              # Event hooks
│   └── pre-commit/
├── merged/             # Auto-generated merged content (monorepo)
└── backup/             # Auto-created backups before changes
```

### Symlink Targets by Client

| Source | Claude | Factory | Codex | Cursor | OpenCode |
|--------|--------|---------|-------|--------|----------|
| `AGENTS.md` | `~/.claude/CLAUDE.md` | `~/.factory/AGENTS.md` | `~/.codex/AGENTS.md` | - | `~/.config/opencode/AGENTS.md` |
| `commands/` | `~/.claude/commands` | `~/.factory/commands` | `~/.codex/prompts` | `~/.cursor/commands` | `~/.opencode/commands` |
| `skills/` | `~/.claude/skills` | `~/.factory/skills` | `~/.codex/skills` | `~/.cursor/skills` | `~/.opencode/skills` |
| `hooks/` | `~/.claude/hooks` | `~/.factory/hooks` | - | - | - |

## Monorepo Configuration

### config.yaml

```yaml
# Simple: inherit everything
extends: true

# Simple: standalone (ignore parent)
extends: false

# Fine-grained control
extends:
  AGENTS.md: extend      # Concatenate parent + child
  commands: compose      # Cherry-pick specific items
  skills: inherit        # Use parent's skills
  hooks: override        # Use only child's hooks
  default: inherit       # Default for unlisted

# When using compose behavior, specify which items to include
include:
  commands:
    - build.md
    - lint.md
  skills:
    - shared-skill/

# Optional: exclude patterns
exclude:
  - commands/deprecated-*.md
```

### Extend Behaviors

| Behavior | Description |
|----------|-------------|
| `inherit` | Use parent's resource entirely |
| `extend` | Merge parent + child (concat markdown, union directories) |
| `override` | Use only child's resource |
| `compose` | Cherry-pick specific items from parent + all from child |

### Inheritance Chain

```
~/.agents (global) → monorepo/.agents (root) → packages/foo/.agents (child)
```

Child configs override parent configs. The chain is resolved by walking up the directory tree.

## Workflow Examples

### Example 1: New Project Setup

```bash
cd my-project
agentlinker init --scope=project
# Creates .agents/ with AGENTS.md template
agentlinker
# Links to Claude, Cursor, etc.
```

### Example 2: Monorepo Child Package

```bash
cd packages/web
agentlinker init --scope=project
agentlinker compose --include-commands=build.md,test.md --agents-md=extend --yes
agentlinker
```

### Example 3: Global Configuration

```bash
agentlinker init --scope=global
# Creates ~/.agents/
agentlinker
# Links to all client global configs
```

## Supported Clients

- **Claude** (`claude`): Claude Code CLI
- **Cursor** (`cursor`): Cursor IDE
- **Codex** (`codex`): OpenAI Codex CLI
- **Factory** (`factory`): Factory AI
- **OpenCode** (`opencode`): OpenCode CLI

## Key Behaviors

1. **Safe re-runs**: Running agentlinker multiple times is safe - it repairs/updates links
2. **Automatic backups**: Creates `.agents/backup/<timestamp>` before overwrites
3. **Undo support**: Can restore from backup via interactive menu
4. **Dry-run mode**: Preview all changes before applying
5. **CLAUDE.md precedence**: If `.agents/CLAUDE.md` exists, uses it for Claude instead of AGENTS.md

## Troubleshooting

### Common Issues

1. **Links not updating**: Run `agentlinker` again to repair
2. **Conflicts**: Use "Force overwrite" option or `--yes` flag
3. **Monorepo not detected**: Ensure parent `.agents/` folder exists
4. **Merged content stale**: Delete `.agents/merged/` and re-run

### Checking Status

```bash
agentlinker
# Select "Show status" to see link health
```

## Development

```bash
bun run dev           # Run CLI in dev mode
bun run build         # Build for distribution
bun run type-check    # TypeScript checks
bun run lint          # Biome linting
bun test              # Run test suite
```

## Architecture Notes

- **Entry point**: `src/cli.tsx` - main CLI with @clack/prompts
- **Core logic**: `src/core/` - detection, merging, linking, backup
- **Types**: `src/core/types.ts` - Scope, Client, Mapping, InheritanceChain
- **Mappings**: `src/core/mappings.ts` - defines source→target symlink rules
- **Merge**: `src/core/merge.ts` - handles extend/compose behaviors
- **Discover**: `src/core/discover.ts` - finds commands/skills/hooks in chain
