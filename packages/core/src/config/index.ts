export { ConfigError, defaultConfigDir, expandWindowsVars, loadConfig } from './load.ts';
export type {
  Config,
  JarvisConfig,
  McpConfig,
  ModelsConfig,
  PermissionsConfig,
} from './schema.ts';
export type { EditableKey, EditableSettings, SettingsResult } from './settings.ts';
export { EDITABLE_SETTINGS, LIVE_SETTINGS, readSettings, writeSettings } from './settings.ts';
export { watchJarvisConfig } from './watch.ts';
