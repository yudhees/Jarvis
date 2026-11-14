# Long-lived text-to-speech host for Jarvis (Windows PowerShell 5.1, System.Speech).
# Protocol, one JSON object per line:
#   in:  {"id":1,"text":"Hello","voice":null,"rate":0}
#   out: {"type":"ready","voices":[...]}            once at start
#        {"type":"done","id":1,"pcm":"<base64>"}    16 kHz, 16-bit, mono, little-endian PCM
#        {"type":"error","id":1,"message":"..."}
# Nothing is written to disk.

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$defaultVoice = $synth.Voice.Name

function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
Send @{ type = 'ready'; voices = $voices }

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  $stream = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    if ($req.voice) { $synth.SelectVoice([string]$req.voice) } else { $synth.SelectVoice($defaultVoice) }
    $synth.Rate = [int]$req.rate
    $stream = New-Object System.IO.MemoryStream
    $synth.SetOutputToAudioStream($stream, $format)
    $synth.Speak([string]$req.text)
    $synth.SetOutputToNull()
    $b64 = [Convert]::ToBase64String($stream.ToArray())
    # Base64 needs no JSON escaping, and building the line by hand is much faster.
    [Console]::Out.WriteLine('{"type":"done","id":' + $id + ',"pcm":"' + $b64 + '"}')
    [Console]::Out.Flush()
  } catch {
    try { $synth.SetOutputToNull() } catch { }
    Send @{ type = 'error'; id = $id; message = $_.Exception.Message }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}
$synth.Dispose()
