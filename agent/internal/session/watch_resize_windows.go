//go:build windows

package session

import "github.com/jiayx/ttys/agent/internal/pty"

func watchResize(terminal *pty.Session, local *localTerminal, done <-chan struct{}) {
	width, height, err := getTerminalSize()
	if err == nil {
		local.SetSize(width, height)
		rows := local.ContentRows()
		_ = terminal.Resize(uint16(width), rows)
		local.RenderStatusBar()
	}

	<-done
}
