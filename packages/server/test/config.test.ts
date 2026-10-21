import { describe, expect, it } from 'vitest';
import { parsePort } from '../src/config.js';

describe('parsePort', () => {
  it('accepts valid ports and treats empty as unset', () => {
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort('')).toBeUndefined();
    expect(parsePort('8787')).toBe(8787);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects junk and out-of-range values', () => {
    expect(() => parsePort('0')).toThrow(/between 1 and 65535/);
    expect(() => parsePort('65536')).toThrow();
    expect(() => parsePort('8.5')).toThrow();
    expect(() => parsePort('http')).toThrow();
  });
});
