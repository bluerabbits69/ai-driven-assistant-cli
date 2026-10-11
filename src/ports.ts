import type { WorkflowPhase } from './gate.js';
export type ProjectMode = 'greenfield' | 'brownfield';
export interface ProjectContext { root: string; mode: ProjectMode; }
export interface WorkspaceManager {
  createFromMain(featureId: string, phase: WorkflowPhase): Promise<{ path: string; branch: string }>;
}
/** A Spec Kit document generated as text. `path` is relative to the workspace root and is validated by the writer. */
export interface GeneratedArtifact { path: string; content: string; }
/**
 * Builds instructions from Spec Kit templates and approved context, and returns generated documents as text through a
 * read-only AgentExecutor. It never writes files, runs Spec Kit commands, scripts or hooks, or creates branches;
 * the workflow validates and saves the returned artifacts (see docs/architecture.md).
 */
export interface SpecKitAdapter {
  constitution(context: ProjectContext): Promise<GeneratedArtifact>;
  specify(featureId: string, workspace: string): Promise<GeneratedArtifact[]>;
  design(featureId: string, workspace: string): Promise<{ artifacts: GeneratedArtifact[]; proposals: DesignProposal[] }>;
  /** Undecided: how implementation changes are produced and applied is outside the text-generation decision. */
  implement(featureId: string, workspace: string): Promise<void>;
}
export interface DesignProposal {
  title: string;
  rank: number;
  rationale: string;
  tradeoffs: string[];
}
export interface PullRequestPublisher {
  createDraft(input: {
    branch: string; title: string; body: string; proposals?: DesignProposal[];
  }): Promise<{ number: number; url: string }>;
}
