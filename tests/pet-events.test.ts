import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { demoFinish, demoScript } from '../packages/pet/src/main/demo.ts';
import { parseCoreEvent } from '../packages/pet/src/main/events.ts';

describe('parseCoreEvent (what the pet accepts from core)', () => {
  it('accepts well-formed events, as objects or JSON text', () => {
    assert.ok(parseCoreEvent({ type: 'state', state: 'LISTENING' }));
    assert.ok(parseCoreEvent('{"type":"mic_level","level":0.4}'));
    assert.ok(
      parseCoreEvent({
        type: 'approval_request',
        id: 'a1',
        sentence: 'Delete branch x?',
        code: '47',
      }),
    );
    assert.ok(
      parseCoreEvent({ type: 'model_selected', tier: 'complex', speed: 'normal', model: 'Opus' }),
    );
  });

  it('drops anything malformed or unknown', () => {
    const bad: unknown[] = [
      'not json',
      null,
      { type: 'approve', id: 'x' }, // the pet never handles approvals
      { type: 'state', state: 'HACKED' },
      { type: 'mic_level', level: 3 },
      { type: 'reply_text', text: 'x'.repeat(5000) },
      { type: 'approval_request', id: 'a', sentence: 'ok', code: '<b>1</b>' },
      { type: 'tool_end', tool: 'jira' },
      { type: 'model_selected', tier: 'huge', model: 'X' },
    ];
    for (const raw of bad) assert.equal(parseCoreEvent(raw), null, JSON.stringify(raw));
  });

  it('the demo only uses events the pet accepts, stops to ask, and ends asleep', () => {
    const first = demoScript().filter((s) => 'event' in s);
    assert.equal(
      first.at(-1) && 'event' in first.at(-1)! ? first.at(-1)!.event.type : '',
      'input_request',
    );
    const steps = demoFinish('PROJ · Platform', 'Login times out');
    for (const step of steps) {
      if ('event' in step) assert.ok(parseCoreEvent(step.event), JSON.stringify(step.event));
    }
    const last = steps.filter((s) => 'event' in s).at(-1);
    assert.deepEqual(last && 'event' in last ? last.event : null, {
      type: 'state',
      state: 'SLEEPING',
    });
  });
});
