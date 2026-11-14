import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { CoreToPetEvent, PetToCoreEvent } from '@jarvis/shared';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Nothing the pet sends is anywhere near this. */
const MAX_MESSAGE = 16 * 1024;
const HELLO_TIMEOUT_MS = 3000;
const MAX_ANSWER = 500;

/** Checks a message from the pet. Anything unexpected is dropped (CLAUDE.md 12). */
export function parsePetEvent(raw: string): PetToCoreEvent | null {
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  switch (o.type) {
    case 'stop':
    case 'mute':
    case 'unmute':
    case 'quit':
    case 'voice_test':
      return { type: o.type };
    case 'input_reply':
      if (typeof o.id !== 'string' || typeof o.value !== 'string') return null;
      if (o.id.length > 64 || o.value.length > MAX_ANSWER) return null;
      return { type: 'input_reply', id: o.id, value: o.value };
    case 'input_cancel':
      if (typeof o.id !== 'string' || o.id.length > 64) return null;
      return { type: 'input_cancel', id: o.id };
    default:
      // Includes any attempt to send "approve": approval is voice only.
      return null;
  }
}

/** One WebSocket frame from the client (always masked). */
interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  length: number;
}

function readFrame(buf: Buffer): Frame | null | 'too_big' | 'bad' {
  if (buf.length < 2) return null;
  const b0 = buf[0] ?? 0;
  const b1 = buf[1] ?? 0;
  if ((b1 & 0x80) === 0) return 'bad'; // clients must mask
  let len = b1 & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    return 'too_big';
  }
  if (len > MAX_MESSAGE) return 'too_big';
  if (buf.length < at + 4 + len) return null;
  const mask = buf.subarray(at, at + 4);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = (buf[at + 4 + i] ?? 0) ^ (mask[i % 4] ?? 0);
  return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, length: at + 4 + len };
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(len)]);
  return Buffer.concat([head, payload]);
}

function bigLength(len: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(len));
  return b;
}

export interface PetBridgeOptions {
  onEvent: (event: PetToCoreEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * Core's side of the pet link (CLAUDE.md 12): a minimal WebSocket server on
 * 127.0.0.1 only. The pet must send the random token as its first message.
 * One pet at a time; browsers are refused (they send an Origin header).
 */
export class PetBridge {
  readonly token = randomBytes(24).toString('base64url');
  readonly #o: PetBridgeOptions;
  readonly #server: Server;
  #pet: Socket | undefined;

  constructor(options: PetBridgeOptions) {
    this.#o = options;
    this.#server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.#server.on('upgrade', (req, socket) => this.#upgrade(req, socket as Socket));
  }

  /** Starts listening; resolves with the port (random unless given). */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, '127.0.0.1', () =>
        resolve((this.#server.address() as AddressInfo).port),
      );
    });
  }

  get connected(): boolean {
    return this.#pet !== undefined;
  }

  send(event: CoreToPetEvent): void {
    const pet = this.#pet;
    if (!pet || pet.destroyed) return;
    pet.write(frame(0x1, Buffer.from(JSON.stringify(event))));
  }

  close(): Promise<void> {
    this.#pet?.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #upgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    const refuse = () => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    };
    if (
      req.url !== '/pet' ||
      req.headers.origin !== undefined || // a web page, not the pet
      typeof key !== 'string' ||
      req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      socket.remoteAddress === undefined ||
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)
    ) {
      refuse();
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let authed = false;
    let buf = Buffer.alloc(0);
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const drop = () => {
      clearTimeout(helloTimer);
      if (this.#pet === socket) {
        this.#pet = undefined;
        this.#o.onDisconnect?.();
      }
    };
    socket.on('close', drop);
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_MESSAGE + 16) {
        socket.destroy();
        return;
      }
      for (;;) {
        const f = readFrame(buf);
        if (f === null) return;
        if (f === 'bad' || f === 'too_big' || !f.fin) {
          socket.destroy();
          return;
        }
        buf = buf.subarray(f.length);
        if (f.opcode === 0x8) {
          socket.end(frame(0x8, Buffer.alloc(0)));
          return;
        }
        if (f.opcode === 0x9) {
          socket.write(frame(0xa, f.payload));
          continue;
        }
        if (f.opcode !== 0x1) continue;
        const text = f.payload.toString('utf8');
        if (!authed) {
          if (!this.#checkHello(text)) {
            socket.destroy();
            return;
          }
          authed = true;
          clearTimeout(helloTimer);
          this.#pet?.destroy(); // a newer pet replaces the old one
          this.#pet = socket;
          this.#o.onConnect?.();
          continue;
        }
        const event = parsePetEvent(text);
        if (event) this.#o.onEvent(event);
      }
    });
  }

  #checkHello(text: string): boolean {
    try {
      const hello = JSON.parse(text) as { type?: unknown; token?: unknown };
      if (hello.type !== 'hello' || typeof hello.token !== 'string') return false;
      const a = Buffer.from(hello.token);
      const b = Buffer.from(this.token);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
