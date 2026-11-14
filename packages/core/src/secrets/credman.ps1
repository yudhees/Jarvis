# Windows Credential Manager bridge (CLAUDE.md 4: secrets). Generic credentials,
# target "jarvis:<name>". Two modes:
#   -Read <name>   prints the secret to stdout (read by core into memory only)
#   -Set  <name>   asks for the secret with a hidden prompt and stores it; the
#                  secret never passes through Node, the command line, or a file.
param([string]$Read, [string]$Set)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarvisCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);

  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }

  public static void Write(string target, string secret) {
    var c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = "jarvis"; c.Persist = 2;
    c.CredentialBlobSize = secret.Length * 2;
    c.CredentialBlob = Marshal.StringToCoTaskMemUni(secret);
    try {
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception();
    } finally { Marshal.ZeroFreeCoTaskMemUnicode(c.CredentialBlob); }
  }
}
'@

if ($Read) {
  $v = [JarvisCred]::Read("jarvis:$Read")
  if ($null -eq $v) { exit 3 }
  [Console]::Out.Write($v)
  exit 0
}

if ($Set) {
  $secure = Read-Host -AsSecureString "Paste the $Set key (hidden), then press Enter"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
    if ($plain.Length -lt 10) { Write-Host 'That looks too short. Nothing saved.'; exit 2 }
    [JarvisCred]::Write("jarvis:$Set", $plain)
    Write-Host "Saved to Windows Credential Manager as jarvis:$Set."
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  exit 0
}

Write-Host 'Use -Read <name> or -Set <name>.'
exit 1
