#!/usr/bin/env node
import { cancel, confirm, intro, isCancel, multiselect, note, outro, select, spinner } from '@clack/prompts';
import chalk from 'chalk';
import path from 'path';
import { createBackupSession, finalizeBackup } from './core/backup.js';
import {
  configExists,
  createComposeConfig,
  createDefaultConfig,
  createDetailedConfig,
  getExtendBehavior,
  loadMonorepoConfig,
  type ResourceName,
  saveMonorepoConfig,
} from './core/config.js';
import { detectAllClients } from './core/detect.js';
import { discoverParentResources } from './core/discover.js';
import { detectMonorepoContext, type InitScope, initAgentsFolder } from './core/init.js';
import type { MigrationCandidate } from './core/migrate.js';
import { applyMigration, scanMigration } from './core/migrate.js';
import { detectMonorepoChain, formatInheritanceDisplay, hasMonorepoParent } from './core/monorepo.js';
import { resolveMonorepoRoots, resolveRoots } from './core/paths.js';
import { buildLinkPlan, buildMonorepoLinkPlan } from './core/plan.js';
import { preflightBackup } from './core/preflight.js';
import { getLinkStatus, getMonorepoLinkStatus } from './core/status.js';
import type { Client, ExtendBehavior, IncludeConfig, InheritanceChain, LinkStatus, Scope } from './core/types.js';
import { undoLastChange } from './core/undo.js';
import { setupGracefulShutdown, startWatch } from './core/watch.js';

const appTitle = 'agentlinker';

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');
const watchMode = args.includes('--watch') || args.includes('-w');
const subcommand = args.find((arg) => !arg.startsWith('-'));

// Helper to get flag value: --flag=value or --flag value
function getFlagValue(flag: string): string | null {
  const prefix = `--${flag}=`;
  const prefixArg = args.find((a) => a.startsWith(prefix));
  if (prefixArg) return prefixArg.slice(prefix.length);

  const flagIndex = args.indexOf(`--${flag}`);
  if (flagIndex !== -1 && args[flagIndex + 1] && !args[flagIndex + 1]?.startsWith('-')) {
    return args[flagIndex + 1]!;
  }
  return null;
}

// Helper to get list flag value: --flag=a,b,c
function getListFlagValue(flag: string): string[] | null {
  const value = getFlagValue(flag);
  if (!value) return null;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Non-interactive mode flags
const scopeFlag = getFlagValue('scope') as 'global' | 'project' | null;
const includeCommandsFlag = getListFlagValue('include-commands');
const includeSkillsFlag = getListFlagValue('include-skills');
const includeHooksFlag = getListFlagValue('include-hooks');
const agentsMdFlag = getFlagValue('agents-md') as ExtendBehavior | null;
const yesFlag = args.includes('--yes') || args.includes('-y');

type StatusSummary = { name: string; linked: number; missing: number; conflict: number };

type ExtendedScope = Scope | 'monorepo';

type Action = 'change' | 'status' | 'undo' | 'clients' | 'inheritance' | 'exit';

type ScopeChoice = 'global' | 'project' | 'monorepo' | 'exit';

function exitCancelled() {
  cancel('Cancelled');
  process.exit(0);
}

function mergeAgentStatus(items: LinkStatus[]): LinkStatus[] {
  const claudeEntry = items.find((s) => s.name === 'claude-md') || null;
  const agentsEntry = items.find((s) => s.name === 'agents-md') || null;
  if (!claudeEntry && !agentsEntry) return items;

  const merged: LinkStatus = {
    name: 'agents-md',
    source: claudeEntry?.source || agentsEntry?.source || '',
    targets: [...(claudeEntry?.targets || []), ...(agentsEntry?.targets || [])],
  };

  const withoutAgents = items.filter((s) => s.name !== 'claude-md' && s.name !== 'agents-md');
  return [merged, ...withoutAgents];
}

function displayName(entry: LinkStatus): string {
  if (entry.name === 'agents-md') {
    const sourceFile = path.basename(entry.source);
    if (sourceFile === 'CLAUDE.md') return 'AGENTS.md (Claude override)';
    return 'AGENTS.md';
  }
  return entry.name;
}

function buildStatusSummary(status: LinkStatus[]): StatusSummary[] {
  return status.map((s) => {
    const linked = s.targets.filter((t) => t.status === 'linked').length;
    const missing = s.targets.filter((t) => t.status === 'missing').length;
    const conflict = s.targets.filter((t) => t.status === 'conflict').length;
    return { name: displayName(s), linked, missing, conflict };
  });
}

function formatSummaryTable(rows: StatusSummary[]): string[] {
  const header = { name: 'Section', conflict: 'Conflicts', missing: 'Need link', linked: 'Linked' };
  const width = {
    name: Math.max(header.name.length, ...rows.map((r) => r.name.length)),
    conflict: Math.max(header.conflict.length, ...rows.map((r) => String(r.conflict).length)),
    missing: Math.max(header.missing.length, ...rows.map((r) => String(r.missing).length)),
    linked: Math.max(header.linked.length, ...rows.map((r) => String(r.linked).length)),
  };
  const pad = (value: string, len: number) => value.padEnd(len, ' ');
  const lines = [
    `${pad(header.name, width.name)}  ${pad(header.conflict, width.conflict)}  ${pad(header.missing, width.missing)}  ${pad(header.linked, width.linked)}`,
    ...rows.map(
      (r) =>
        `${pad(r.name, width.name)}  ${pad(String(r.conflict), width.conflict)}  ${pad(String(r.missing), width.missing)}  ${pad(String(r.linked), width.linked)}`
    ),
  ];
  return lines;
}

function renderStatusLines(status: LinkStatus[], conflictReasons: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const entry of status) {
    lines.push(chalk.cyan(displayName(entry)));
    for (const target of entry.targets) {
      const icon =
        target.status === 'linked'
          ? chalk.green('✓')
          : target.status === 'missing'
            ? chalk.yellow('•')
            : chalk.red('⚠');
      const reason = target.status === 'conflict' ? conflictReasons.get(target.path) : undefined;
      lines.push(`  ${icon} ${target.path}${reason ? chalk.dim(` — ${reason}`) : ''}`);
    }
  }
  return lines;
}

