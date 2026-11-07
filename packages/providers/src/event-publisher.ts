import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { DomainEvent } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { EventPublisher } from '@cloud-engineer/workflow';
import type { DocClient } from './dynamo-store.js';

export const EVENT_SOURCE = 'cloud-engineer';

/**
 * Publishes domain events to an EventBridge bus: Source `cloud-engineer`, DetailType = event type,
 * Detail = the event JSON (ids, timestamps and artifact hashes only: no prompt, no secrets).
 */
export class EventBridgePublisher implements EventPublisher {
  constructor(
    private readonly client: DocClient,
    private readonly busName: string,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    const res = (await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: EVENT_SOURCE,
            DetailType: event.type,
            Detail: JSON.stringify(event),
          },
        ],
      }),
    )) as { FailedEntryCount?: number; Entries?: { ErrorMessage?: string }[] };
    if (res.FailedEntryCount) {
      throw new CloudEngineerError(
        'CONFLICT',
        `EventBridge rejected the event: ${res.Entries?.[0]?.ErrorMessage ?? 'unknown'}`,
      );
    }
  }
}

export function createEventPublisher(region: string, busName: string): EventBridgePublisher {
  return new EventBridgePublisher(new EventBridgeClient({ region }), busName);
}
