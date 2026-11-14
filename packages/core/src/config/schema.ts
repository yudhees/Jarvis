import { z } from 'zod';

const modelId = z.string().regex(/^claude-[a-z0-9-]+$/, 'must look like a Claude model ID');

export const modelsSchema = z.strictObject({
  tiers: z.strictObject({
    simple: modelId,
    standard: modelId,
    complex: modelId,
  }),
  classifier: modelId,
});

export const riskTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

/** The "unlisted = tier 2" default is not configurable on purpose. */
export const permissionsSchema = z.strictObject({
  tools: z.record(z.string().min(1), riskTierSchema),
});

const stdioServer = z.strictObject({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
const httpServer = z.strictObject({
  type: z.literal('http'),
  url: z.url(),
  enabled: z.boolean().default(true),
});
export const mcpSchema = z.strictObject({
  servers: z.record(z.string().min(1), z.discriminatedUnion('type', [stdioServer, httpServer])),
});

const positiveInt = z.int().positive();
const seconds = z.number().positive();
const deviceIndex = z.int().min(-1);

export const jarvisSchema = z.strictObject({
  dataDir: z.string().min(1),
  audio: z.strictObject({
    sampleRate: z.literal(16000),
    frameLength: positiveInt,
    inputDevice: deviceIndex,
    outputDevice: deviceIndex,
  }),
  listening: z.strictObject({
    maxRecordSeconds: seconds,
    followUpSeconds: seconds,
  }),
  approval: z.strictObject({
    timeoutSeconds: seconds,
  }),
  tasks: z.strictObject({
    maxTurns: positiveInt,
    maxSeconds: seconds,
    maxIdenticalToolCalls: positiveInt,
  }),
  latency: z.strictObject({
    instantSeconds: seconds,
    normalSeconds: seconds,
  }),
  voice: z.strictObject({
    provider: z.literal('windows-sapi'),
    voice: z.string().min(1).nullable(),
    rate: z.int().min(-10).max(10),
    requestTimeoutSeconds: seconds,
  }),
  budget: z.strictObject({
    dailyCostUsd: z.number().positive().nullable(),
    dailyTokens: positiveInt.nullable(),
  }),
  files: z.strictObject({
    allowedFolders: z.array(z.string().min(1)),
  }),
  retention: z.strictObject({
    transcriptDays: positiveInt,
  }),
  learning: z.strictObject({
    enabled: z.boolean(),
    aboutUserTokenCap: positiveInt,
  }),
  skills: z.strictObject({
    enabled: z.boolean(),
    maxPerRequest: z.int().min(0).max(5),
    exclude: z.array(z.string().min(1)),
    extraDirs: z.array(z.string().min(1)),
  }),
});

export type ModelsConfig = z.infer<typeof modelsSchema>;
export type PermissionsConfig = z.infer<typeof permissionsSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type JarvisConfig = z.infer<typeof jarvisSchema>;

export interface Config {
  models: ModelsConfig;
  permissions: PermissionsConfig;
  mcp: McpConfig;
  jarvis: JarvisConfig;
}
