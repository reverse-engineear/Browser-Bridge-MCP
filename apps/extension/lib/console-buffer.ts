import { MAX_CONSOLE_ENTRIES, type ConsoleEntry } from '@browser-bridge/protocol';

export class ConsoleBuffer {
  private items: ConsoleEntry[] = [];
  private received = 0;

  add(entry: ConsoleEntry): void {
    this.received += 1;
    this.items.push({ ...entry });
    if (this.items.length > MAX_CONSOLE_ENTRIES) {
      this.items.splice(0, this.items.length - MAX_CONSOLE_ENTRIES);
    }
  }

  get dropped(): number {
    return Math.max(0, this.received - this.items.length);
  }

  get size(): number {
    return this.items.length;
  }

  snapshot(): { entries: ConsoleEntry[]; total: number; dropped: number } {
    return {
      entries: this.items.map((entry) => ({ ...entry })),
      total: this.received,
      dropped: this.dropped,
    };
  }

  clear(): void {
    this.items = [];
    this.received = 0;
  }
}
