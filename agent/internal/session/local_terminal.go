package session

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/jiayx/ttys/agent/internal/protocol"
	"github.com/jiayx/ttys/agent/internal/transport"
)

const (
	localPrefixKey = 0x07
	ansiReset      = "\x1b[0m"
	ansiDim        = "\x1b[2m"
	ansiBold       = "\x1b[1m"
	ansiFgSlate    = "\x1b[38;5;245m"
	ansiFgCyan     = "\x1b[38;5;45m"
	ansiFgGreen    = "\x1b[38;5;42m"
	ansiFgYellow   = "\x1b[38;5;220m"
	ansiFgRed      = "\x1b[38;5;203m"
	ansiFgOrange   = "\x1b[38;5;214m"
	ansiFgWhite    = "\x1b[38;5;255m"
	ansiBgPanel    = "\x1b[48;5;236m"
	ansiBgBlue     = "\x1b[48;5;24m"
	ansiBgGreen    = "\x1b[48;5;22m"
	ansiBgYellow   = "\x1b[48;5;94m"
	ansiBgRed      = "\x1b[48;5;52m"
)

type localTerminal struct {
	mu            sync.Mutex
	stdout        *os.File
	state         *term.State
	width         int
	height        int
	hostAltScreen bool
	altScreen     bool
	viewportOK    bool
	prefixMode    bool
	note          string
	noteUntil     time.Time
	status        protocol.SessionStatusPayload
	pendingEscape []byte
}

var errStopSharing = fmt.Errorf("stop sharing requested")

func newLocalTerminal() (*localTerminal, error) {
	fd := int(os.Stdin.Fd())
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, err
	}

	width, height, err := term.GetSize(fd)
	if err != nil {
		_ = term.Restore(fd, state)
		return nil, err
	}

	return &localTerminal{
		stdout: os.Stdout,
		state:  state,
		width:  width,
		height: height,
	}, nil
}

func (t *localTerminal) Enter() {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.hostAltScreen = true
	fmt.Fprint(t.stdout, "\x1b[?1049h")
	t.resetPrivateModesLocked()
	t.viewportOK = false
}

func (t *localTerminal) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.clearStatusBarLocked()
	t.resetViewportLocked()
	t.resetPrivateModesLocked()
	t.pendingEscape = nil
	if t.hostAltScreen {
		fmt.Fprint(t.stdout, "\x1b[?1049l")
		t.hostAltScreen = false
	}
	return term.Restore(int(os.Stdin.Fd()), t.state)
}

func (t *localTerminal) ContentRows() uint16 {
	t.mu.Lock()
	defer t.mu.Unlock()

	rows := t.height - 1
	if rows < 1 {
		rows = 1
	}
	return uint16(rows)
}

func (t *localTerminal) SetSize(width, height int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.width = width
	t.height = height
	t.viewportOK = false
}

func (t *localTerminal) UpdateStatus(status protocol.SessionStatusPayload) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.status = status
}

func (t *localTerminal) SetPrefixMode(prefix bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.prefixMode = prefix
}

func (t *localTerminal) SetNote(message string, duration time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.note = message
	t.noteUntil = time.Now().Add(duration)
}

func (t *localTerminal) RenderStatusBar() {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.noteUntil.IsZero() && time.Now().After(t.noteUntil) {
		t.note = ""
		t.noteUntil = time.Time{}
	}

	t.ensureViewportLocked()
	fmt.Fprint(t.stdout, "\x1b[s")
	fmt.Fprintf(t.stdout, "\x1b[%d;1H", max(t.height, 1))
	fmt.Fprint(t.stdout, "\x1b[2K")
	fmt.Fprint(t.stdout, ansiBgPanel)
	fmt.Fprint(t.stdout, truncateStatusLine(t.renderLineLocked(), t.width))
	fmt.Fprint(t.stdout, ansiReset)
	fmt.Fprint(t.stdout, "\x1b[u")
}

