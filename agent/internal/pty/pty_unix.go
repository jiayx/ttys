//go:build darwin || linux

package pty

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

type Session struct {
	cmd  *exec.Cmd
	file *os.File
}

func Start(shell string) (*Session, error) {
	cmd := exec.Command(shell)
	cmd.Env = os.Environ()
	file, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}

	return &Session{
		cmd:  cmd,
		file: file,
	}, nil
}

func (s *Session) Read(p []byte) (int, error) {
	return s.file.Read(p)
}

func (s *Session) Write(p []byte) (int, error) {
	return s.file.Write(p)
}

func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.file, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
}

func (s *Session) Wait() error {
	return s.cmd.Wait()
}

func (s *Session) Close() error {
	return s.file.Close()
}
