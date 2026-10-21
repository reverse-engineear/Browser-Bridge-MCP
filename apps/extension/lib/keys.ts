import { AutomationError } from './errors.js';

export interface KeyStroke {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

const MODIFIER_ALIASES: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  cmd: 4,
  command: 4,
  meta: 4,
  win: 4,
  windows: 4,
  shift: 8,
};

const NAMED_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  spacebar: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

const PUNCTUATION: Record<string, { code: string; vk: number }> = {
  '-': { code: 'Minus', vk: 189 },
  '=': { code: 'Equal', vk: 187 },
  '[': { code: 'BracketLeft', vk: 219 },
  ']': { code: 'BracketRight', vk: 221 },
  '\\': { code: 'Backslash', vk: 220 },
  ';': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 },
  ',': { code: 'Comma', vk: 188 },
  '.': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 },
  '`': { code: 'Backquote', vk: 192 },
};

const SHIFTED: Record<string, string> = {
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '`': '~',
};

for (let index = 1; index <= 12; index += 1) {
  NAMED_KEYS[`f${index}`] = {
    key: `F${index}`,
    code: `F${index}`,
    vk: 111 + index,
  };
}

function parseBaseKey(raw: string, modifiers: number): KeyStroke {
  const lower = raw.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      modifiers,
      ...(named.text && !(modifiers & (1 | 2 | 4)) ? { text: named.text } : {}),
    };
  }

  if (raw.length !== 1) {
    throw new AutomationError('BAD_REQUEST', `Unknown key "${raw}". Use a key name such as Enter, Tab, Escape or a single character.`);
  }

  if (/[a-z]/i.test(raw)) {
    const upper = raw.toUpperCase();
    const key = modifiers & 8 ? upper : raw.toLowerCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers,
      ...(modifiers & (1 | 2 | 4) ? {} : { text: key }),
    };
  }

  if (/[0-9]/.test(raw)) {
    const key = modifiers & 8 ? SHIFTED[raw] ?? raw : raw;
    return {
      key,
      code: `Digit${raw}`,
      windowsVirtualKeyCode: raw.charCodeAt(0),
      modifiers,
      ...(modifiers & (1 | 2 | 4) ? {} : { text: key }),
    };
  }

  const punctuation = PUNCTUATION[raw];
  if (punctuation) {
    const key = modifiers & 8 ? SHIFTED[raw] ?? raw : raw;
    return {
      key,
      code: punctuation.code,
      windowsVirtualKeyCode: punctuation.vk,
      modifiers,
      ...(modifiers & (1 | 2 | 4) ? {} : { text: key }),
    };
  }

  throw new AutomationError(
    'BAD_REQUEST',
    `"${raw}" is not a key this tool can press. Use a letter, a digit, or a named key.`,
  );
}

export function parseKeyChord(input: string): KeyStroke {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AutomationError('BAD_REQUEST', 'A key name is required.');
  }

  if (trimmed === '+') {
    return { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 8, text: '+' };
  }

  const parts = trimmed.split('+').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new AutomationError('BAD_REQUEST', `"${input}" is not a valid key chord.`);
  }

  let modifiers = 0;
  let base = '';
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier !== undefined) {
      modifiers |= modifier;
      continue;
    }
    if (base) {
      throw new AutomationError('BAD_REQUEST', `"${input}" contains more than one key.`);
    }
    base = part;
  }

  if (!base) {
    throw new AutomationError('BAD_REQUEST', `"${input}" is missing the key after the modifiers.`);
  }

  return parseBaseKey(base, modifiers);
}