type ScopeResult = {
  scope: ExtendedScope;
  chain: InheritanceChain | null;
};

async function selectScope(): Promise<ScopeResult> {
  const chain = await detectMonorepoChain();
  const hasParent = hasMonorepoParent(chain);

  const options: { label: string; value: ScopeChoice; hint?: string }[] = [
    { label: 'Global (~/.agents)', value: 'global' },
  ];

  if (hasParent && chain.current) {
    const parentPath = chain.ancestors[0] || chain.global;
    options.push({
      label: 'Monorepo (.agents)',
      value: 'monorepo',
      hint: `inherits from ${parentPath}`,
    });
  }

  options.push({ label: 'Project (.agents)', value: 'project', hint: 'standalone' }, { label: 'Exit', value: 'exit' });

  const scope = await select({
    message: 'Choose a workspace',
    options,
  });
  if (isCancel(scope)) exitCancelled();
  if (scope === 'exit') {
    outro('Bye');
    process.exit(0);
  }

  if (scope === 'monorepo') {
    return { scope: 'monorepo', chain };
  }

  return { scope: scope as Scope, chain: null };
}

function scopeLabel(scope: ExtendedScope): string {
  if (scope === 'global') return 'Global (~/.agents)';
  if (scope === 'monorepo') return 'Monorepo (.agents)';
  return 'Project (.agents)';
}

async function promptInheritanceConfig(chain: InheritanceChain): Promise<void> {
  if (!chain.current) return;

  const hasConfig = await configExists(chain.current);
  if (hasConfig) return;

  const parentPath = chain.ancestors[0] || chain.global;
  note(`Parent .agents detected at ${parentPath}`, 'Monorepo detected');

  const choice = await select({
    message: 'How should this package inherit from parent?',
    options: [
      { label: 'Inherit all (extend parent config)', value: 'inherit' },
      { label: 'Standalone (independent config)', value: 'standalone' },
      { label: 'Configure per-resource', value: 'configure' },
    ],
  });

  if (isCancel(choice)) exitCancelled();

  if (choice === 'inherit') {
    await saveMonorepoConfig(chain.current, createDefaultConfig(true));
    note('Created config.yaml with extends: true', 'Config saved');
  } else if (choice === 'standalone') {
    await saveMonorepoConfig(chain.current, createDefaultConfig(false));
    note('Created config.yaml with extends: false', 'Config saved');
  } else {
    await configureInheritancePerResource(chain.current);
  }
}

async function configureInheritancePerResource(agentsRoot: string): Promise<void> {
  const resources: ResourceName[] = ['AGENTS.md', 'commands', 'skills', 'hooks'];
  const behaviors: Record<ResourceName, ExtendBehavior> = {
    'AGENTS.md': 'inherit',
    commands: 'inherit',
    skills: 'inherit',
    hooks: 'inherit',
  };

  for (const resource of resources) {
    const choice = await select({
      message: `Inheritance for ${resource}:`,
      options: [
        { label: 'Inherit (use parent)', value: 'inherit' },
        { label: 'Extend (merge parent + child)', value: 'extend' },
        { label: 'Override (ignore parent)', value: 'override' },
      ],
    });

    if (isCancel(choice)) exitCancelled();
    behaviors[resource] = choice as ExtendBehavior;
  }

  await saveMonorepoConfig(agentsRoot, createDetailedConfig(behaviors));
  note('Created config.yaml with per-resource settings', 'Config saved');
}

async function showInheritanceStatus(chain: InheritanceChain): Promise<void> {
  const lines = formatInheritanceDisplay(chain);
  note(lines.join('\n'), 'Inheritance chain');
}

function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural || `${singular}s`;
}

function formatCount(count: number, singular: string, plural?: string): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

