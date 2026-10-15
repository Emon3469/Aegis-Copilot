export interface TypewriterOptions {
  instant?: boolean;
  minStep?: number;
  drainFrames?: number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

export interface Typewriter {
  push: (text: string) => void;
  replace: (text: string) => void;
  reset: () => void;
  flushAll: () => void;
  cancel: () => void;
  drained: () => Promise<void>;
  readonly received: string;
  readonly visible: string;
}

function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export function createTypewriter(render: (visible: string) => void, options: TypewriterOptions = {}): Typewriter {
  const { instant = false, minStep = 5, drainFrames = 30 } = options;
  const raf = options.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = options.caf ?? ((id: number) => cancelAnimationFrame(id));

  let received = "";
  let shown = 0;
  let frame = 0;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (shown < received.length) return;
    const pending = waiters;
    waiters = [];
    pending.forEach((resolve) => resolve());
  };

  const paint = () => {
    render(received.slice(0, shown));
    settle();
  };

  const tick = () => {
    frame = 0;
    const backlog = received.length - shown;
    if (backlog <= 0) return settle();
    const step = minStep + Math.ceil(backlog / drainFrames);
    shown = safeCut(received, shown + step);
    paint();
    if (shown < received.length) frame = raf(tick);
  };

  const schedule = () => {
    if (instant) {
      shown = received.length;
      paint();
      return;
    }
    if (!frame) frame = raf(tick);
  };

  return {
    push(text) {
      if (!text) return;
      received += text;
      schedule();
    },
    replace(text) {
      shown = Math.min(shown, commonPrefix(received, text));
      received = text;
      if (shown === received.length) paint();
      else schedule();
    },
    reset() {
      if (frame) caf(frame);
      frame = 0;
      received = "";
      shown = 0;
      paint();
    },
    flushAll() {
      if (frame) caf(frame);
      frame = 0;
      shown = received.length;
      paint();
    },
    cancel() {
      if (frame) caf(frame);
      frame = 0;
      const pending = waiters;
      waiters = [];
      pending.forEach((resolve) => resolve());
    },
    drained() {
      if (shown >= received.length && !frame) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    get received() {
      return received;
    },
    get visible() {
      return received.slice(0, shown);
    },
  };
}
