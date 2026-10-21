import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Browser Bridge',
    description: 'Let any local MCP client read and operate one browser tab through a shared bridge.',
    minimum_chrome_version: '116',
    permissions: ['debugger', 'storage', 'tabs', 'alarms'],
    action: {
      default_title: 'Browser Bridge',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
