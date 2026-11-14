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
    /** Quiet time that ends what the user is saying. */
    silenceMs: z.int().min(200).max(5000),
    /** After the wake word, give up if no speech starts within this time. */
    startTimeoutSeconds: seconds,
  }),
  keywords: z.strictObject({
    /**
     * windows = the speech recognizer built into Windows (no account);
     * picovoice = Porcupine (needs an AccessKey); none = Ctrl+Alt+L only.
     */
    provider: z.enum(['windows', 'picovoice', 'none']),
    /** Windows: lowest recognizer confidence that counts (0..1). */
    minConfidence: z.number().min(0).max(1),
    /** Windows: volume boost before recognizing, for quiet mics (find it with npm run wake-test). */
    gain: z.number().min(1).max(20),
    /** Picovoice: built-in keyword name, or a path to a Windows .ppn file. */
    wake: z.string().min(1),
    /** Picovoice: path to a "Jarvis stop" .ppn; null = the wake word also interrupts. */
    stop: z.string().min(1).nullable(),
    /** Picovoice: 0..1, higher wakes more easily (and falsely). */
    sensitivity: z.number().min(0).max(1),
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
  brain: z.strictObject({
    /** claude-cli = the user's Claude subscription through Claude Code; api = an API key. */
    provider: z.enum(['claude-cli', 'api']),
    /** Path to claude.exe; null = find it. */
    cliPath: z.string().min(1).nullable(),
    /** Close the Claude CLI after this long without a request (frees ~200 MB). */
    idleStopSeconds: z.int().min(10).max(3600),
  }),
  stt: z.strictObject({
    provider: z.literal('whisper-cpp'),
    model: z.string().regex(/^ggml-[\w.-]+\.bin$/, 'must be a ggml-*.bin model file name'),
    language: z.string().regex(/^[a-z]{2}$/),
    threads: z.int().min(1).max(32),
    port: z.int().min(1024).max(65535),
    idleStopSeconds: z.int().min(0).max(86400),
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
