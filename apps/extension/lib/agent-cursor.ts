const CURSOR_GLOBAL = '__browserBridgeCursor';
const CURSOR_RUNTIME_VERSION = 1;
const CURSOR_ATTRIBUTE = 'data-browser-bridge-cursor';

export type CursorKind = 'pointer' | 'text' | 'type' | 'grab' | 'drop' | 'click' | 'hover';

export interface CursorPayload {
  x?: number;
  y?: number;
  kind?: CursorKind;
  duration?: number;
}

interface PageCursorApi {
  version: number;
  connected: () => boolean;
  move: (payload?: CursorPayload) => Promise<boolean>;
  pulse: (payload?: CursorPayload) => Promise<boolean>;
  hide: () => Promise<boolean>;
  remove: () => Promise<boolean>;
}

export function cursorExpression(
  command: 'move' | 'pulse' | 'hide' | 'remove',
  payload: CursorPayload = {},
): string {
  return `(async () => {
    try {
      const key = ${JSON.stringify(CURSOR_GLOBAL)};
      const install = ${pageCursorRuntime.toString()};
      let api = globalThis[key];
      if (!api || api.version !== ${CURSOR_RUNTIME_VERSION} || !api.connected()) {
        api = install();
        Object.defineProperty(globalThis, key, { configurable: true, value: api });
      }
      return await api[${JSON.stringify(command)}](${JSON.stringify(payload)});
    } catch (error) {
      return false;
    }
  })()`;
}

