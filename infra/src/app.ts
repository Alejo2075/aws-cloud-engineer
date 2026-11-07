import * as cdk from 'aws-cdk-lib';
import { ControlPlaneApiStack } from './api-stack.js';
import { ControlPlaneStack } from './stack.js';

const app = new cdk.App();
const data = new ControlPlaneStack(app, 'CloudEngineerControlPlane');

// The worker/API stack is opt-in: it needs the exact Bedrock model the planner may call.
//   cdk synth -c modelId=<id> -c bedrockModelArns=<arn>[,<arn>...]
const modelId = app.node.tryGetContext('modelId') as string | undefined;
const arns = (app.node.tryGetContext('bedrockModelArns') as string | undefined)?.split(',');
if (modelId && arns?.length) {
  new ControlPlaneApiStack(app, 'CloudEngineerControlPlaneApi', {
    data,
    modelId,
    bedrockModelArns: arns,
  });
}
app.synth();
