import {
  BedrockRuntimeClient,
  ConverseCommand,
  type BedrockRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-runtime';
import type { ModelProvider } from '@cloud-engineer/planning';
import { CloudEngineerError } from '@cloud-engineer/shared';

export interface BedrockProviderOptions {
  modelId: string;
  region: string;
  maxTokens?: number;
  clientConfig?: BedrockRuntimeClientConfig;
}

/** Amazon Bedrock Converse adapter. Credentials come from the default AWS provider chain. */
export class BedrockProvider implements ModelProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly opts: BedrockProviderOptions) {
    this.client = new BedrockRuntimeClient({
      region: opts.region,
      maxAttempts: 4,
      ...opts.clientConfig,
    });
  }

  async generate({ system, user }: { system: string; user: string }): Promise<string> {
    const res = await this.client.send(
      new ConverseCommand({
        modelId: this.opts.modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content: [{ text: user }] }],
        inferenceConfig: { maxTokens: this.opts.maxTokens ?? 4096, temperature: 0 },
      }),
    );
    const text = res.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
    if (!text) throw new CloudEngineerError('VALIDATION_FAILED', 'Bedrock returned no text');
    return text;
  }
}

export { FixtureProvider } from '@cloud-engineer/planning';
export * from './dynamo-store.js';
export * from './s3-artifacts.js';
export * from './codebuild-gates.js';
export * from './sfn-tokens.js';
export * from './workspace-store.js';
export * from './event-publisher.js';
export * from './codebuild-deployer.js';