func (t *localTerminal) WritePTYOutput(data []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.noteUntil.IsZero() && time.Now().After(t.noteUntil) {
		t.note = ""
		t.noteUntil = time.Time{}
	}

	t.trackTerminalModeLocked(data)
	filtered := t.filterLocalOutputLocked(data)
	if len(filtered) > 0 {
		if _, err := t.stdout.Write(filtered); err != nil {
			return err
		}
	}

	if len(filtered) == 0 {
		return nil
	}

	t.ensureViewportLocked()
	fmt.Fprint(t.stdout, "\x1b[s")
	fmt.Fprintf(t.stdout, "\x1b[%d;1H", max(t.height, 1))
	fmt.Fprint(t.stdout, "\x1b[2K")
	fmt.Fprint(t.stdout, ansiBgPanel)
	fmt.Fprint(t.stdout, truncateStatusLine(t.renderLineLocked(), t.width))
	fmt.Fprint(t.stdout, ansiReset)
	fmt.Fprint(t.stdout, "\x1b[u")
	return nil
}

func (t *localTerminal) filterLocalOutputLocked(data []byte) []byte {
	if len(t.pendingEscape) > 0 {
		combined := make([]byte, 0, len(t.pendingEscape)+len(data))
		combined = append(combined, t.pendingEscape...)
		combined = append(combined, data...)
		data = combined
		t.pendingEscape = nil
	}

	filtered := make([]byte, 0, len(data))
	for index := 0; index < len(data); {
		if data[index] != 0x1b {
			filtered = append(filtered, data[index])
			index++
			continue
		}

		next, end, complete := parseEscapeSequence(data, index)
		if !complete {
			t.pendingEscape = append(t.pendingEscape[:0], data[index:]...)
			break
		}

		if next == '[' && suppressLocalCSISequence(data[index+2:end], data[end]) {
			index = end + 1
			continue
		}

		filtered = append(filtered, data[index:end+1]...)
		index = end + 1
	}

	return filtered
}

func parseEscapeSequence(data []byte, start int) (byte, int, bool) {
	if start+1 >= len(data) {
		return 0, 0, false
	}

	next := data[start+1]
	switch next {
	case '[':
		end := findCSIEnd(data, start+2)
		return next, end, end >= 0
	case ']':
		end := findOSCEnd(data, start+2)
		return next, end, end >= 0
	case 'P', 'X', '^', '_':
		end := findStringTerminatorEnd(data, start+2)
		return next, end, end >= 0
	case '(', ')', '*', '+', '-', '.', '/':
		if start+2 >= len(data) {
			return 0, 0, false
		}
		return next, start + 2, true
	default:
		return next, start + 1, true
	}
}

func findCSIEnd(data []byte, start int) int {
	for index := start; index < len(data); index++ {
		current := data[index]
		if current >= 0x40 && current <= 0x7e {
			return index
		}
	}

	return -1
}

func findOSCEnd(data []byte, start int) int {
	for index := start; index < len(data); index++ {
		if data[index] == 0x07 {
			return index
		}
		if data[index] == 0x1b && index+1 < len(data) && data[index+1] == '\\' {
			return index + 1
		}
	}

	return -1
}

func findStringTerminatorEnd(data []byte, start int) int {
	for index := start; index < len(data); index++ {
		if data[index] == 0x1b && index+1 < len(data) && data[index+1] == '\\' {
			return index + 1
		}
	}

	return -1
}

func suppressLocalCSISequence(params []byte, final byte) bool {
	if final != 'h' {
		return false
	}

	switch string(params) {
	case "?1", "?1000", "?1002", "?1003", "?1005", "?1006", "?1007", "?1015", "?1016":
		return true
	default:
		return false
	}
}

func (t *localTerminal) clearStatusBarLocked() {
	fmt.Fprint(t.stdout, "\x1b[s")
	fmt.Fprintf(t.stdout, "\x1b[%d;1H", max(t.height, 1))
	fmt.Fprint(t.stdout, "\x1b[2K\x1b[u")
}

