import { describe, expect, it } from 'vitest';
import { MAX_SNAPSHOT_NODES } from '@browser-bridge/protocol';
import { buildSnapshot, type AxNode } from '../lib/snapshot.js';

const root = (childIds: string[], name = 'Fixture'): AxNode => ({
  nodeId: '1',
  role: { value: 'RootWebArea' },
  name: { value: name },
  backendDOMNodeId: 1,
  childIds,
});

describe('buildSnapshot', () => {
  it('renders the document title and an interactive element with a ref', () => {
    const result = buildSnapshot(
      [
        root(['2']),
        { nodeId: '2', role: { value: 'button' }, name: { value: 'Say hello' }, backendDOMNodeId: 10 },
      ],
      { title: 'Fallback title', snapshotId: 1 },
    );

    expect(result.text).toBe('- document "Fixture"\n  - button "Say hello" [ref=s1e10]');
    expect(result.text).not.toContain('ref=s1e1]');
    expect(result.nodes).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.snapshotId).toBe(1);
  });

  it('falls back to the page title when the document has no name', () => {
    const result = buildSnapshot([root(['2'], '')], { title: 'Second page', snapshotId: 2 });
    expect(result.text).toBe('- document "Second page"');
  });

  it('annotates headings and skips their duplicate static text', () => {
    const result = buildSnapshot(
      [
        root(['2']),
        {
          nodeId: '2',
          role: { value: 'heading' },
          name: { value: 'Register' },
          properties: [{ name: 'level', value: { type: 'integer', value: 2 } }],
          childIds: ['3'],
        },
        { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'Register' } },
      ],
      { title: 'Fixture', snapshotId: 3 },
    );

    expect(result.text).toBe('- document "Fixture"\n  - heading "Register" level=2');
  });

  it('flattens generic containers and promotes their children', () => {
    const result = buildSnapshot(
      [
        root(['2']),
        { nodeId: '2', role: { value: 'generic' }, childIds: ['3'] },
        { nodeId: '3', role: { value: 'link' }, name: { value: 'Next' }, backendDOMNodeId: 33 },
      ],
      { title: 'Fixture', snapshotId: 4 },
    );

    expect(result.text).toBe('- document "Fixture"\n  - link "Next" [ref=s4e33]');
  });

  it('lifts the children of ignored nodes', () => {
    const result = buildSnapshot(
      [
        root(['2']),
        { nodeId: '2', ignored: true, childIds: ['3'] },
        { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 4 },
      ],
      { title: 'Fixture', snapshotId: 5 },
    );

    expect(result.text).toBe('- document "Fixture"\n  - textbox "Name" [ref=s5e4]');
  });

  it('shows values but hides secrets', () => {
    const result = buildSnapshot(
      [
        root(['2', '3', '4']),
        {
          nodeId: '2',
          role: { value: 'textbox' },
          name: { value: 'Name' },
          value: { value: 'Ada' },
          backendDOMNodeId: 20,
        },
        {
          nodeId: '3',
          role: { value: 'textbox' },
          name: { value: 'Password' },
          value: { value: 'hunter2' },
          backendDOMNodeId: 21,
        },
        {
          nodeId: '4',
          role: { value: 'textbox' },
          name: { value: 'Code' },
          value: { value: '123456' },
          properties: [{ name: 'autocomplete', value: { value: 'one-time-code' } }],
          backendDOMNodeId: 22,
        },
      ],
      { title: 'Fixture', snapshotId: 6 },
    );

    expect(result.text).toContain('textbox "Name" value="Ada" [ref=s6e20]');
    expect(result.text).toContain('textbox "Password" [value hidden] [ref=s6e21]');
    expect(result.text).toContain('textbox "Code" [value hidden] [ref=s6e22]');
    expect(result.text).not.toContain('hunter2');
  });

  it('marks interactive state', () => {
    const result = buildSnapshot(
      [
        root(['2', '3', '4']),
        {
          nodeId: '2',
          role: { value: 'checkbox' },
          name: { value: 'Remember me' },
          properties: [{ name: 'checked', value: { type: 'tristate', value: true } }],
          backendDOMNodeId: 1,
        },
        {
          nodeId: '3',
          role: { value: 'button' },
          name: { value: 'Save' },
          properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }],
          backendDOMNodeId: 2,
        },
        {
          nodeId: '4',
          role: { value: 'combobox' },
          name: { value: 'Colour' },
          value: { value: 'Green' },
          backendDOMNodeId: 3,
        },
      ],
      { title: 'Fixture', snapshotId: 7 },
    );

    expect(result.text).toContain('checkbox "Remember me" checked [ref=s7e1]');
    expect(result.text).toContain('button "Save" disabled [ref=s7e2]');
    expect(result.text).toContain('combobox "Colour" value="Green" [ref=s7e3]');
  });

  it('gives refs to named non-interactive nodes so they can be dragged or clicked', () => {
    const result = buildSnapshot(
      [
        root(['2']),
        { nodeId: '2', role: { value: 'generic' }, childIds: ['3'] },
        {
          nodeId: '3',
          role: { value: 'StaticText' },
          name: { value: 'Drag this card' },
          backendDOMNodeId: 55,
        },
      ],
      { title: 'Fixture', snapshotId: 11 },
    );

    expect(result.text).toBe('- document "Fixture"\n  - StaticText "Drag this card" [ref=s11e55]');
  });

  it('marks interactive nodes without a DOM id as having no ref', () => {
    const result = buildSnapshot(
      [root(['2']), { nodeId: '2', role: { value: 'button' }, name: { value: 'Ghost' } }],
      { title: 'Fixture', snapshotId: 8 },
    );
    expect(result.text).toContain('button "Ghost" [no ref]');
  });

  it('caps the number of lines and says so', () => {
    const children = Array.from({ length: MAX_SNAPSHOT_NODES + 20 }, (_, index) => `n${index}`);
    const nodes: AxNode[] = [root(children)];
    for (const [index, nodeId] of children.entries()) {
      nodes.push({
        nodeId,
        role: { value: 'button' },
        name: { value: `B${index}` },
        backendDOMNodeId: index + 100,
      });
    }

    const result = buildSnapshot(nodes, { title: 'Fixture', snapshotId: 9 });
    expect(result.truncated).toBe(true);
    expect(result.nodes).toBe(MAX_SNAPSHOT_NODES + 1);
    expect(result.text.endsWith('Snapshot cut at 4,000 nodes. Narrow the page and take another.')).toBe(true);
  });

  it('caps the byte size and says so', () => {
    const longName = 'x'.repeat(300);
    const children = Array.from({ length: 1_000 }, (_, index) => `n${index}`);
    const nodes: AxNode[] = [root(children)];
    for (const [index, nodeId] of children.entries()) {
      nodes.push({
        nodeId,
        role: { value: 'button' },
        name: { value: `${index}-${longName}` },
        backendDOMNodeId: index + 1,
      });
    }

    const result = buildSnapshot(nodes, { title: 'Fixture', snapshotId: 10 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('Snapshot cut at the size limit');
    expect(result.text.length).toBeLessThan(256 * 1024 + 4_000);
  });
});
