import { describe, expect, it } from 'vitest';
import { parseKeyChord } from '../lib/keys.js';

describe('parseKeyChord', () => {
  it('parses a plain letter as typed text', () => {
    expect(parseKeyChord('a')).toEqual({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 0,
      text: 'a',
    });
  });

  it('parses modifier chords without inserting text', () => {
    expect(parseKeyChord('Ctrl+Shift+A')).toEqual({
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 10,
    });
    expect(parseKeyChord('ctrl+c')).toMatchObject({ key: 'c', modifiers: 2 });
    expect(parseKeyChord('Meta+K')).toMatchObject({ key: 'k', modifiers: 4 });
    expect(parseKeyChord('Alt+ArrowLeft')).toMatchObject({
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
      modifiers: 1,
    });
  });

  it('understands modifier aliases', () => {
    for (const alias of ['Alt', 'Option']) expect(parseKeyChord(`${alias}+x`).modifiers).toBe(1);
    for (const alias of ['Ctrl', 'Control']) expect(parseKeyChord(`${alias}+x`).modifiers).toBe(2);
    for (const alias of ['Cmd', 'Command', 'Meta', 'Win', 'Windows']) {
      expect(parseKeyChord(`${alias}+x`).modifiers).toBe(4);
    }
    expect(parseKeyChord('Shift+x').modifiers).toBe(8);
  });

  it('maps named keys', () => {
    expect(parseKeyChord('Enter')).toEqual({
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: '\r',
    });
    expect(parseKeyChord('Tab')).toMatchObject({ key: 'Tab', windowsVirtualKeyCode: 9 });
    expect(parseKeyChord('Escape')).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 });
    expect(parseKeyChord('Esc')).toMatchObject({ key: 'Escape' });
    expect(parseKeyChord('Space')).toMatchObject({ key: ' ', text: ' ' });
    expect(parseKeyChord('PageDown')).toMatchObject({ key: 'PageDown', windowsVirtualKeyCode: 34 });
    expect(parseKeyChord('Home')).toMatchObject({ key: 'Home', windowsVirtualKeyCode: 36 });
    expect(parseKeyChord('F1')).toMatchObject({ key: 'F1', windowsVirtualKeyCode: 112 });
    expect(parseKeyChord('f12')).toMatchObject({ key: 'F12', windowsVirtualKeyCode: 123 });
  });

  it('suppresses text for ctrl, alt and meta chords but keeps Shift typable', () => {
    expect(parseKeyChord('Ctrl+Enter')).toMatchObject({ key: 'Enter', modifiers: 2 });
    expect(parseKeyChord('Ctrl+Enter').text).toBeUndefined();
    expect(parseKeyChord('Shift+Enter')).toMatchObject({ key: 'Enter', modifiers: 8, text: '\r' });
    expect(parseKeyChord('Shift+A')).toMatchObject({ key: 'A', text: 'A' });
  });

  it('handles the plus key itself', () => {
    expect(parseKeyChord('+')).toEqual({
      key: '+',
      code: 'Equal',
      windowsVirtualKeyCode: 187,
      modifiers: 8,
      text: '+',
    });
  });

  it('applies a US shift layout to digits and punctuation', () => {
    expect(parseKeyChord('.')).toMatchObject({ code: 'Period', text: '.', windowsVirtualKeyCode: 190 });
    expect(parseKeyChord('7')).toMatchObject({ code: 'Digit7', text: '7', windowsVirtualKeyCode: 55 });
    expect(parseKeyChord('Shift+7')).toMatchObject({
      key: '&',
      code: 'Digit7',
      modifiers: 8,
      text: '&',
    });
    expect(parseKeyChord('Shift+-')).toMatchObject({ key: '_', code: 'Minus', text: '_' });
    expect(parseKeyChord('Ctrl+Shift+7')).toMatchObject({ key: '&', code: 'Digit7', modifiers: 10 });
    expect(parseKeyChord('Ctrl+Shift+7').text).toBeUndefined();
  });

  it('rejects malformed chords', () => {
    expect(() => parseKeyChord('')).toThrow(/required/);
    expect(() => parseKeyChord('   ')).toThrow(/required/);
    expect(() => parseKeyChord('Ctrl+')).toThrow(/not a valid key chord/);
    expect(() => parseKeyChord('Ctrl+Alt')).toThrow(/missing the key/);
    expect(() => parseKeyChord('a+b')).toThrow(/more than one key/);
    expect(() => parseKeyChord('F13')).toThrow(/Unknown key/);
    expect(() => parseKeyChord('Hyper')).toThrow(/Unknown key/);
  });

  it('rejects non-key characters', () => {
    expect(() => parseKeyChord('é')).toThrow(/not a key this tool can press/);
  });
});
