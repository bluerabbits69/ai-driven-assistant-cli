export type WorkflowPhase = 'specification' | 'design' | 'implementation';
export type ArtifactPhase = 'constitution' | 'specification' | 'design';
export type GateResult = { allowed: true } | { allowed: false; reason: string };

export interface WorkflowGate {
  check(phase: WorkflowPhase, featureId?: string): Promise<GateResult>;
}

/** Evidence must come from trusted GitHub/Git adapters, never a user-editable flag. */
export interface ApprovalEvidence {
  phase: ArtifactPhase;
  featureId?: string;
  reviewed: boolean;
  merged: boolean;
  baseBranch: string;
  mergeCommitOnMain: boolean;
  artifactsPresent: boolean;
  artifactsMatchApproved: boolean;
}
export interface ApprovalReader {
  read(phase: ArtifactPhase, featureId?: string): Promise<ApprovalEvidence | undefined>;
}
const prerequisite: Record<WorkflowPhase, ArtifactPhase> = {
  specification: 'constitution', design: 'specification', implementation: 'design',
};

export class ReviewMergeGate implements WorkflowGate {
  constructor(private readonly approvals: ApprovalReader) {}
  async check(phase: WorkflowPhase, featureId?: string): Promise<GateResult> {
    if (phase !== 'specification' && !featureId) {
      return { allowed: false, reason: 'Feature ID is required.' };
    }
    const required = prerequisite[phase];
    const scope = required === 'constitution' ? undefined : featureId;
    try {
      const evidence = await this.approvals.read(required, scope);
      if (!evidence) return { allowed: false, reason: `No verified approval evidence for ${required}.` };
      if (evidence.phase !== required || evidence.featureId !== scope) {
        return { allowed: false, reason: 'Approval evidence does not match the requested phase/feature.' };
      }
      if (!evidence.reviewed || !evidence.merged || evidence.baseBranch !== 'main') {
        return { allowed: false, reason: `${required} must be reviewed and merged into main.` };
      }
      if (!evidence.mergeCommitOnMain || !evidence.artifactsPresent || !evidence.artifactsMatchApproved) {
        return { allowed: false, reason: 'Approved artifacts must exist unchanged on current main.' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'Could not verify approval evidence. Retry after checking Git/GitHub access.' };
    }
  }
}
