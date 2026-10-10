import type { WorkflowPhase } from './gate.js';
export type ProjectMode = 'greenfield' | 'brownfield';
export interface ProjectContext { root: string; mode: ProjectMode; }
export interface WorkspaceManager {
  createFromMain(featureId: string, phase: WorkflowPhase): Promise<{ path: string; branch: string }>;
}
/** An agent adapter invokes Spec Kit skills; these are not shell commands. */
export interface SpecKitAdapter {
  constitution(context: ProjectContext): Promise<void>;
  specify(featureId: string, workspace: string): Promise<void>;
  design(featureId: string, workspace: string): Promise<DesignProposal[]>;
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