async function selectClients(): Promise<Client[]> {
  const clientNames: Record<Client, string> = {
    claude: 'Claude',
    factory: 'Factory',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
  };

  const detectionResults = await detectAllClients();
  const clients: Client[] = ['claude', 'factory', 'codex', 'cursor', 'opencode'];

  const options = clients.map((client) => {
    const result = detectionResults.get(client)!;
    const label = result.detected ? clientNames[client] : `${clientNames[client]} ${chalk.dim('(not detected)')}`;
    return { label, value: client };
  });

  const detectedClients = clients.filter((client) => detectionResults.get(client)?.detected);
  const initialValues = detectedClients.length > 0 ? detectedClients : clients;

  const selected = await multiselect({
    message: 'Select clients to manage',
    options,
    initialValues,
    required: true,
  });
  if (isCancel(selected)) exitCancelled();
  return selected as Client[];
}

function formatClients(clients: Client[]): string {
  const names: Record<Client, string> = {
    claude: 'Claude',
    factory: 'Factory',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
  };
  return clients.map((c) => names[c]).join(', ');
}

async function showStatus(
  scope: Scope,
  clients: Client[],
  status: LinkStatus[],
  planConflicts: { target: string; reason: string }[]
): Promise<void> {
  const conflicts = new Map(planConflicts.map((c) => [c.target, c.reason]));
  const lines = renderStatusLines(mergeAgentStatus(status), conflicts);
  note(lines.join('\n'), `Status · ${scopeLabel(scope)} · ${formatClients(clients)}`);
}

async function resolveMigrationConflicts(
  plan: Awaited<ReturnType<typeof scanMigration>>
): Promise<Map<string, MigrationCandidate | null> | null> {
  const selections = new Map<string, MigrationCandidate | null>();
  for (let i = 0; i < plan.conflicts.length; i += 1) {
    const conflict = plan.conflicts[i]!;
    const choice = await select({
      message: `Resolve migration conflict ${i + 1} of ${plan.conflicts.length}: ${conflict.label}`,
      options: conflict.candidates.map((c) => ({ label: c.label, value: c })),
    });
    if (isCancel(choice)) return null;
    selections.set(conflict.targetPath, choice as MigrationCandidate);
  }
  return selections;
}

async function runChange(scope: Scope, clients: Client[], isDryRun: boolean = false): Promise<void> {
  const spin = spinner();
  spin.start('Scanning current setup...');
  const roots = resolveRoots({ scope });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const migrate = await scanMigration({ scope, clients });
  const link = await buildLinkPlan({ scope, clients });
  const backupDir = path.join(roots.canonicalRoot, 'backup', timestamp);
  spin.stop('Scan complete');

  const planSummaryLines = [
    `Migration: ${migrate.auto.length} auto · ${migrate.conflicts.length} conflicts (choose sources)`,
    `Links: ${link.changes.length} changes · ${link.conflicts.length} conflicts (existing files/dirs)`,
  ];

  if (isDryRun) {
    planSummaryLines.push(chalk.yellow('Backup: (skipped in dry-run mode)'));
  } else {
    planSummaryLines.push(`Backup: ${backupDir}`);
    planSummaryLines.push('Undo: Use "Undo last change" after this completes.');
  }

  const planSummary = planSummaryLines.join('\n');
  note(planSummary, isDryRun ? chalk.yellow('DRY RUN - Plan summary') : 'Plan summary');

  // Show detailed changes in dry-run mode
  if (isDryRun) {
    const changeLines: string[] = [];

    if (migrate.auto.length > 0) {
      changeLines.push(chalk.cyan('Migrations (auto):'));
      for (const item of migrate.auto) {
        changeLines.push(`  ${chalk.green('+')} ${item.sourcePath} -> ${item.targetPath}`);
      }
    }

    if (migrate.conflicts.length > 0) {
      changeLines.push(chalk.cyan('Migrations (require choice):'));
      for (const conflict of migrate.conflicts) {
        changeLines.push(`  ${chalk.yellow('?')} ${conflict.label}`);
        for (const candidate of conflict.candidates) {
          changeLines.push(`    - ${candidate.label}`);
        }
      }
    }

    const linkTasks = link.changes.filter((t): t is Extract<typeof t, { type: 'link' }> => t.type === 'link');
    if (linkTasks.length > 0) {
      changeLines.push(chalk.cyan('Symlinks to create:'));
      for (const task of linkTasks) {
        changeLines.push(`  ${chalk.green('+')} ${task.target} -> ${task.source}`);
      }
    }

    if (link.conflicts.length > 0) {
      changeLines.push(chalk.cyan('Conflicts (existing files/dirs):'));
      for (const conflict of link.conflicts) {
        changeLines.push(`  ${chalk.red('!')} ${conflict.target} (${conflict.reason})`);
      }
    }

    if (changeLines.length > 0) {
      note(changeLines.join('\n'), chalk.yellow('DRY RUN - Pending changes'));
    }

    note(chalk.yellow('No changes were made (dry-run mode)'), 'Complete');
    return;
  }

  let overwriteConflicts = true;
  if (link.conflicts.length > 0) {
    const choice = await select({
      message: 'Apply changes',
      options: [
        { label: 'Apply changes + overwrite conflicts', value: 'force' },
        { label: 'Apply changes (leave conflicts)', value: 'skip' },
        { label: 'Back', value: 'back' },
      ],
    });
    if (isCancel(choice)) return;
    if (choice === 'back') return;
    overwriteConflicts = choice === 'force';
  } else {
    const ok = await confirm({ message: 'Apply changes now?' });
    if (isCancel(ok) || !ok) return;
  }

  let selections = new Map<string, MigrationCandidate | null>();
  if (migrate.conflicts.length > 0) {
    const resolved = await resolveMigrationConflicts(migrate);
    if (!resolved) return;
    selections = resolved;
  }

  const applySpinner = spinner();
  applySpinner.start('Applying changes...');
  try {
    const backup = await createBackupSession({
      canonicalRoot: roots.canonicalRoot,
      scope,
      operation: 'change-to-agents',
      timestamp,
    });
    await preflightBackup({
      backup,
      linkPlan: link,
      migratePlan: migrate,
      selections,
      forceLinks: overwriteConflicts,
    });
    const result = await applyMigration(migrate, selections, {
      scope,
      clients,
      backup,
      forceLinks: overwriteConflicts,
    });
    await finalizeBackup(backup);
    const migrationSummary = `Migrated ${formatCount(result.copied, 'item')}`;
    const linkSummary = `Linked ${formatCount(result.links.applied, 'path')}`;
    const conflictSummary =
      result.links.conflicts > 0
        ? overwriteConflicts
          ? `overwrote ${formatCount(result.links.conflicts, 'conflict')}`
          : `left ${formatCount(result.links.conflicts, 'conflict')} untouched`
        : '';
    const pieces = [migrationSummary, linkSummary];
    if (conflictSummary) pieces.push(conflictSummary);
    applySpinner.stop(`${pieces.join(' · ')}. Backup: ${result.backupDir}`);
  } catch (err: any) {
    applySpinner.stop('Change failed');
    note(String(err?.message || err), 'Error');
  }
}

