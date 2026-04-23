import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TerminalController = {
  dispose: () => void;
  focus: () => void;
  fit: () => { cols: number; rows: number };
  onData: (handler: (value: string) => void) => () => void;
  reset: () => void;
  write: (value: string) => void;
  writeln: (value: string) => void;
};

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
      terminal.reset();
      fit.fit();
    },
    write(value) {
      terminal.write(value);
    },
    writeln(value) {
      terminal.writeln(value);
    },
  };
}
