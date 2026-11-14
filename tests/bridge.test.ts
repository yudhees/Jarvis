import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { PetBridge, parsePetEvent } from '@jarvis/core/bridge';
import type { CoreToPetEvent, PetToCoreEvent } from '@jarvis/shared';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pet`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('could not connect')));
  });
}

describe('PetBridge', () => {
  it('sends events to the pet after the token, and takes its commands', async () => {
    const got: PetToCoreEvent[] = [];
    let connected = 0;
    const bridge = new PetBridge({ onEvent: (e) => got.push(e), onConnect: () => connected++ });
    const port = await bridge.listen();
    const ws = await connect(port);
    const received: CoreToPetEvent[] = [];
    ws.addEventListener('message', (m) => received.push(JSON.parse(String(m.data))));
    ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await wait(100);
    assert.equal(connected, 1);
    bridge.send({ type: 'state', state: 'LISTENING' });
    bridge.send({ type: 'reply_text', text: 'x'.repeat(300) }); // longer frame
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.send(JSON.stringify({ type: 'approve', id: 'a1' })); // never accepted
    ws.send(JSON.stringify({ type: 'input_reply', id: 'q1', value: 'PROJ' }));
    await wait(100);
    assert.deepEqual(received[0], { type: 'state', state: 'LISTENING' });
    assert.equal(received[1]?.type, 'reply_text');
    assert.deepEqual(got, [{ type: 'stop' }, { type: 'input_reply', id: 'q1', value: 'PROJ' }]);
    ws.close();
    await bridge.close();
  });

  it('closes a connection with the wrong token, and sends it nothing', async () => {
    let connected = 0;
    const bridge = new PetBridge({ onEvent: () => {}, onConnect: () => connected++ });
    const port = await bridge.listen();
    const ws = await connect(port);
    let closed = false;
    const received: string[] = [];
    ws.addEventListener('close', () => {
      closed = true;
    });
    ws.addEventListener('message', (m) => received.push(String(m.data)));
    ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    bridge.send({ type: 'state', state: 'LISTENING' });
    await wait(150);
    assert.equal(closed, true);
    assert.equal(connected, 0);
    assert.deepEqual(received, []);
    await bridge.close();
  });

  it('refuses web pages (Origin header) and other paths', async () => {
    const bridge = new PetBridge({ onEvent: () => {} });
    const port = await bridge.listen();
    const status = (path: string, origin?: string) =>
      new Promise<number>((resolve) => {
        const req = request({
          host: '127.0.0.1',
          port,
          path,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            ...(origin ? { Origin: origin } : {}),
          },
        });
        req.on('upgrade', () => resolve(101));
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', () => resolve(-1));
        req.end();
      });
    assert.notEqual(await status('/pet', 'https://evil.example'), 101);
    assert.notEqual(await status('/other'), 101);
    assert.equal(await status('/pet'), 101);
    await bridge.close();
  });
});

describe('parsePetEvent', () => {
  it('accepts only the few things the pet may ask for', () => {
    assert.deepEqual(parsePetEvent('{"type":"mute"}'), { type: 'mute' });
    assert.equal(parsePetEvent('{"type":"approve","id":"x"}'), null);
    assert.equal(parsePetEvent('{"type":"input_reply","id":"q","value":5}'), null);
    assert.equal(
      parsePetEvent(JSON.stringify({ type: 'input_reply', id: 'q', value: 'a'.repeat(501) })),
      null,
      'answers are capped at 500 characters',
    );
    assert.equal(parsePetEvent('not json'), null);
  });
});