async function runMonorepoChange(chain: InheritanceChain, clients: Client[], isDryRun: boolean = false): Promise<void> {
  const spin = spinner();
  spin.start('Scanning current setup...');
  const roots = resolveMonorepoRoots({ scope: 'monorepo', chain });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const link = await buildMonorepoLinkPlan({ chain, clients });
  const backupDir = path.join(roots.canonicalRoot, 'backup', timestamp);
  spin.stop('Scan complete');

  const planSummaryLines = [
    `Links: ${link.changes.length} changes · ${link.conflicts.length} conflicts (existing files/dirs)`,
  ];

  if (isDryRun) {
    planSummaryLines.push(chalk.yellow('Backup: (skipped in dry-run mode)'));
  } else {
    planSummaryLines.push(`Backup: ${backupDir}`);
    planSummaryLines.push('Undo: Use "Undo last change" after this completes.');
  }

  const planSummary = planSummaryLines.join('\n');
  note(planSummary, isDryRun ? chalk.yellow('DRY RUN - Plan summary') : 'Plan summary');

  if (link.changes.length === 0) {
    note('No changes to apply', 'Info');
    return;
  }

  // Show detailed changes in dry-run mode
  if (isDryRun) {
    const changeLines: string[] = [];

    const linkTasks = link.changes.filter((t): t is Extract<typeof t, { type: 'link' }> => t.type === 'link');
    if (linkTasks.length > 0) {
      changeLines.push(chalk.cyan('Symlinks to create:'));
      for (const task of linkTasks) {
        changeLines.push(`  ${chalk.green('+')} ${task.target} -> ${task.source}`);
      }
    }

    if (link.conflicts.length > 0) {
      changeLines.push(chalk.cyan('Conflicts (existing files/dirs):'));
      for (const conflict of link.conflicts) {
        changeLines.push(`  ${chalk.red('!')} ${conflict.target} (${conflict.reason})`);
      }
    }

    if (changeLines.length > 0) {
      note(changeLines.join('\n'), chalk.yellow('DRY RUN - Pending changes'));
    }

    note(chalk.yellow('No changes were made (dry-run mode)'), 'Complete');
    return;
  }

  let overwriteConflicts = true;
  if (link.conflicts.length > 0) {
    const choice = await select({
      message: 'Apply changes',
      options: [
        { label: 'Apply changes + overwrite conflicts', value: 'force' },
        { label: 'Apply changes (leave conflicts)', value: 'skip' },
        { label: 'Back', value: 'back' },
      ],
    });
    if (isCancel(choice)) return;
    if (choice === 'back') return;
    overwriteConflicts = choice === 'force';
  } else {
    const ok = await confirm({ message: 'Apply changes now?' });
    if (isCancel(ok) || !ok) return;
  }

  const applySpinner = spinner();
  applySpinner.start('Applying changes...');
  try {
    const backup = await createBackupSession({
      canonicalRoot: roots.canonicalRoot,
      scope: 'project',
      operation: 'change-to-agents',
      timestamp,
    });
    await preflightBackup({
      backup,
      linkPlan: link,
      migratePlan: { auto: [], conflicts: [], canonicalRoot: roots.canonicalRoot },
      selections: new Map(),
      forceLinks: overwriteConflicts,
    });
    const { applyLinkPlan } = await import('./core/apply.js');
    const linkResult = await applyLinkPlan(link, { backup, force: overwriteConflicts });
    await finalizeBackup(backup);
    const linkSummary = `Linked ${formatCount(linkResult.applied, 'path')}`;
    const conflictSummary =
      linkResult.conflicts > 0
        ? overwriteConflicts
          ? `overwrote ${formatCount(linkResult.conflicts, 'conflict')}`
          : `left ${formatCount(linkResult.conflicts, 'conflict')} untouched`
        : '';
    const pieces = [linkSummary];
    if (conflictSummary) pieces.push(conflictSummary);
    applySpinner.stop(`${pieces.join(' · ')}. Backup: ${backupDir}`);
  } catch (err: any) {
    applySpinner.stop('Change failed');
    note(String(err?.message || err), 'Error');
  }
}

