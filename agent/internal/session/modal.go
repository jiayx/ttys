package session

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/jiayx/ttys/agent/internal/protocol"
)

type modalAction string

const (
	modalApprove modalAction = "approve"
	modalReject  modalAction = "reject"
)

type modalDecision struct {
	Action       modalAction
	ViewerID     string
	LeaseSeconds int
}

type approvalModal struct {
	mu                sync.Mutex
	stdout            *os.File
	width             int
	height            int
	active            bool
	request           *protocol.ControlRequestPayload
	buffer            bytes.Buffer
	dismissedViewerID string
}

func newApprovalModal(stdout *os.File) *approvalModal {
	return &approvalModal{
		stdout: stdout,
		width:  80,
		height: 24,
	}
}

func (m *approvalModal) SetSize(width, height int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if width > 0 {
		m.width = width
	}
	if height > 0 {
		m.height = height
	}
	if m.active {
		m.renderLocked()
	}
}

func (m *approvalModal) HandlePTYOutput(chunk []byte, forward func([]byte) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.active {
		_, _ = m.buffer.Write(chunk)
		return nil
	}

	return forward(chunk)
}

func (m *approvalModal) HandleLocalInput(
	chunk []byte,
	forward func([]byte) error,
) (bool, *modalDecision, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.active {
		return false, nil, nil
	}

	for _, current := range chunk {
		switch current {
		case 'y', 'Y':
			decision := &modalDecision{
				Action:       modalApprove,
				ViewerID:     m.request.ViewerID,
				LeaseSeconds: m.request.LeaseSeconds,
			}
			if err := m.closeLocked(forward); err != nil {
				return true, nil, err
			}
			m.dismissedViewerID = decision.ViewerID
			return true, decision, nil
		case 'n', 'N', '\r', '\n', 0x03, 0x1b:
			decision := &modalDecision{
				Action:   modalReject,
				ViewerID: m.request.ViewerID,
			}
			if err := m.closeLocked(forward); err != nil {
				return true, nil, err
			}
			m.dismissedViewerID = decision.ViewerID
			return true, decision, nil
		default:
			// Keep consuming bytes until the user picks y/n.
		}
	}

	return true, nil, nil
}

func (m *approvalModal) SyncPendingRequest(
	request *protocol.ControlRequestPayload,
	forward func([]byte) error,
) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if request == nil {
		if m.active {
			return m.closeLocked(forward)
		}
		m.dismissedViewerID = ""
		m.request = nil
		return nil
	}

	if request.ViewerID == m.dismissedViewerID && !m.active {
		return nil
	}

	if m.active && sameRequest(m.request, request) {
		return nil
	}

	m.request = cloneRequest(request)
	m.active = true
	fmt.Fprint(m.stdout, "\a")
	return m.renderLocked()
}

func sameRequest(left *protocol.ControlRequestPayload, right *protocol.ControlRequestPayload) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.ViewerID == right.ViewerID && left.LeaseSeconds == right.LeaseSeconds
}

func cloneRequest(request *protocol.ControlRequestPayload) *protocol.ControlRequestPayload {
	if request == nil {
		return nil
	}

	copied := *request
	return &copied
}

func (m *approvalModal) closeLocked(forward func([]byte) error) error {
	if !m.active {
		return nil
	}

	buffered := append([]byte(nil), m.buffer.Bytes()...)
	m.buffer.Reset()
	m.active = false
	m.request = nil

	fmt.Fprint(m.stdout, "\x1b[?25h\x1b[?1049l")
	if len(buffered) == 0 {
		return nil
	}
	return forward(buffered)
}

func (m *approvalModal) renderLocked() error {
	width := max(48, min(m.width, 80))
	boxWidth := min(width-4, 72)
	if boxWidth < 36 {
		boxWidth = 36
	}
	boxHeight := 9
	startCol := max(1, (m.width-boxWidth)/2)
	startRow := max(1, (m.height-boxHeight)/2)

	viewerID := "unknown"
	leaseSeconds := 0
	if m.request != nil {
		viewerID = m.request.ViewerID
		leaseSeconds = m.request.LeaseSeconds
	}

	innerWidth := boxWidth - 2
	contentLines := []string{
		center(innerWidth, "Control Request"),
		"",
		truncate(innerWidth, fmt.Sprintf("Viewer %s wants control.", viewerID)),
		truncate(innerWidth, fmt.Sprintf("Lease: %d minutes", max(1, leaseSeconds/60))),
		"",
		truncate(innerWidth, "Press Y to approve or N to deny."),
		"",
		truncate(innerWidth, "Session output is paused until you decide."),
	}

	fmt.Fprint(m.stdout, "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H")
	fmt.Fprintf(m.stdout, "\x1b[%d;%dH┌%s┐", startRow, startCol, strings.Repeat("─", innerWidth))
	for index, line := range contentLines {
		fmt.Fprintf(m.stdout, "\x1b[%d;%dH│%-*s│", startRow+1+index, startCol, innerWidth, line)
	}
	fmt.Fprintf(m.stdout, "\x1b[%d;%dH└%s┘", startRow+1+len(contentLines), startCol, strings.Repeat("─", innerWidth))
	return nil
}

func center(width int, value string) string {
	if len(value) >= width {
		return truncate(width, value)
	}
	padding := (width - len(value)) / 2
	return strings.Repeat(" ", padding) + value
}

func truncate(width int, value string) string {
	if width <= 0 || len(value) <= width {
		return value
	}
	if width == 1 {
		return value[:1]
	}
	return value[:width-1] + "…"
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
