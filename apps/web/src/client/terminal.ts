import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TerminalController = {
  dispose: () => void;
  focus: () => void;
  fit: () => { cols: number; rows: number };
  onData: (handler: (value: string) => void) => () => void;
  reset: () => void;
  write: (value: string | Uint8Array) => void;
  writeln: (value: string) => void;
};

const terminalWriteFlushDelayMs = 1;
const terminalWriteMaxBatchBytes = 64 * 1024;
const terminalWriteMaxPendingBytes = 4 * 1024 * 1024;

export function mountTerminal(container: HTMLElement): TerminalController {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", ui-monospace, monospace',
    fontSize: 14,
    theme: {
      background: "#111111",
      foreground: "#f5f5f4",
      cursor: "#fbbf24",
      selectionBackground: "#44403c",
    },
  });
  const fit = new FitAddon();

  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();

  const writeBatcher = new TerminalWriteBatcher((value) => terminal.write(value));
  let resizeTimer = 0;
  let lastWidth = Math.round(container.clientWidth);
  let lastHeight = Math.round(container.clientHeight);

  function scheduleFit(width: number, height: number) {
    if (width === lastWidth && height === lastHeight) {
      return;
    }

    lastWidth = width;
    lastHeight = height;

    if (resizeTimer) {
      window.clearTimeout(resizeTimer);
    }

    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      fit.fit();
    }, 160);
  }

  function handleWindowResize() {
    scheduleFit(Math.round(container.clientWidth), Math.round(container.clientHeight));
  }

  window.addEventListener("resize", handleWindowResize);

  return {
    dispose() {
      window.removeEventListener("resize", handleWindowResize);
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
      }
      writeBatcher.dispose();
      terminal.dispose();
    },
    focus() {
      terminal.focus();
    },
    fit() {
      fit.fit();
      return {
        cols: terminal.cols,
        rows: terminal.rows,
      };
    },
    onData(handler) {
      const disposable = terminal.onData(handler);
      return () => {
        disposable.dispose();
      };
    },
    reset() {
      writeBatcher.flush();
      terminal.reset();
      fit.fit();
    },
    write(value) {
      writeBatcher.write(value);
    },
    writeln(value) {
      writeBatcher.flush();
      terminal.writeln(value);
    },
  };
}

class TerminalWriteBatcher {
  private pending: Array<string | Uint8Array> = [];
  private pendingBytes = 0;
  private timer: number | null = null;
  private lastWrite = 0;

  constructor(private readonly writeDirect: (value: string | Uint8Array) => void) {}

  write(value: string | Uint8Array) {
    const size = byteLength(value);
    if (size === 0) {
      return;
    }

    const now = performance.now();
    if (this.pending.length === 0 && shouldWriteImmediately(this.lastWrite, now)) {
      this.lastWrite = now;
      this.writeDirect(value);
      return;
    }

    this.pending.push(value);
    this.pendingBytes += size;
    if (this.pendingBytes > terminalWriteMaxPendingBytes) {
      this.dropPending();
      return;
    }
    if (this.pendingBytes >= terminalWriteMaxBatchBytes) {
      this.flush();
      return;
    }

    this.scheduleFlush();
  }

  flush() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) {
      return;
    }

    for (const value of coalesceWrites(this.pending, this.pendingBytes)) {
      this.writeDirect(value);
    }

    this.pending = [];
    this.pendingBytes = 0;
    this.lastWrite = performance.now();
  }

  dispose() {
    this.flush();
  }

  private dropPending() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    this.pending = [];
    this.pendingBytes = 0;
    this.lastWrite = performance.now();
  }

  private scheduleFlush() {
    if (this.timer !== null) {
      return;
    }

    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, terminalWriteFlushDelayMs);
  }
}

function shouldWriteImmediately(lastWrite: number, now: number) {
  return lastWrite === 0 || now - lastWrite >= terminalWriteFlushDelayMs;
}

function byteLength(value: string | Uint8Array) {
  return typeof value === "string" ? value.length : value.byteLength;
}

function coalesceWrites(
  values: Array<string | Uint8Array>,
  totalBytes: number,
): Array<string | Uint8Array> {
  if (values.every((value) => value instanceof Uint8Array)) {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return [bytes];
  }

  return values;
}
