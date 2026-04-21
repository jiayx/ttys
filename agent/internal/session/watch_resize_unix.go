//go:build darwin || linux

package session

import (
	"os"
	"os/signal"
	"syscall"

	"github.com/jiayx/ttys/agent/internal/pty"
)

func watchResize(terminal *pty.Session, local *localTerminal, done <-chan struct{}) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	defer signal.Stop(signals)

	apply := func() {
		width, height, err := getTerminalSize()
		if err != nil {
			return
		}
		local.SetSize(width, height)
		rows := local.ContentRows()
		_ = terminal.Resize(uint16(width), rows)
		local.RenderStatusBar()
	}

	apply()
	for {
		select {
		case <-done:
			return
		case <-signals:
			apply()
		}
	}
}
