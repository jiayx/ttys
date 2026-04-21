//go:build darwin || linux

package platform

import "os"

func DefaultShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}

	return "/bin/sh"
}