// Serialized with Function.prototype.toString and evaluated in the page, so it
// must not reference anything outside its own body.
function pageCursorRuntime(): PageCursorApi {
  const VERSION = 1;
  const ACCENT = '#6366f1';
  const DEEP = '#4f46e5';
  const AUTO_HIDE_MS = 2600;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  for (const stale of Array.from(document.querySelectorAll('browser-bridge-cursor'))) {
    stale.remove();
  }

  const host = document.createElement('browser-bridge-cursor');
  host.setAttribute('data-browser-bridge-cursor', 'idle');
  host.setAttribute('aria-hidden', 'true');

  const styleElement = (element: HTMLElement, props: Record<string, string>): void => {
    for (const name of Object.keys(props)) {
      element.style.setProperty(name, props[name]);
    }
  };

  const hostStyle: Record<string, string> = {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    visibility: 'visible',
    overflow: 'visible',
    background: 'transparent',
    opacity: '1',
    transform: 'none',
    filter: 'none',
    content: 'normal',
    'pointer-events': 'none',
    'z-index': '2147483647',
  };
  for (const name of Object.keys(hostStyle)) {
    host.style.setProperty(name, hostStyle[name], 'important');
  }

  const shadow = host.attachShadow({ mode: 'closed' });

  const aura = document.createElement('div');
  styleElement(aura, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    'pointer-events': 'none',
    transform: 'translate3d(0, 0, 0)',
    'transform-origin': '0 0',
    opacity: '0',
    'will-change': 'transform, opacity',
  });

  const orb = document.createElement('div');
  styleElement(orb, {
    position: 'absolute',
    left: '-26px',
    top: '-26px',
    width: '52px',
    height: '52px',
    'border-radius': '999px',
    background: 'radial-gradient(circle at 50% 50%, rgba(99,102,241,.34) 0%, rgba(129,140,248,.18) 38%, rgba(99,102,241,0) 70%)',
    'pointer-events': 'none',
    'transform-origin': 'center',
  });
  aura.append(orb);

  const pointer = document.createElement('div');
  styleElement(pointer, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    'pointer-events': 'none',
    transform: 'translate3d(0, 0, 0)',
    'transform-origin': '0 0',
    opacity: '0',
    'will-change': 'transform, opacity',
  });

  const pointerInner = document.createElement('div');
  styleElement(pointerInner, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '22px',
    height: '26px',
    'transform-origin': '2px 2px',
    filter: 'drop-shadow(0 3px 6px rgba(15,23,42,.32)) drop-shadow(0 0 9px rgba(99,102,241,.45))',
    'pointer-events': 'none',
  });

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '26');
  svg.setAttribute('viewBox', '0 0 24 29');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute(
    'd',
    'M4.2 2.6 20.4 13c.9.6.6 2-.5 2.2l-5.8 1.1-2.8 6.8c-.4.9-1.7.8-2-.1L2.7 4.2c-.3-1.1.6-2.1 1.5-1.6Z',
  );
  body.setAttribute('fill', '#ffffff');
  body.setAttribute('stroke', DEEP);
  body.setAttribute('stroke-width', '1.7');
  body.setAttribute('stroke-linejoin', 'round');

  const sheen = document.createElementNS(SVG_NS, 'path');
  sheen.setAttribute('d', 'M6.4 6.7 16.6 12.8l-3.8.7-1.8 4.6Z');
  sheen.setAttribute('fill', '#eef2ff');

  const spark = document.createElementNS(SVG_NS, 'circle');
  spark.setAttribute('cx', '4.6');
  spark.setAttribute('cy', '5');
  spark.setAttribute('r', '1.5');
  spark.setAttribute('fill', ACCENT);

  svg.append(body, sheen, spark);
  pointerInner.append(svg);
  pointer.append(pointerInner);
  shadow.append(aura, pointer);

  let x = 0;
  let y = 0;
  let hasPoint = false;
  let visible = false;
  let appeared = false;
  let hideTimer = 0;

  let breathe: Animation | null = null;
  try {
    if (!reduced && typeof orb.animate === 'function') {
      breathe = orb.animate(
        [
          { transform: 'scale(.86)', opacity: 0.72 },
          { transform: 'scale(1.12)', opacity: 1 },
        ],
        { duration: 1700, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' },
      );
      breathe.pause();
    }
  } catch {
    breathe = null;
  }

  const mount = (): void => {
    if (host.isConnected) return;
    const root = document.documentElement || document.body;
    if (root) root.append(host);
  };

  const show = (): void => {
    mount();
    if (visible) return;
    visible = true;
    host.setAttribute('data-browser-bridge-cursor', 'active');
    pointer.style.setProperty('opacity', '1', 'important');
    aura.style.setProperty('opacity', '1', 'important');
    if (!appeared) {
      appeared = true;
      try {
        pointerInner.animate(
          [
            { transform: 'scale(.72)', opacity: 0.35 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: reduced ? 0 : 240, easing: 'cubic-bezier(.2,.9,.3,1)' },
        );
      } catch {
        // Animation is decoration only.
      }
    }
    if (breathe) {
      try {
        breathe.play();
      } catch {
        // The animation may be finished or canceled.
      }
    }
  };

  const fadeOut = (): void => {
    if (!visible) return;
    visible = false;
    host.setAttribute('data-browser-bridge-cursor', 'idle');
    pointer.style.setProperty('opacity', '0', 'important');
    aura.style.setProperty('opacity', '0', 'important');
    if (breathe) {
      try {
        breathe.pause();
      } catch {
        // The animation may already be canceled.
      }
    }
  };

  const scheduleHide = (): void => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(fadeOut, AUTO_HIDE_MS);
  };

  const position = (px: number, py: number, duration: number): void => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    const transform = `translate3d(${round(px)}px, ${round(py)}px, 0)`;
    const pointerDuration = Math.max(0, Math.round(duration));
    const auraDuration = pointerDuration > 0 ? pointerDuration + 170 : 0;
    const easing = 'cubic-bezier(.2,.9,.25,1)';
    pointer.style.setProperty(
      'transition',
      `transform ${pointerDuration}ms ${easing}, opacity 180ms ease`,
      'important',
    );
    aura.style.setProperty(
      'transition',
      `transform ${auraDuration}ms ${easing}, opacity 220ms ease`,
      'important',
    );
    pointer.style.setProperty('transform', transform, 'important');
    aura.style.setProperty('transform', transform, 'important');
  };

  const nudge = (kind: string): void => {
    if (reduced || typeof pointerInner.animate !== 'function') return;
    const scale = kind === 'grab' ? 0.82 : 0.88;
    try {
      pointerInner.animate(
        [
          { transform: 'scale(1)' },
          { transform: `scale(${scale})`, offset: 0.34 },
          { transform: 'scale(1)' },
        ],
        { duration: 280, easing: 'cubic-bezier(.3,1.5,.5,1)' },
      );
    } catch {
      // Animation is decoration only.
    }
  };

  const spawnRipple = (px: number, py: number, kind: string): void => {
    if (reduced) return;
    const strong = kind === 'click' || kind === 'drop';
    const size = strong ? 30 : 18;

    const layer = document.createElement('div');
    styleElement(layer, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      'pointer-events': 'none',
      transform: `translate3d(${px}px, ${py}px, 0)`,
    });

    const ring = document.createElement('div');
    styleElement(ring, {
      position: 'absolute',
      left: `${-size / 2}px`,
      top: `${-size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      'border-radius': '999px',
      border: '2px solid rgba(99,102,241,.68)',
      'box-shadow': '0 0 0 5px rgba(99,102,241,.10), 0 0 16px rgba(99,102,241,.38)',
      opacity: '0',
      'will-change': 'transform, opacity',
    });

    layer.append(ring);
    shadow.append(layer);

    try {
      const animation = ring.animate(
        [
          { transform: 'scale(.32)', opacity: 0.9, borderWidth: '3px' },
          { transform: `scale(${strong ? 2.4 : 1.9})`, opacity: 0, borderWidth: '1px' },
        ],
        { duration: strong ? 640 : 460, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
      animation.onfinish = () => layer.remove();
    } catch {
      layer.remove();
      return;
    }
    window.setTimeout(() => layer.remove(), 1100);
  };

  const move = async (payload: CursorPayload = {}): Promise<boolean> => {
    const px = Number(payload.x);
    const py = Number(payload.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;

    show();
    const distance = hasPoint ? Math.hypot(px - x, py - y) : 0;
    const requested = Number(payload.duration);
    const duration = reduced || !hasPoint
      ? 0
      : Math.max(220, Math.min(560, Number.isFinite(requested) && requested > 0 ? requested : 130 + distance * 0.65));

    x = px;
    y = py;
    hasPoint = true;
    position(px, py, duration);
    scheduleHide();

    if (duration > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, duration + 40));
    }
    return true;
  };

  const pulse = async (payload: CursorPayload = {}): Promise<boolean> => {
    const px = Number.isFinite(Number(payload.x)) ? Number(payload.x) : x;
    const py = Number.isFinite(Number(payload.y)) ? Number(payload.y) : y;
    const kind = String(payload.kind || 'click');

    show();
    if (!hasPoint) {
      x = px;
      y = py;
      hasPoint = true;
      position(px, py, 0);
    }
    spawnRipple(px, py, kind);
    nudge(kind);
    scheduleHide();
    return true;
  };

  const hide = async (): Promise<boolean> => {
    clearTimeout(hideTimer);
    fadeOut();
    return true;
  };

  const onViewportChange = (event?: Event): void => {
    if (event && event.target !== document && event.target !== document.documentElement && event.target !== document.body) {
      return;
    }
    if (visible) fadeOut();
  };

  const onResize = (): void => {
    if (visible) fadeOut();
  };

  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  const remove = async (): Promise<boolean> => {
    clearTimeout(hideTimer);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onResize);
    if (breathe) {
      try {
        breathe.cancel();
      } catch {
        // The animation may already be canceled.
      }
    }
    host.remove();
    return true;
  };

  return {
    version: VERSION,
    connected: () => host.isConnected,
    move,
    pulse,
    hide,
    remove,
  };
}
