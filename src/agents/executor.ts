import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
export type AgentName = 'codex' | 'claude' | 'copilot';
export interface AgentRequest { workspace: string; instruction: string; timeoutMs?: number; }
export interface AgentResult { output: string; }
export interface AgentExecutor { execute(request: AgentRequest): Promise<AgentResult>; }
export interface ProcessRequest { executable: string; args: string[]; cwd: string; input: string; timeoutMs: number; }
export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null; }
export interface ProcessRunner { run(request: ProcessRequest): Promise<ProcessResult>; }
export type AgentErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'PROCESS_ERROR' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'FAILED' | 'EMPTY_OUTPUT';
export class AgentExecutionError extends Error {
  constructor(public readonly code: AgentErrorCode, message: string) { super(message); this.name = 'AgentExecutionError'; }
}
/** No shell interpolation. Output is bounded and diagnostics are not automatically logged. */
export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, request.args, { cwd: request.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0;
      let failure: AgentExecutionError | undefined;
      const stop = (error: AgentExecutionError) => { failure ??= error; child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop(new AgentExecutionError('TIMEOUT', 'Agent execution timed out.')), request.timeoutMs);
      const collect = (kind: 'stdout' | 'stderr', data: string) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 4 * 1024 * 1024) { stop(new AgentExecutionError('OUTPUT_LIMIT', 'Agent output exceeded 4 MiB.')); return; }
        if (kind === 'stdout') stdout += data; else stderr += data;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => collect('stdout', data));
      child.stderr.on('data', data => collect('stderr', data));
      child.on('error', error => {
        clearTimeout(timer);
        reject(new AgentExecutionError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'PROCESS_ERROR', `Could not start ${request.executable}; check CLI installation and workspace.`));
      });
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(new AgentExecutionError('PROCESS_ERROR', 'Could not send instruction to agent.')); });
      child.on('close', exitCode => {
        clearTimeout(timer);
        if (failure) reject(failure); else resolve({ stdout, stderr, exitCode });
      });
      child.stdin.end(request.input);
    });
  }
}
abstract class CliExecutor implements AgentExecutor {
  constructor(private readonly executable: string, private readonly runner: ProcessRunner) {}
  protected abstract invocation(instruction: string): { args: string[]; input: string };
  async execute(request: AgentRequest): Promise<AgentResult> {
    const timeoutMs = request.timeoutMs ?? 120_000;
    if (!request.instruction.trim() || Buffer.byteLength(request.instruction) > 64 * 1024 || !isAbsolute(request.workspace) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new AgentExecutionError('INVALID_REQUEST', 'Provide an absolute workspace, nonempty instruction (up to 64 KiB), and a valid timeout.');
    }
    try { if (!(await stat(request.workspace)).isDirectory()) throw new Error(); }
    catch { throw new AgentExecutionError('INVALID_REQUEST', 'Workspace must be an existing directory.'); }
    const invocation = this.invocation(request.instruction);
    const result = await this.runner.run({ executable: this.executable, ...invocation, cwd: request.workspace, timeoutMs });
    if (result.exitCode !== 0) throw new AgentExecutionError('FAILED', `${this.executable} failed (exit ${result.exitCode ?? 'signal'}); check authentication and CLI compatibility.`);
    if (!result.stdout.trim()) throw new AgentExecutionError('EMPTY_OUTPUT', `${this.executable} returned no output.`);
    return { output: result.stdout.trim() };
  }
}
export class CodexExecutor extends CliExecutor {
  constructor(runner: ProcessRunner = new NodeProcessRunner(), executable = 'codex') { super(executable, runner); }
  protected invocation(instruction: string) {
    return { args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '-'], input: instruction };
  }
}
export class ClaudeCodeExecutor extends CliExecutor {
  constructor(runner: ProcessRunner = new NodeProcessRunner(), executable = 'claude') { super(executable, runner); }
  protected invocation(instruction: string) {
    return { args: ['--print', '--output-format', 'text', '--tools', '', '--permission-mode', 'dontAsk'], input: instruction };
  }
}
export class CopilotExecutor extends CliExecutor {
  constructor(runner: ProcessRunner = new NodeProcessRunner(), executable = 'copilot') { super(executable, runner); }
  protected invocation(instruction: string) {
    return { args: ['--prompt', instruction, '--silent', '--no-ask-user', '--available-tools', 'view', '--deny-tool', 'write', '--deny-tool', 'shell'], input: '' };
  }
}
export function createAgentExecutor(name: AgentName, runner: ProcessRunner = new NodeProcessRunner()): AgentExecutor {
  switch (name) {
    case 'codex': return new CodexExecutor(runner);
    case 'claude': return new ClaudeCodeExecutor(runner);
    case 'copilot': return new CopilotExecutor(runner);
    default: throw new AgentExecutionError('INVALID_REQUEST', `Unknown agent: ${name}`);
  }
}
