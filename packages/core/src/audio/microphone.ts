import pvrecorder from '@picovoice/pvrecorder-node';

const { PvRecorder } = pvrecorder;

/**
 * Microphone frames as an async stream (16 kHz, 16-bit mono, `frameLength` samples each).
 * The device is held only while `frames()` is being iterated, so stopping the
 * iteration (or aborting) releases the mic completely, as MUTED requires.
 */
export class Microphone {
  readonly frameLength: number;
  readonly deviceIndex: number;

  constructor(frameLength: number, deviceIndex = -1) {
    this.frameLength = frameLength;
    this.deviceIndex = deviceIndex;
  }

  static devices(): string[] {
    return PvRecorder.getAvailableDevices();
  }

  async *frames(
    signal?: AbortSignal,
    onOpen?: (deviceName: string) => void,
  ): AsyncGenerator<Int16Array> {
    if (signal?.aborted) return;
    const recorder = new PvRecorder(this.frameLength, this.deviceIndex);
    try {
      recorder.start();
      onOpen?.(recorder.getSelectedDevice());
      while (!signal?.aborted) {
        yield await recorder.read();
      }
    } finally {
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
      recorder.release();
    }
  }
}
