package session

import (
	"os"

	"github.com/jiayx/ttys/agent/internal/pty"
)

const nestedAgentEnv = "TTYS_AGENT_ACTIVE"

func prepareShellLaunch(shellPath string) pty.LaunchConfig {
	return pty.LaunchConfig{
		Path: shellPath,
		Env:  append(os.Environ(), nestedAgentEnv+"=1"),
	}
}
