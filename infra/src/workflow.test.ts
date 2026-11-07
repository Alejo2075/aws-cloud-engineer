import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { RunWorkflow } from './workflow.js';

const stack = new cdk.Stack(new cdk.App(), 'W');
// Stand-in function so the construct can be synthesized; the real worker does not exist yet.
const worker = new lambda.Function(stack, 'Worker', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline('exports.handler = async () => ({});'),
});
new RunWorkflow(stack, 'Flow', { worker });
const t = Template.fromStack(stack);

/** The definition string is a Fn::Join of literals and refs; keep only the literals. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type State = Record<string, any>;

function definition(): { States: Record<string, State> } {
  const machine = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0]!;
  const parts = machine.Properties.DefinitionString['Fn::Join'][1] as unknown[];
  return JSON.parse(parts.map((p) => (typeof p === 'string' ? p : 'ARN')).join(''));
}

describe('RunWorkflow', () => {
  it('is a Standard workflow with tracing and error logging', () => {
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({ Level: 'ERROR' }),
    });
  });

  it('never retries a deployment, and retries advance only on Lambda service errors', () => {
    const { States } = definition();
    expect(States.Deploy.Retry).toBeUndefined();
    expect(States.Verify.Retry).toBeUndefined();
    expect(States.Advance.Retry).toHaveLength(1);
    expect(States.Advance.Retry[0].ErrorEquals.every((e: string) => e.startsWith('Lambda.'))).toBe(
      true,
    );
    expect(States.Advance.Retry[0].MaxAttempts).toBeLessThanOrEqual(3);
  });

  it('waits for people with task tokens and a bounded timeout, and routes rejection to cancel', () => {
    const { States } = definition();
    for (const name of ['WaitForInput', 'WaitForApproval']) {
      expect(States[name].Resource).toContain('.waitForTaskToken');
      expect(States[name].TimeoutSeconds).toBe(7 * 24 * 3600);
    }
    expect(States['Approved?'].Choices[0].Next).toBe('Deploy');
    expect(States['Approved?'].Default).toBe('RunCancelled');
  });

  it('ends every failure in markFailed and has no dangling or unreachable state', () => {
    const { States } = definition();
    for (const name of ['Advance', 'WaitForInput', 'WaitForApproval', 'Deploy', 'Verify']) {
      expect(States[name].Catch[0].Next, name).toBe('MarkFailed');
    }
    expect(States.MarkFailed.Next).toBe('RunFailed');

    const targets = (s: State): string[] =>
      [
        s.Next,
        s.Default,
        ...(s.Choices ?? []).map((c: { Next: string }) => c.Next),
        ...(s.Catch ?? []).map((c: { Next: string }) => c.Next),
      ].filter(Boolean);
    const reachable = new Set<string>(['Advance']);
    const queue = ['Advance'];
    while (queue.length) {
      for (const n of targets(States[queue.pop()!])) {
        expect(States[n], `missing state ${n}`).toBeDefined();
        if (!reachable.has(n)) {
          reachable.add(n);
          queue.push(n);
        }
      }
    }
    expect([...reachable].sort()).toEqual(Object.keys(States).sort());
  });

  it('can invoke only the worker function', () => {
    const stmts = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[],
    );
    const invokes = stmts.filter((s) => JSON.stringify(s.Action).includes('lambda:InvokeFunction'));
    expect(invokes.length).toBeGreaterThan(0);
    for (const s of invokes) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
  });
});
