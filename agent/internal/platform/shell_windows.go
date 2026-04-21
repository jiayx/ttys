//go:build windows

package platform

import "os"

func DefaultShell() string {
	candidates := []string{
		`C:\Program Files\PowerShell\7\pwsh.exe`,
		`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		`C:\Windows\System32\cmd.exe`,
	}

	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	return "cmd.exe"
}
