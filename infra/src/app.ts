import * as cdk from 'aws-cdk-lib';
import { ControlPlaneStack } from './stack.js';

const app = new cdk.App();
new ControlPlaneStack(app, 'CloudEngineerControlPlane');
app.synth();
