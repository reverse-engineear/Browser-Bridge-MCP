import { describe, expect, it } from 'vitest';
import { MAX_CONSOLE_ENTRIES, type ConsoleEntry } from '@browser-bridge/protocol';
import { ConsoleBuffer } from '../lib/console-buffer.js';

function entry(index: number, text = `line ${index}`): ConsoleEntry {
  return { type: 'log', text, timestamp: 1_000 + index, source: 'fixture.js' };
}

describe('ConsoleBuffer', () => {
  it('keeps entries in arrival order and reports totals', () => {
    const buffer = new ConsoleBuffer();
    buffer.add(entry(1));
    buffer.add(entry(2, 'hello'));

    const snapshot = buffer.snapshot();
    expect(snapshot.entries).toEqual([entry(1), entry(2, 'hello')]);
    expect(snapshot.total).toBe(2);
    expect(snapshot.dropped).toBe(0);
    expect(buffer.size).toBe(2);
  });

  it('returns copies rather than internal references', () => {
    const buffer = new ConsoleBuffer();
    const original = entry(1);
    buffer.add(original);
    original.text = 'mutated after add';

    buffer.snapshot().entries[0]!.text = 'mutated copy';

    expect(buffer.snapshot().entries[0]!.text).toBe('line 1');
  });

  it('drops the oldest entries past the cap', () => {
    const buffer = new ConsoleBuffer();
    for (let index = 0; index < MAX_CONSOLE_ENTRIES + 5; index += 1) buffer.add(entry(index));

    const snapshot = buffer.snapshot();
    expect(buffer.size).toBe(MAX_CONSOLE_ENTRIES);
    expect(snapshot.total).toBe(MAX_CONSOLE_ENTRIES + 5);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.entries[0]!.text).toBe('line 5');
    expect(snapshot.entries.at(-1)!.text).toBe(`line ${MAX_CONSOLE_ENTRIES + 4}`);
  });

  it('clears both entries and counters', () => {
    const buffer = new ConsoleBuffer();
    buffer.add(entry(1));
    buffer.clear();

    expect(buffer.snapshot()).toEqual({ entries: [], total: 0, dropped: 0 });
    buffer.add(entry(2));
    expect(buffer.snapshot()).toMatchObject({ total: 1, dropped: 0 });
  });
});