type InitScopeChoice = 'global' | 'project' | 'exit';

async function runInit(): Promise<void> {
  const nonInteractive = scopeFlag !== null;

  if (!nonInteractive) {
    intro(chalk.cyan(`${appTitle} init`));
  }

  // Check for monorepo context
  const isMonorepo = await detectMonorepoContext();

  let initScope: InitScope;
  let createConfig = false;

  if (nonInteractive) {
    // Non-interactive mode
    initScope = scopeFlag as InitScope;
    createConfig = yesFlag && isMonorepo && initScope === 'project';
    console.log(`Initializing .agents (${initScope} scope)...`);
  } else {
    // Interactive mode
    const scopeOptions: { label: string; value: InitScopeChoice; hint?: string }[] = [
      { label: 'Global (~/.agents)', value: 'global', hint: 'shared across all projects' },
      { label: 'Project (./.agents)', value: 'project', hint: 'local to this project' },
      { label: 'Exit', value: 'exit' },
    ];

    const scopeChoice = await select({
      message: 'Where would you like to initialize .agents?',
      options: scopeOptions,
    });

    if (isCancel(scopeChoice)) exitCancelled();
    if (scopeChoice === 'exit') {
      outro('Bye');
      process.exit(0);
    }

    initScope = scopeChoice as InitScope;

    // Ask about config.yaml for project scope in monorepo context
    if (initScope === 'project' && isMonorepo) {
      note(
        'A parent .agents folder was detected. You may want to create a config.yaml to configure inheritance.',
        'Monorepo detected'
      );
      const configChoice = await confirm({
        message: 'Create config.yaml for monorepo inheritance settings?',
      });
      if (isCancel(configChoice)) exitCancelled();
      createConfig = configChoice as boolean;
    }
  }

  try {
    const result = await initAgentsFolder({
      scope: initScope,
      createConfig,
    });

    if (nonInteractive) {
      // Non-interactive output
      console.log(`Created: ${result.agentsRoot}`);
      if (result.created.length > 0) {
        for (const item of result.created) {
          console.log(`  + ${item}`);
        }
      }
      if (result.skipped.length > 0) {
        for (const item of result.skipped) {
          console.log(`  - ${item} (already exists)`);
        }
      }
    } else {
      // Interactive output
      // Show results
      const resultLines: string[] = [`Location: ${result.agentsRoot}`, ''];

      if (result.created.length > 0) {
        resultLines.push(chalk.green('Created:'));
        for (const item of result.created) {
          resultLines.push(`  ${chalk.green('+')} ${item}`);
        }
      }

      if (result.skipped.length > 0) {
        if (result.created.length > 0) resultLines.push('');
        resultLines.push(chalk.yellow('Skipped (already exists):'));
        for (const item of result.skipped) {
          resultLines.push(`  ${chalk.yellow('-')} ${item}`);
        }
      }

      note(resultLines.join('\n'), 'Result');

      // Show next steps
      const nextStepsLines = [
        '1. Edit AGENTS.md to describe your project and coding conventions',
        '2. Add custom commands to the commands/ directory',
        '3. Add skills to the skills/ directory',
        '4. Run `agentlinker` to sync with AI coding clients',
      ];

      if (result.isMonorepo && !createConfig) {
        nextStepsLines.push('');
        nextStepsLines.push(chalk.dim('Tip: Run `agentlinker init` again to add config.yaml for monorepo settings'));
      }

      note(nextStepsLines.join('\n'), 'Next steps');
      outro('Done!');
    }
  } catch (err: any) {
    if (nonInteractive) {
      console.error(`Error: ${err?.message || err}`);
    } else {
      note(String(err?.message || err), 'Error');
    }
    process.exit(1);
  }
}

