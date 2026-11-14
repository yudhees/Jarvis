import type { CoreToPetEvent, PetHello, PetToCoreEvent } from '@jarvis/shared';
import { parseCoreEvent } from './events.ts';

export interface CoreLinkOptions {
  port: number;
  token: string;
  onEvent: (event: CoreToPetEvent) => void;
  onStatus: (connected: boolean) => void;
}

/**
 * The pet's connection to core (CLAUDE.md 12): ws://127.0.0.1 only, token sent
 * as the first message, reconnects quietly if core restarts.
 */
export class CoreLink {
  private readonly options: CoreLinkOptions;
  private socket: WebSocket | undefined;
  private retry: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: CoreLinkOptions) {
    this.options = options;
  }

  start(): void {
    this.connect();
  }

  send(event: PetToCoreEvent): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}/pet`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      const hello: PetHello = { type: 'hello', token: this.options.token };
      socket.send(JSON.stringify(hello));
      this.options.onStatus(true);
    });
    socket.addEventListener('message', (msg) => {
      const event = parseCoreEvent(typeof msg.data === 'string' ? msg.data : null);
      if (event) this.options.onEvent(event);
    });
    socket.addEventListener('close', () => {
      this.options.onStatus(false);
      if (!this.closed) this.retry = setTimeout(() => this.connect(), 2000);
    });
    socket.addEventListener('error', () => {
      // 'close' follows and schedules the retry
    });
  }
}
