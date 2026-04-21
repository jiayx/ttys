package session

import "golang.org/x/term"

func getTerminalSize() (int, int, error) {
	return term.GetSize(int(0))
}
