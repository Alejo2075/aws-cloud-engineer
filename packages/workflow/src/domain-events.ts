import { createHash } from 'node:crypto';
import type { AuditEvent, DomainEvent, Run } from '@cloud-engineer/contracts';

/** Best-effort sink for domain events (EventBridge in the cloud). */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

const BY_ARTIFACT: Record<string, DomainEvent['type']> = {
  blueprint: 'BlueprintPublished',
  plan: 'DeploymentApprovalRequested',
  manifest: 'SystemHandoffPublished',
};

/** Maps an audit entry to the public domain event it represents, if any. */
export function toDomainEvent(run: Run, audit: AuditEvent): DomainEvent | undefined {
  const detail = audit.detail ?? {};
  let type: DomainEvent['type'] | undefined;
  let artifacts: DomainEvent['artifacts'];
  switch (audit.type) {
    case 'RunCreated':
      type = 'RunCreated';
      break;
    case 'ArtifactAttached': {
      type = BY_ARTIFACT[String(detail.kind)];
      artifacts = [{ kind: String(detail.kind), sha256: String(detail.sha256) }];
      break;
    }
    case 'StageChanged':
      if (detail.to === 'TEST') type = 'BuildCompleted';
      if (detail.to === 'VERIFY') type = 'DeploymentCompleted';
      break;
    case 'RunFailed':
      if (run.stage === 'BUILD' || run.stage === 'TEST') type = 'TestsFailed';
      if (run.stage === 'VERIFY') type = 'VerificationFailed';
      break;
  }
  if (!type) return undefined;
  const id = createHash('sha256')
    .update(`${run.runId}|${audit.type}|${audit.at}|${JSON.stringify(detail)}`)
    .digest('hex');
  return {
    schemaVersion: '1.0.0',
    id,
    type,
    runId: run.runId,
    correlationId: run.correlationId,
    at: audit.at,
    stage: run.stage,
    ...(artifacts ? { artifacts } : {}),
  };
}
