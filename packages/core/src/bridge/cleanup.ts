import { spawnSync } from 'node:child_process';

/**
 * Stops helper processes left behind by a Jarvis that ended without cleaning
 * up (closed terminal, crash): Whisper, the PowerShell hosts and the pet whose
 * parent no longer exists. Only processes whose command line points into this
 * project or Jarvis's data folder are touched. Returns how many were stopped.
 */
export function stopOrphanedHelpers(projectDir: string, dataDir: string): number {
  const script = `
$all = Get-CimInstance Win32_Process
$alive = @{}
foreach ($p in $all) { $alive[[int]$p.ProcessId] = $true }
$marks = @($env:JARVIS_PROJECT_DIR, $env:JARVIS_DATA_DIR)
$n = 0
foreach ($p in $all) {
  $c = $p.CommandLine
  if (-not $c -or $alive[[int]$p.ParentProcessId]) { continue }
  $ours = $false
  foreach ($m in $marks) { if ($m -and $c.IndexOf($m, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $ours = $true } }
  if (-not $ours) { continue }
  if ($c -match 'whisper-server|hotkey-host\\.ps1|winspeech-keywords\\.ps1|sapi-host\\.ps1|electron\\.exe') {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $n++
  }
}
$n`;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, JARVIS_PROJECT_DIR: projectDir, JARVIS_DATA_DIR: dataDir },
    },
  );
  return Number.parseInt(r.stdout?.trim() ?? '', 10) || 0;
}
