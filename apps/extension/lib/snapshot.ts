import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_NODES,
  makeRef,
} from '@browser-bridge/protocol';

export interface AxProperty {
  name: string;
  value?: { type?: string; value?: unknown };
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { type?: string; value?: string };
  name?: { type?: string; value?: string };
  description?: { type?: string; value?: string };
  value?: { type?: string; value?: unknown };
  properties?: AxProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface SnapshotResult {
  text: string;
  nodes: number;
  truncated: boolean;
  snapshotId: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

const FLATTEN_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'InlineTextBox',
  'LineBreak',
  'paragraph',
  'genericContainer',
]);

const STRUCTURAL_ROLES = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'form',
  'search',
  'region',
  'article',
  'list',
  'listitem',
  'table',
  'rowgroup',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'tabpanel',
  'group',
  'toolbar',
  'menu',
  'menubar',
  'tree',
  'treegrid',
  'grid',
]);

const SECRET_NAME = /pass(word|code|phrase)?|passcode|one[- ]?time|otp\b|security code|\bpin\b|cvv|cvc|social security/i;

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function clean(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit - 1))}…`;
}

function quote(value: string, limit = 300): string {
  return `"${clean(value, limit).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 'mixed';
}

function isSecret(node: AxNode, role: string, name: string): boolean {
  if (role !== 'textbox' && role !== 'searchbox') return false;
  if (truthy(property(node, 'protected'))) return true;
  const autocomplete = textOf(property(node, 'autocomplete'));
  if (/current-password|new-password|one-time-code/i.test(autocomplete)) return true;
  return SECRET_NAME.test(name);
}

function describeStates(node: AxNode): string[] {
  const states: string[] = [];
  const disabled = property(node, 'disabled');
  if (disabled === true || disabled === 'true') states.push('disabled');
  if (truthy(property(node, 'required'))) states.push('required');
  if (truthy(property(node, 'readonly'))) states.push('readonly');

  const checked = property(node, 'checked');
  if (checked === true || checked === 'true') states.push('checked');
  if (checked === 'mixed') states.push('checked=mixed');

  const selected = property(node, 'selected');
  if (selected === true || selected === 'true') states.push('selected');

  const expanded = property(node, 'expanded');
  if (expanded === true || expanded === 'true') states.push('expanded');
  if (expanded === false || expanded === 'false') states.push('collapsed');

  const pressed = property(node, 'pressed');
  if (pressed === true || pressed === 'true') states.push('pressed');
  if (pressed === 'mixed') states.push('pressed=mixed');

  return states;
}

function formatLine(
  node: AxNode,
  role: string,
  name: string,
  titleFallback: string,
  snapshotId: number,
): string | null {
  const displayRole = role === 'RootWebArea' || role === 'WebArea' ? 'document' : role;
  const displayName = displayRole === 'document' && !name ? titleFallback : name;
  const interactive = INTERACTIVE_ROLES.has(displayRole);

  if (!interactive && !displayName) return null;
  if (displayRole === 'document' && !displayName) return null;

  const parts = [displayRole, quote(displayName)];

  if (interactive) {
    const states = describeStates(node);
    if (states.length) parts.push(states.join(', '));
  } else {
    const level = property(node, 'level');
    if (displayRole === 'heading' && typeof level === 'number') parts.push(`level=${level}`);
  }

  const canCarryValue = ['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'option'].includes(displayRole);
  if (canCarryValue) {
    if (isSecret(node, displayRole, displayName)) {
      parts.push('[value hidden]');
    } else {
      const value = clean(textOf(node.value?.value), 200);
      if (value) parts.push(`value=${quote(value, 200)}`);
    }
  }

  if (interactive || (displayName && displayRole !== 'document')) {
    if (typeof node.backendDOMNodeId === 'number') {
      parts.push(`[ref=${makeRef(snapshotId, node.backendDOMNodeId)}]`);
    } else if (interactive) {
      parts.push('[no ref]');
    }
  }

  return `- ${parts.join(' ')}`;
}

interface BuildOptions {
  title: string;
  snapshotId: number;
}

export function buildSnapshot(nodes: AxNode[], options: BuildOptions): SnapshotResult {
  const byId = new Map<string, AxNode>();
  const childIds = new Set<string>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
    for (const childId of node.childIds ?? []) childIds.add(childId);
  }

  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  const lines: string[] = [];
  let truncated = false;
  let bytes = 0;

  const pushLine = (line: string): boolean => {
    if (lines.length >= MAX_SNAPSHOT_NODES) {
      truncated = true;
      return false;
    }
    const nextBytes = bytes + line.length + 1;
    if (nextBytes > MAX_SNAPSHOT_BYTES - 256) {
      truncated = true;
      return false;
    }
    lines.push(line);
    bytes = nextBytes;
    return true;
  };

  const visit = (node: AxNode, depth: number, parent: AxNode | null): void => {
    if (truncated) return;

    if (node.ignored) {
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, depth, parent);
      }
      return;
    }

    const role = node.role?.value ?? 'generic';
    const rawName = clean(node.name?.value ?? '', 300);
    const parentName = clean(parent?.name?.value ?? '', 300);
    const parentRole = parent?.role?.value ?? '';

    if (role === 'StaticText' && (parentName === rawName || parentRole === 'heading')) {
      return;
    }

    const flatten =
      FLATTEN_ROLES.has(role) ||
      (STRUCTURAL_ROLES.has(role) && !rawName);

    let childDepth = depth;
    if (!flatten) {
      const formatted = formatLine(node, role, rawName, options.title, options.snapshotId);
      if (formatted) {
        const indented = `${'  '.repeat(Math.min(depth, 40))}${formatted}`;
        if (!pushLine(indented)) return;
        childDepth = depth + 1;
      }
    }

    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth, node);
    }
  };

  for (const root of roots) {
    visit(root, 0, null);
    if (truncated) break;
  }

  if (truncated) {
    lines.push(
      lines.length >= MAX_SNAPSHOT_NODES
        ? 'Snapshot cut at 4,000 nodes. Narrow the page and take another.'
        : 'Snapshot cut at the size limit. Narrow the page and take another.',
    );
  }

  return {
    text: lines.join('\n'),
    nodes: lines.length,
    truncated,
    snapshotId: options.snapshotId,
  };
}
