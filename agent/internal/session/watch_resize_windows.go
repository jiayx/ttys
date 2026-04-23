//go:build windows

package session

import "github.com/jiayx/ttys/agent/internal/pty"

func watchResize(terminal *pty.Session, modal *approvalModal, done <-chan struct{}) {
	width, height, err := getTerminalSize()
	if err == nil {
		modal.SetSize(width, height)
		_ = terminal.Resize(uint16(width), uint16(height))
	}

	<-done
}
