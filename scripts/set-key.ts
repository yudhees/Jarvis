/**
 * Saves a key to Windows Credential Manager with a hidden prompt.
 *
 *   npm run set-key -- anthropic
 *   npm run set-key -- picovoice
 *   npm run set-key -- --check     shows which keys are saved (never the values)
 *
 * Run it in your own terminal. Never paste keys into a chat or a file.
 */
import {
  isSecretName,
  promptAndSaveSecret,
  readSecret,
  SECRET_HELP,
  SECRET_NAMES,
} from '@jarvis/core/secrets';

const arg = process.argv[2] ?? '';

if (arg === '--check') {
  for (const name of SECRET_NAMES) {
    const value = await readSecret(name);
    console.log(`${name.padEnd(10)} ${value ? 'saved' : 'missing'}  (${SECRET_HELP[name]})`);
  }
} else if (isSecretName(arg)) {
  console.log(`Saving your ${SECRET_HELP[arg]}.`);
  process.exitCode = promptAndSaveSecret(arg) ? 0 : 1;
} else {
  console.log(`Usage: npm run set-key -- <${SECRET_NAMES.join(' | ')}>   or   --check`);
  process.exitCode = 1;
}