func (t *localTerminal) renderLineLocked() string {
	if t.prefixMode {
		return strings.Join([]string{
			badge(ansiBgBlue, ansiFgWhite, "TTYS"),
			segment(ansiFgOrange, "local actions"),
			keycap("a", "allow"),
			keycap("d", "deny"),
			keycap("r", "revoke"),
			keycap("s", "status"),
			keycap("x", "stop"),
			keycap("q", "cancel"),
		}, dimSeparator())
	}

	parts := []string{badge(ansiBgBlue, ansiFgWhite, "TTYS")}
	parts = append(parts, segment(ansiFgCyan, "shared"))
	parts = append(parts, metric("viewers", fmt.Sprintf("%d", t.status.ViewerCount), ansiFgWhite))

	controller := "none"
	if t.status.ControllerViewerID != "" {
		controller = t.status.ControllerViewerID
	}
	controlColor := ansiFgSlate
	if controller != "none" {
		controlColor = ansiFgGreen
	}
	parts = append(parts, metric("control", controller, controlColor))

	if t.status.PendingControlRequest != nil {
		parts = append(parts, metric("request", t.status.PendingControlRequest.ViewerID, ansiFgYellow))
	}

	if t.altScreen {
		parts = append(parts, badge(ansiBgGreen, ansiFgWhite, "TUI"))
	}

	if t.note != "" {
		parts = append(parts, noteSegment(t.note, noteColor(t.note)))
	} else {
		parts = append(parts, segment(ansiFgSlate, "Ctrl-G"))
	}

	return strings.Join(parts, dimSeparator())
}

func startStatusTicker(local *localTerminal, done <-chan struct{}) {
	timer := time.NewTimer(1200 * time.Millisecond)
	defer timer.Stop()

	select {
	case <-done:
		return
	case <-timer.C:
	}

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			local.RenderStatusBar()
		}
	}
}

func handleLocalAction(
	action byte,
	client *transport.Client,
	statusStore *sessionStatusStore,
	local *localTerminal,
) error {
	status := statusStore.Get()

	switch action {
	case 'a', 'A':
		if status.PendingControlRequest == nil {
			local.SetNote("no pending control request", 3*time.Second)
			return nil
		}
		if err := client.WriteJSON(map[string]any{
			"type": protocol.TypeControlApprove,
			"payload": protocol.ControlApprovePayload{
				ViewerID:     status.PendingControlRequest.ViewerID,
				LeaseSeconds: status.PendingControlRequest.LeaseSeconds,
			},
		}); err != nil {
			return err
		}
		local.SetNote("control approved", 3*time.Second)
		return nil
	case 'd', 'D':
		if status.PendingControlRequest == nil {
			local.SetNote("no pending control request", 3*time.Second)
			return nil
		}
		if err := client.WriteJSON(map[string]any{
			"type": protocol.TypeControlReject,
			"payload": protocol.ControlRejectPayload{
				ViewerID: status.PendingControlRequest.ViewerID,
			},
		}); err != nil {
			return err
		}
		local.SetNote("control denied", 3*time.Second)
		return nil
	case 'r', 'R':
		if err := client.WriteJSON(map[string]any{
			"type":    protocol.TypeControlRevoke,
			"payload": protocol.ControlRevokePayload{},
		}); err != nil {
			return err
		}
		local.SetNote("control revoked", 3*time.Second)
		return nil
	case 's', 'S':
		local.SetNote(localStatusSummary(status), 5*time.Second)
		return nil
	case 'q', 'Q', 0x1b:
		local.SetNote("local actions canceled", 2*time.Second)
		return nil
	case 'x', 'X':
		local.SetNote("stopping shared session", time.Second)
		return errStopSharing
	default:
		local.SetNote("unknown local action", 2*time.Second)
		return nil
	}
}

func truncateStatusLine(line string, width int) string {
	if width <= 0 {
		return line
	}
	plain := stripANSI(line)
	if len([]rune(plain)) <= width {
		return line
	}

	var builder strings.Builder
	visible := 0
	inEscape := false

	for _, r := range line {
		if r == '\x1b' {
			inEscape = true
			builder.WriteRune(r)
			continue
		}
		if inEscape {
			builder.WriteRune(r)
			if r == 'm' {
				inEscape = false
			}
			continue
		}
		if visible >= width-1 {
			break
		}
		builder.WriteRune(r)
		visible++
	}

	builder.WriteRune('…')
	builder.WriteString(ansiReset)
	return builder.String()
}

