import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/stack.js';

const app = new cdk.App();
const stage = String(app.node.tryGetContext('stage') ?? 'staging');
new AppStack(app, `booking-app-${stage}`, {
  stage,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
