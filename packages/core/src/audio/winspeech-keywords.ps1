# Wake and stop keywords with the speech recognizer built into Windows
# (System.Speech, no download, no account). Core writes raw 16 kHz 16-bit mono
# mic audio to stdin; this prints "ready", then one line per keyword heard:
#   "wake <confidence> <text>"  or  "stop <confidence> <text>"
# Ordinary speech is matched against a dictation "garbage" grammar instead of
# being forced onto the keywords. JARVIS_KEYWORD_DEBUG=1 also prints what it ignored.
param([double]$MinConfidence = 0.7)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Globalization;
using System.Speech.AudioFormat;
using System.Speech.Recognition;

// The recognizer insists on a seekable stream; stdin is a pipe. This reads
// forward only and waits for more audio instead of reporting the end.
public class JarvisPipeAudio : Stream {
  private readonly Stream src;
  private long pos;
  public JarvisPipeAudio(Stream s) { src = s; }
  public override bool CanRead { get { return true; } }
  public override bool CanSeek { get { return true; } }
  public override bool CanWrite { get { return false; } }
  public override long Length { get { return long.MaxValue; } }
  public override long Position { get { return pos; } set { } }
  // A short read means "end of audio" to the recognizer, so fill the whole buffer.
  public override int Read(byte[] buffer, int offset, int count) {
    int got = 0;
    while (got < count) {
      int n = src.Read(buffer, offset + got, count - got);
      if (n == 0) Environment.Exit(0); // core ended: its pipe closed
      got += n;
    }
    pos += got;
    return got;
  }
  public override long Seek(long offset, SeekOrigin origin) { return pos; }
  public override void SetLength(long value) { }
  public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
  public override void Flush() { }
}

public static class JarvisKeywords {
  static Grammar Phrases(string name, CultureInfo culture, params string[] phrases) {
    var builder = new GrammarBuilder(new Choices(phrases));
    builder.Culture = culture;
    var g = new Grammar(builder);
    g.Name = name;
    return g;
  }

  static void Say(string line) {
    Console.Out.WriteLine(line);
    Console.Out.Flush();
  }

  public static void Run(double minConfidence, bool debug) {
    var culture = new CultureInfo("en-US");
    var rec = new SpeechRecognitionEngine(culture);
    rec.LoadGrammar(Phrases("wake", culture, "jarvis", "hey jarvis", "hi jarvis", "okay jarvis"));
    // "Jarvis, what's two plus two" in one breath is caught by dictation; a
    // dictated sentence that STARTS with the wake word counts as a wake.
    var lead = new System.Text.RegularExpressions.Regex(
      @"^(?:(?:hey|hi|hay|a|ok|okay)\s+)?jarvis\b",
      System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    rec.LoadGrammar(Phrases("stop", culture, "jarvis stop", "stop jarvis"));
    var garbage = new DictationGrammar();
    garbage.Name = "other";
    rec.LoadGrammar(garbage);
    rec.SetInputToAudioStream(
      new JarvisPipeAudio(Console.OpenStandardInput()),
      new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
    var done = new ManualResetEvent(false);
    rec.SpeechRecognized += (s, e) => {
      var r = e.Result;
      var kind = r.Grammar.Name;
      if (kind == "other" && lead.IsMatch(r.Text.Trim())) kind = "wake";
      if ((kind == "wake" || kind == "stop") && r.Confidence >= minConfidence) {
        // Where the phrase started in the audio, so core can keep the request
        // that followed the wake word in the same breath.
        double start = r.Audio == null ? -1 : r.Audio.AudioPosition.TotalSeconds;
        Say(string.Format(CultureInfo.InvariantCulture, "{0} {1:0.00} {2:0.000} {3}", kind, r.Confidence, start, r.Text));
      } else if (debug) {
        Say(string.Format(CultureInfo.InvariantCulture, "ignored {0} {1:0.00} {2}", kind, r.Confidence, r.Text));
      }
    };
    if (debug) {
      rec.SpeechDetected += (s, e) => Say("debug speech at " + e.AudioPosition);
      rec.SpeechRecognitionRejected += (s, e) => Say("debug rejected " + (e.Result == null ? "" : e.Result.Text));
      rec.AudioStateChanged += (s, e) => Say("debug audio " + e.AudioState);
    }
    rec.RecognizeCompleted += (s, e) => {
      if (debug) Say("debug completed " + (e.Error == null ? "" : e.Error.Message));
      done.Set();
    };
    rec.RecognizeAsync(RecognizeMode.Multiple);
    Say("ready");
    done.WaitOne();
  }
}
'@

[JarvisKeywords]::Run($MinConfidence, [bool]$env:JARVIS_KEYWORD_DEBUG)
