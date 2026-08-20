import { describe, it, expect } from 'vitest';
import { sortByLastMessage } from './userChats.js';

// Pure sort logic only — the collection itself (userChats) is localStorage-backed and untested
// here, same precedent as formData.test.js.
describe('sortByLastMessage', () => {
  it('orders most-recently-active conversation first', () => {
    const conversations = [
      { id: 'a', lastMessageAt: 100 },
      { id: 'b', lastMessageAt: 300 },
      { id: 'c', lastMessageAt: 200 },
    ];
    expect(sortByLastMessage(conversations).map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('treats a missing lastMessageAt as oldest, not a sort error', () => {
    const conversations = [{ id: 'a', lastMessageAt: 100 }, { id: 'b' }];
    expect(sortByLastMessage(conversations).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const conversations = [{ id: 'a', lastMessageAt: 1 }, { id: 'b', lastMessageAt: 2 }];
    const copy = [...conversations];
    sortByLastMessage(conversations);
    expect(conversations).toEqual(copy);
  });
});
