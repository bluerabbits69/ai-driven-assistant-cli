import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  /**
   * Tail of the CLI's stderr for troubleshooting (auth errors, unsupported options). Kept out of `message` and
   * non-enumerable, so JSON.stringify/console.error and loggers do not emit it, because it may contain tokens or
   * paths; callers decide whether to show or log it.
   */
  declare public readonly diagnostics?: string;
  constructor(public readonly code: AgentErrorCode, message: string, diagnostics?: string) {
    super(message);
    this.name = 'AgentExecutionError';
    if (diagnostics) Object.defineProperty(this, 'diagnostics', { value: diagnostics, enumerable: false });
  }
}
const diagnosticsTail = (stderr: string) => stderr.trim().slice(-4096) || undefined;
/** No shell interpolation. Output is bounded and diagnostics are not automatically logged. */
export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      // A separate process group lets us stop descendants too (e.g. npm/Homebrew shims that start the real CLI),
      // which would otherwise keep the pipes open and delay 'close' past the timeout. Not supported on Windows.
      const group = process.platform !== 'win32';
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(request.executable, request.args, { cwd: request.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: group });
      } catch {
        reject(new AgentExecutionError('PROCESS_ERROR', `Could not start ${request.executable}; check its arguments.`));
        return;
      }
      let stdout = '', stderr = '', bytes = 0, settled = false;
      const killTree = () => {
        try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
      };
      // The child no longer receives terminal signals with its parent, so stop it before re-raising them.
      const onSignal = (signal: NodeJS.Signals) => { killTree(); detach(); process.kill(process.pid, signal); };
      const detach = () => {
        clearTimeout(timer);
        process.off('exit', killTree); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      };
      const fail = (error: AgentExecutionError) => {
        if (settled) return;
        settled = true;
        detach(); killTree(); child.stdout.destroy(); child.stderr.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new AgentExecutionError('TIMEOUT', 'Agent execution timed out.')), request.timeoutMs);
      process.once('exit', killTree); process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
      const collect = (kind: 'stdout' | 'stderr', data: string) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 4 * 1024 * 1024) { fail(new AgentExecutionError('OUTPUT_LIMIT', 'Agent output exceeded 4 MiB.')); return; }
        if (kind === 'stdout') stdout += data; else stderr += data;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => collect('stdout', data));
      child.stderr.on('data', data => collect('stderr', data));
      child.on('error', error => {
        fail(new AgentExecutionError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'PROCESS_ERROR', `Could not start ${request.executable}; check CLI installation and workspace.`));
      });
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail(new AgentExecutionError('PROCESS_ERROR', 'Could not send instruction to agent.')); });
      // Leftover descendants would hold the pipes open after the CLI exits; stop them so 'close' can fire.
      child.on('exit', () => { if (group) killTree(); });
      child.on('close', exitCode => {
        if (settled) return;
        settled = true;
        detach();
        resolve({ stdout, stderr, exitCode });
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
    // NUL cannot be passed in argv (spawn throws), so reject it for every agent to keep behavior consistent.
    if (!request.instruction.trim() || request.instruction.includes('\0') || Buffer.byteLength(request.instruction) > 64 * 1024 || !isAbsolute(request.workspace) ||!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new AgentExecutionError('INVALID_REQUEST', 'Provide an absolute workspace, nonempty instruction without NUL characters (up to 64 KiB), and a valid timeout.');
    }
    try { if (!(await stat(request.workspace)).isDirectory()) throw new Error(); }
    catch { throw new AgentExecutionError('INVALID_REQUEST', 'Workspace must be an existing directory.'); }
    const invocation = this.invocation(request.instruction);
    const result = await this.runner.run({ executable: this.executable, ...invocation, cwd: request.workspace, timeoutMs });
    if (result.exitCode !== 0) throw new AgentExecutionError('FAILED', `${this.executable} failed (exit ${result.exitCode ?? 'signal'}); check authentication and CLI compatibility.`, diagnosticsTail(result.stderr));
    if (!result.stdout.trim()) throw new AgentExecutionError('EMPTY_OUTPUT', `${this.executable} returned no output.`, diagnosticsTail(result.stderr));
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
    // --tools "" only disables built-in tools. Skip all MCP servers, and load only the user's own settings so that
    // hooks and permission rules committed to an untrusted workspace (.claude/settings*.json) never apply.
    return { args: ['--print', '--output-format', 'text', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', 'user'], input: instruction };
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
