import type { WorkflowGate, WorkflowPhase } from './gate.js';
import type { ProjectMode } from './ports.js';
import type { Initializer } from './init.js';
export type Command = { kind: 'help' } | { kind: 'init'; mode: ProjectMode }
  | { kind: 'spec' | 'design' | 'implement'; featureId: string };
export const help = `AI-driven development CLI (MVP skeleton)
Usage:
  dev init --mode greenfield|brownfield
  dev spec --feature <id>
  dev design --feature <id>
  dev implement --feature <id>
  dev --help

MVP: init creates local drafts; AI, PR and later workflows are not connected yet.`;
export function parseCommand(args: string[]): Command {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) return { kind: 'help' };
  const [kind, flag, value, ...extra] = args;
  if (!['init', 'spec', 'design', 'implement'].includes(kind!)) throw new Error(`Unknown command: ${kind}`);
  if (args.length === 2 && ['--help', '-h'].includes(flag!)) return { kind: 'help' };
  if (extra.length || args.length !== 3) throw new Error('Expected exactly one required option. See dev --help.');
  if (kind === 'init') {
    if (flag !== '--mode' || (value !== 'greenfield' && value !== 'brownfield')) throw new Error('Use --mode greenfield|brownfield.');
    return { kind, mode: value };
  }
  if (flag !== '--feature' || !value || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error('Use --feature with a lowercase alphanumeric/hyphen ID, e.g. 001-reservation.');
  }
  return { kind: kind as 'spec' | 'design' | 'implement', featureId: value };
}
export interface Output { out(message: string): void; error(message: string): void; }
const phases: Record<'spec' | 'design' | 'implement', WorkflowPhase> = {
  spec: 'specification', design: 'design', implement: 'implementation',
};
export async function run(args: string[], gate: WorkflowGate, output: Output, initialization?: { initializer: Initializer; root: string }): Promise<number> {
  try {
    const command = parseCommand(args);
    if (command.kind === 'help') { output.out(help); return 0; }
    if (command.kind === 'init' && initialization) {
      const result = await initialization.initializer.initialize(initialization.root, command.mode);
      output.out(`Local initialization draft created: ${result.directory}`);
      output.out('Draft only: AI/Spec Kit, worktree and PR publishing are not connected. Approval is still required.');
      return 0;
    }
    if (command.kind !== 'init') {
      const result = await gate.check(phases[command.kind], command.featureId);
      if (!result.allowed) { output.error(`BLOCKED: ${result.reason}`); return 1; }
    }
    output.out(command.kind === 'init'
      ? `Initialization planned (${command.mode}): project Constitution → review PR → merge into main.`
      : `${command.kind} gate passed for ${command.featureId}.`);
    output.error('NOT IMPLEMENTED: workflow adapters are not connected. No files, worktrees or PRs were created.');
    return 2;
  } catch (error) {
    output.error(error instanceof Error ? error.message : 'Command failed.');
    return 1;
  }
}
