# Global hotkeys owned by core (CLAUDE.md 10.6): Ctrl+Alt+J stop, Ctrl+Alt+M mute,
# Ctrl+Alt+L talk (start listening, or interrupt).
# Prints "ready", then one line per press ("stop" / "mute" / "talk"), or "error <key>" if
# another program already owns a key. Core ends this process on exit.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarvisHotkeys {
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
}
'@

$MOD_ALT = 0x1; $MOD_CONTROL = 0x2; $MOD_NOREPEAT = 0x4000
$keys = @{ 1 = @('stop', 0x4A); 2 = @('mute', 0x4D); 3 = @('talk', 0x4C) }  # J, M, L
foreach ($id in $keys.Keys) {
  $ok = [JarvisHotkeys]::RegisterHotKey([IntPtr]::Zero, $id, $MOD_CONTROL -bor $MOD_ALT -bor $MOD_NOREPEAT, $keys[$id][1])
  if (-not $ok) { [Console]::Out.WriteLine("error $($keys[$id][0])") }
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

$msg = New-Object JarvisHotkeys+MSG
while ([JarvisHotkeys]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) {
  if ($msg.message -eq 0x0312) {  # WM_HOTKEY
    [Console]::Out.WriteLine($keys[[int]$msg.wParam][0])
    [Console]::Out.Flush()
  }
}
