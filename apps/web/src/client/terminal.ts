import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TerminalController = {
  clear: () => void;
  dispose: () => void;
  fit: () => { cols: number; rows: number };
  onData: (handler: (value: string) => void) => () => void;
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

  const resizeObserver = new ResizeObserver(() => {
    fit.fit();
  });

  resizeObserver.observe(container);

  return {
    clear() {
      terminal.clear();
    },
    dispose() {
      resizeObserver.disconnect();
      terminal.dispose();
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
    write(value) {
      terminal.write(value);
    },
    writeln(value) {
      terminal.writeln(value);
    },
  };
}