async function runWatch(): Promise<void> {
  console.log(chalk.cyan(appTitle));
  console.log('');

  // Detect monorepo chain
  const chain = await detectMonorepoChain();
  const hasParent = hasMonorepoParent(chain);

  if (!hasParent || !chain.current) {
    console.log(chalk.yellow('Watch mode is only available in monorepo setups where merging is relevant.'));
    console.log(chalk.dim('Run without --watch for global or standalone project modes.'));
    process.exit(1);
  }

  // Detect clients
  const detectionResults = await detectAllClients();
  const clients: Client[] = ['claude', 'factory', 'codex', 'cursor', 'opencode'];
  const detectedClients = clients.filter((client) => detectionResults.get(client)?.detected);
  const selectedClients = detectedClients.length > 0 ? detectedClients : clients;

  console.log(chalk.dim(`Clients: ${formatClients(selectedClients)}`));
  console.log('');

  // Do initial build
  console.log('Performing initial setup...');
  try {
    const roots = resolveMonorepoRoots({ scope: 'monorepo', chain });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const plan = await buildMonorepoLinkPlan({ chain, clients: selectedClients });

    if (plan.changes.length > 0) {
      const backup = await createBackupSession({
        canonicalRoot: roots.canonicalRoot,
        scope: 'project',
        operation: 'watch-initial',
        timestamp,
      });
      const { applyLinkPlan } = await import('./core/apply.js');
      const result = await applyLinkPlan(plan, { backup, force: true });
      await finalizeBackup(backup);
      console.log(`Initial setup complete. Applied ${result.applied} link(s).`);
    } else {
      console.log('Initial setup complete. No changes needed.');
    }
  } catch (err) {
    console.error(chalk.red(`Initial setup failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  console.log('');

  // Start watching
  const cleanup = await startWatch({
    chain,
    clients: selectedClients,
    onLog: (msg) => console.log(msg),
    onError: (err) => console.error(chalk.red(err.message)),
  });

  setupGracefulShutdown(cleanup, () => {
    console.log('');
    console.log(chalk.dim('Watch stopped.'));
  });
}

async function runCompose(): Promise<void> {
  // Check if we're in non-interactive mode (any --include-* flag or --agents-md flag provided)
  const nonInteractive =
    includeCommandsFlag !== null ||
    includeSkillsFlag !== null ||
    includeHooksFlag !== null ||
    agentsMdFlag !== null ||
    yesFlag;

  if (!nonInteractive) {
    intro(chalk.cyan(`${appTitle} compose`));
  }

  // Detect monorepo chain
  const chain = await detectMonorepoChain();
  const hasParent = hasMonorepoParent(chain);

  if (!hasParent) {
    if (nonInteractive) {
      console.error('Error: No parent .agents folder detected. The compose command requires a monorepo setup.');
    } else {
      note('No parent .agents folder detected. The compose command requires a monorepo setup.', 'Not a monorepo');
      outro('Bye');
    }
    process.exit(1);
  }

  if (!chain.current) {
    if (nonInteractive) {
      console.error('Error: No .agents folder in current directory. Run `agentlinker init --scope=project` first.');
    } else {
      note('No .agents folder in current directory. Run `agentlinker init` first.', 'Missing .agents');
      outro('Bye');
    }
    process.exit(1);
  }

  const parentPath = chain.ancestors[0] || chain.global;

  // Discover available resources from parents
  const discovered = await discoverParentResources(chain);

  // Load existing config
  const existingConfig = await loadMonorepoConfig(chain.current);
  const existingInclude = existingConfig.include || {};

  let selectedCommands: string[];
  let selectedSkills: string[];
  let selectedHooks: string[];
  let agentsMdBehavior: ExtendBehavior;

  if (nonInteractive) {
    // Non-interactive mode: use flags or existing config
    console.log(`Composing .agents from parent: ${parentPath}`);

    selectedCommands = includeCommandsFlag || existingInclude.commands || [];
    selectedSkills = includeSkillsFlag || existingInclude.skills || [];
    selectedHooks = includeHooksFlag || existingInclude.hooks || [];
    agentsMdBehavior = agentsMdFlag || getExtendBehavior(existingConfig, 'AGENTS.md');

    // Validate that specified items exist
    const availableCommands = new Set(discovered.commands.map((c) => c.name));
    const availableSkills = new Set(discovered.skills.map((s) => s.name));
    const availableHooks = new Set(discovered.hooks.map((h) => h.name));

    selectedCommands = selectedCommands.filter((c) => {
      if (!availableCommands.has(c)) {
        console.warn(`Warning: command '${c}' not found in parent, skipping`);
        return false;
      }
      return true;
    });
    selectedSkills = selectedSkills.filter((s) => {
      if (!availableSkills.has(s)) {
        console.warn(`Warning: skill '${s}' not found in parent, skipping`);
        return false;
      }
      return true;
    });
    selectedHooks = selectedHooks.filter((h) => {
      if (!availableHooks.has(h)) {
        console.warn(`Warning: hook '${h}' not found in parent, skipping`);
        return false;
      }
      return true;
    });
  } else {
    // Interactive mode
    note(`Parent .agents detected at ${parentPath}`, 'Monorepo detected');

    const spin = spinner();
    spin.start('Discovering resources from parent...');
    spin.stop('Discovery complete');

    // Select commands
    selectedCommands = [];
    if (discovered.commands.length > 0) {
      const commandOptions = discovered.commands.map((item) => ({
        label: `${item.name} ${chalk.dim(`(from ${item.source})`)}`,
        value: item.name,
      }));

      const initialCommands = existingInclude.commands || [];
      const commandChoice = await multiselect({
        message: 'Select commands to include from parent:',
        options: commandOptions,
        initialValues: initialCommands.filter((c) => commandOptions.some((o) => o.value === c)),
        required: false,
      });

      if (isCancel(commandChoice)) exitCancelled();
      selectedCommands = commandChoice as string[];
    } else {
      note('No commands found in parent .agents folders', 'Commands');
    }

    // Select skills
    selectedSkills = [];
    if (discovered.skills.length > 0) {
      const skillOptions = discovered.skills.map((item) => ({
        label: `${item.name} ${chalk.dim(`(from ${item.source})`)}`,
        value: item.name,
      }));

      const initialSkills = existingInclude.skills || [];
      const skillChoice = await multiselect({
        message: 'Select skills to include from parent:',
        options: skillOptions,
        initialValues: initialSkills.filter((s) => skillOptions.some((o) => o.value === s)),
        required: false,
      });

      if (isCancel(skillChoice)) exitCancelled();
      selectedSkills = skillChoice as string[];
    } else {
      note('No skills found in parent .agents folders', 'Skills');
    }

    // Select hooks
    selectedHooks = [];
    if (discovered.hooks.length > 0) {
      const hookOptions = discovered.hooks.map((item) => ({
        label: `${item.name} ${chalk.dim(`(from ${item.source})`)}`,
        value: item.name,
      }));

      const initialHooks = existingInclude.hooks || [];
      const hookChoice = await multiselect({
        message: 'Select hooks to include from parent:',
        options: hookOptions,
        initialValues: initialHooks.filter((h) => hookOptions.some((o) => o.value === h)),
        required: false,
      });

      if (isCancel(hookChoice)) exitCancelled();
      selectedHooks = hookChoice as string[];
    } else {
      note('No hooks found in parent .agents folders', 'Hooks');
    }

    // Ask about AGENTS.md merge preference
    const existingAgentsBehavior = getExtendBehavior(existingConfig, 'AGENTS.md');
    const agentsMdChoice = await select({
      message: 'Include parent AGENTS.md content?',
      options: [
        { label: 'Yes, merge with local (Recommended)', value: 'extend' },
        { label: 'No, use only local', value: 'override' },
        { label: 'Yes, use parent only', value: 'inherit' },
      ],
      initialValue: existingAgentsBehavior,
    });

    if (isCancel(agentsMdChoice)) exitCancelled();
    agentsMdBehavior = agentsMdChoice as ExtendBehavior;
  }

  // Build behaviors
  const behaviors: Record<ResourceName, ExtendBehavior> = {
    'AGENTS.md': agentsMdBehavior,
    commands: selectedCommands.length > 0 ? 'compose' : 'override',
    skills: selectedSkills.length > 0 ? 'compose' : 'override',
    hooks: selectedHooks.length > 0 ? 'compose' : 'inherit',
  };

  // Build include config
  const include: IncludeConfig = {};
  if (selectedCommands.length > 0) {
    include.commands = selectedCommands;
  }
  if (selectedSkills.length > 0) {
    include.skills = selectedSkills;
  }
  if (selectedHooks.length > 0) {
    include.hooks = selectedHooks;
  }

  // Save config
  const config = createComposeConfig({ behaviors, include });
  await saveMonorepoConfig(chain.current, config);

  // Show summary
  if (nonInteractive) {
    console.log('Saved to .agents/config.yaml');
    console.log(
      `  commands: ${selectedCommands.length} selected${selectedCommands.length > 0 ? ` (${selectedCommands.join(', ')})` : ''}`
    );
    console.log(
      `  skills: ${selectedSkills.length} selected${selectedSkills.length > 0 ? ` (${selectedSkills.join(', ')})` : ''}`
    );
    console.log(
      `  hooks: ${selectedHooks.length} selected${selectedHooks.length > 0 ? ` (${selectedHooks.join(', ')})` : ''}`
    );
    console.log(`  AGENTS.md: ${agentsMdBehavior}`);
  } else {
    const summaryLines = [
      `${chalk.green('✓')} Saved to .agents/config.yaml`,
      `  - ${selectedCommands.length} command${selectedCommands.length === 1 ? '' : 's'} selected`,
      `  - ${selectedSkills.length} skill${selectedSkills.length === 1 ? '' : 's'} selected`,
      `  - ${selectedHooks.length} hook${selectedHooks.length === 1 ? '' : 's'} selected`,
      `  - AGENTS.md: ${agentsMdBehavior}`,
    ];
    note(summaryLines.join('\n'), 'Configuration saved');
    note('Run `agentlinker` to apply the changes and create symlinks.', 'Next step');
    outro('Done!');
  }
}

async function run(): Promise<void> {
  const titleParts = [chalk.cyan(appTitle)];
  if (dryRun) {
    titleParts.push(chalk.yellow(' (dry-run mode)'));
  }
  intro(titleParts.join(''));
  const { scope, chain } = await selectScope();
  let clients = await selectClients();

  if (scope === 'monorepo' && chain) {
    await promptInheritanceConfig(chain);
  }

  while (true) {
    let status: LinkStatus[];
    let plan: Awaited<ReturnType<typeof buildLinkPlan>>;

    if (scope === 'monorepo' && chain) {
      status = mergeAgentStatus(await getMonorepoLinkStatus({ chain, clients }));
      plan = await buildMonorepoLinkPlan({ chain, clients });
    } else {
      status = mergeAgentStatus(await getLinkStatus({ scope: scope as Scope, clients }));
      plan = await buildLinkPlan({ scope: scope as Scope, clients });
    }

    const conflicts = plan.conflicts.length || 0;
    const changes = plan.changes.length || 0;
    const summary = buildStatusSummary(status);
    const summaryLines = formatSummaryTable(summary);

    const overviewLines = [
      `Scope: ${scopeLabel(scope)}`,
      `Clients: ${formatClients(clients)}`,
      `Pending changes: ${changes} · Conflicts: ${conflicts}`,
    ];

    if (scope === 'monorepo' && chain) {
      const inheritanceLines = formatInheritanceDisplay(chain);
      overviewLines.push(...inheritanceLines);
    }

    overviewLines.push(...summaryLines);
    note(overviewLines.join('\n'), 'Overview');

    const options: { label: string; value: Action }[] = [];
    if (changes > 0) options.push({ label: `Apply ${changes} changes to .agents`, value: 'change' });
    options.push({ label: 'View status', value: 'status' });
    options.push({ label: 'Change clients', value: 'clients' });
    if (scope === 'monorepo' && chain) {
      options.push({ label: 'Configure inheritance', value: 'inheritance' });
    }
    options.push({ label: 'Undo last change', value: 'undo' });
    options.push({ label: 'Exit', value: 'exit' });

    const action = await select({ message: 'Choose an action', options });
    if (isCancel(action)) exitCancelled();
    if (action === 'exit') break;

    if (action === 'status') {
      await showStatus(scope as Scope, clients, status, plan.conflicts);
      if (scope === 'monorepo' && chain) {
        await showInheritanceStatus(chain);
      }
      continue;
    }

    if (action === 'clients') {
      clients = await selectClients();
      continue;
    }

    if (action === 'inheritance' && chain?.current) {
      await configureInheritancePerResource(chain.current);
      continue;
    }

    if (action === 'undo') {
      const spin = spinner();
      spin.start('Undoing last change...');
      try {
        const result = await undoLastChange({ scope: scope === 'monorepo' ? 'project' : (scope as Scope) });
        const restoredSummary = `Restored ${formatCount(result.restoredBackups, 'backup')}`;
        const removedSummary = `Removed ${formatCount(result.removedCreated, 'created path')}`;
        const symlinkSummary =
          result.removedSymlinks > 0 ? `${formatCount(result.removedSymlinks, 'symlink')} removed` : '';
        let totalSummary = '';
        if (result.restoredBackups === 0 && result.removedCreated === 0) {
          totalSummary = 'Nothing to undo.';
        } else if (result.restoredBackups === 0) {
          totalSummary = [removedSummary, symlinkSummary, 'No backups to restore.'].filter(Boolean).join(' · ');
        } else {
          totalSummary = [restoredSummary, removedSummary, symlinkSummary].filter(Boolean).join(' · ');
        }
        spin.stop(`${totalSummary} Reverted: ${result.undoneDir}`);
        note(`Undo backup: ${result.backupDir}`, 'Undo log');
      } catch (err: any) {
        spin.stop('Undo failed');
        note(String(err?.message || err), 'Error');
      }
      continue;
    }

    if (action === 'change') {
      if (scope === 'monorepo' && chain) {
        await runMonorepoChange(chain, clients, dryRun);
      } else {
        await runChange(scope as Scope, clients, dryRun);
      }
    }
  }

  outro('Bye');
}

// Entry point: dispatch based on subcommand and flags
if (subcommand === 'init') {
  runInit().catch((err) => {
    note(String(err?.message || err), 'Fatal error');
    process.exit(1);
  });
} else if (subcommand === 'compose') {
  runCompose().catch((err) => {
    note(String(err?.message || err), 'Fatal error');
    process.exit(1);
  });
} else if (watchMode) {
  runWatch().catch((err) => {
    console.error(chalk.red(`Fatal error: ${err?.message || err}`));
    process.exit(1);
  });
} else {
  run().catch((err) => {
    note(String(err?.message || err), 'Fatal error');
    process.exit(1);
  });
}
