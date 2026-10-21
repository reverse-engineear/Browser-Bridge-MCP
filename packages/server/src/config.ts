export const SERVER_VERSION = '0.1.0';

export function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('BROWSER_BRIDGE_PORT must be a whole number between 1 and 65535.');
  }
  return port;
}