func (t *localTerminal) ensureViewportLocked() {
	if t.viewportOK {
		return
	}

	contentRows := max(t.height-1, 1)
	fmt.Fprintf(t.stdout, "\x1b[1;%dr", contentRows)
	t.viewportOK = true
}

func (t *localTerminal) resetViewportLocked() {
	fmt.Fprint(t.stdout, "\x1b[r")
	t.viewportOK = false
}

func (t *localTerminal) resetPrivateModesLocked() {
	// Disable alternate scroll, mouse reporting, and application cursor mode so
	// the local terminal keeps normal wheel scrolling and prompt behavior.
	fmt.Fprint(t.stdout, "\x1b[?1l")
	fmt.Fprint(t.stdout, "\x1b[?1000l")
	fmt.Fprint(t.stdout, "\x1b[?1002l")
	fmt.Fprint(t.stdout, "\x1b[?1003l")
	fmt.Fprint(t.stdout, "\x1b[?1005l")
	fmt.Fprint(t.stdout, "\x1b[?1006l")
	fmt.Fprint(t.stdout, "\x1b[?1007l")
	fmt.Fprint(t.stdout, "\x1b[?1015l")
	fmt.Fprint(t.stdout, "\x1b[?1016l")
}

func (t *localTerminal) trackTerminalModeLocked(data []byte) {
	if strings.Contains(string(data), "\x1b[?1049h") || strings.Contains(string(data), "\x1b[?47h") {
		t.altScreen = true
		return
	}

	if strings.Contains(string(data), "\x1b[?1049l") || strings.Contains(string(data), "\x1b[?47l") {
		t.altScreen = false
	}
}

func remainingFromMillis(deadline int64) string {
	if deadline == 0 {
		return "none"
	}
	remaining := time.Until(time.UnixMilli(deadline)).Round(time.Second)
	if remaining < 0 {
		return "expired"
	}
	if remaining >= time.Minute {
		return remaining.Truncate(time.Minute).String()
	}
	return remaining.String()
}

func localStatusSummary(status protocol.SessionStatusPayload) string {
	controller := status.ControllerViewerID
	if controller == "" {
		controller = "none"
	}
	return fmt.Sprintf(
		"state=%s viewers=%d control=%s pending=%t",
		emptyFallback(status.State, "unknown"),
		status.ViewerCount,
		controller,
		status.HasPendingControlRequest,
	)
}

func badge(bg string, fg string, text string) string {
	return bg + fg + ansiBold + " " + text + " " + ansiReset + ansiBgPanel
}

func segment(color string, text string) string {
	return color + text + ansiReset + ansiBgPanel
}

func metric(label string, value string, valueColor string) string {
	return ansiFgSlate + label + ":" + ansiReset + ansiBgPanel + valueColor + value + ansiReset + ansiBgPanel
}

func keycap(key string, action string) string {
	return ansiFgYellow + "[" + key + "]" + ansiReset + ansiBgPanel + ansiFgWhite + action + ansiReset + ansiBgPanel
}

func noteSegment(text string, color string) string {
	return color + ansiBold + text + ansiReset + ansiBgPanel
}

func noteColor(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "denied"), strings.Contains(lower, "stop"), strings.Contains(lower, "revoked"):
		return ansiFgRed
	case strings.Contains(lower, "request"), strings.Contains(lower, "status"):
		return ansiFgYellow
	case strings.Contains(lower, "approved"), strings.Contains(lower, "ready"), strings.Contains(lower, "active"):
		return ansiFgGreen
	default:
		return ansiFgCyan
	}
}

func dimSeparator() string {
	return ansiFgSlate + " | " + ansiReset + ansiBgPanel
}

func stripANSI(s string) string {
	var b strings.Builder
	inEscape := false
	for _, r := range s {
		if r == '\x1b' {
			inEscape = true
			continue
		}
		if inEscape {
			if r == 'm' {
				inEscape = false
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
