package session

import (
	"os"

	"github.com/jiayx/ttys/agent/internal/pty"
)

func prepareShellLaunch(shellPath string) pty.LaunchConfig {
	return pty.LaunchConfig{
		Path: shellPath,
		Env:  os.Environ(),
	}
}
