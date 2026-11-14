import { type FSWatcher, watch } from 'node:fs';
import { ConfigError, loadConfig } from './load.ts';
import type { JarvisConfig } from './schema.ts';

/**
 * Calls `onChange` with the new jarvis.yaml settings after the file changes
 * (from the Settings window or by hand). An invalid file is reported and
 * ignored, so a typo never stops a running Jarvis. Returns a stop function.
 */
export function watchJarvisConfig(
  configDir: string,
  onChange: (jarvis: JarvisConfig) => void,
  onProblem: (message: string) => void,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(configDir, (_event, file) => {
      if (file !== 'jarvis.yaml') return;
      // Editors and atomic renames fire several events; settle first.
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          onChange(loadConfig(configDir).jarvis);
        } catch (err) {
          const detail =
            err instanceof ConfigError ? err.problems.join('; ') : (err as Error).message;
          onProblem(`jarvis.yaml not reloaded: ${detail}`);
        }
      }, 300);
    });
  } catch (err) {
    onProblem(`cannot watch the config folder: ${(err as Error).message}`);
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
