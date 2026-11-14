import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findSensitive,
  InMemoryFiles,
  JsonDoc,
  MemoryStore,
  SensitiveContentError,
} from '@jarvis/core/memory';

describe('findSensitive', () => {
  const blocked = [
    'my password is hunter2',
    'the api key is abc',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'xoxb-1234567890-abcdefghij',
    'AKIAABCDEFGHIJKLMNOP',
    'card 4111 1111 1111 1111',
    'I take medication for blood pressure',
  ];
  for (const text of blocked) {
    it(`blocks: ${text}`, () => assert.notEqual(findSensitive(text), null));
  }

  const allowed = [
    'I prefer short answers',
    'My manager is Priya',
    'The standup is at 9:30',
    'Call 555 0100 for the office',
    'Ticket number 1234567',
  ];
  for (const text of allowed) {
    it(`allows: ${text}`, () => assert.equal(findSensitive(text), null));
  }
});

describe('MemoryStore', () => {
  it('saves, reloads from the backend, and searches by word stems', async () => {
    const files = new InMemoryFiles();
    const store = await MemoryStore.open(files);
    await store.save({ kind: 'preference', text: 'I prefer short answers', source: 'user_said' });
    await store.save({ kind: 'fact', text: 'My manager is Priya', source: 'user_said' });

    const reopened = await MemoryStore.open(files);
    assert.equal(reopened.size, 2);
    assert.equal(
      reopened.search('preferences about answer length')[0]?.text,
      'I prefer short answers',
    );
    assert.equal(reopened.search('who is priya')[0]?.kind, 'fact');
    assert.deepEqual(reopened.search('the a of'), []);
  });

  it('replaces keyed items instead of duplicating them', async () => {
    const files = new InMemoryFiles();
    const store = await MemoryStore.open(files);
    await store.save({
      kind: 'preference',
      key: 'name',
      value: 'Yu',
      text: 'Call the user Yu.',
      source: 'user_said',
    });
    await store.save({
      kind: 'preference',
      key: 'name',
      value: 'Dee',
      text: 'Call the user Dee.',
      source: 'user_said',
    });
    assert.equal(store.size, 1);
    assert.equal((await files.listAll()).length, 1);
    assert.equal(store.findByKey('preference', 'name')?.value, 'Dee');
  });

  it('refuses secrets and stores nothing', async () => {
    const files = new InMemoryFiles();
    const store = await MemoryStore.open(files);
    await assert.rejects(
      store.save({ kind: 'fact', text: 'my password is hunter2', source: 'user_said' }),
      SensitiveContentError,
    );
    assert.equal((await files.listAll()).length, 0);
  });

  it('forgetMatching needs every word, so it does not over-delete', async () => {
    const store = await MemoryStore.open(new InMemoryFiles());
    await store.save({ kind: 'fact', text: 'Priya is my manager', source: 'user_said' });
    await store.save({ kind: 'fact', text: 'My manager likes short updates', source: 'user_said' });
    const removed = await store.forgetMatching('Priya manager');
    assert.equal(removed.length, 1);
    assert.equal(store.size, 1);
  });

  it('keeps state documents separate from memories', async () => {
    const files = new InMemoryFiles();
    const store = await MemoryStore.open(files);
    const doc = new JsonDoc(store, '/_jarvis/test.json', { n: 0 });
    doc.value.n = 5;
    await doc.save();
    const reopened = await MemoryStore.open(files);
    assert.equal(reopened.size, 0, 'state file is not a memory');
    assert.equal(new JsonDoc(reopened, '/_jarvis/test.json', { n: 0 }).value.n, 5);
    assert.throws(() => new JsonDoc(reopened, '/fact/x.json', {}));
  });

  it('ignores files it cannot parse', async () => {
    const files = new InMemoryFiles();
    await files.create('/fact/hand-written.md', 'just some text with no header');
    const store = await MemoryStore.open(files);
    assert.equal(store.size, 0);
  });
});
