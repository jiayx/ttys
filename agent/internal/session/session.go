package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/jiayx/ttys/agent/internal/platform"
	"github.com/jiayx/ttys/agent/internal/protocol"
	"github.com/jiayx/ttys/agent/internal/pty"
	"github.com/jiayx/ttys/agent/internal/transport"
)

var errSocketDisconnected = errors.New("websocket is not connected")

const (
	remoteOutputFlushDelay = time.Millisecond
	remoteOutputMaxBatch   = 16 * 1024
)

type socketSlot struct {
	mu     sync.Mutex
	client *transport.Client
}

func (s *socketSlot) set(client *transport.Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.client = client
}

func (s *socketSlot) clear(client *transport.Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client == client {
		s.client = nil
	}
}

func (s *socketSlot) closeCurrent() {
	s.mu.Lock()
	client := s.client
	s.client = nil
	s.mu.Unlock()

	if client != nil {
		_ = client.Close()
	}
}

func (s *socketSlot) current() (*transport.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client == nil {
		return nil, errSocketDisconnected
	}
	return s.client, nil
}

func (s *socketSlot) writeBinary(data []byte) error {
	client, err := s.current()
	if err != nil {
		return err
	}
	return client.WriteBinary(data)
}

func (s *socketSlot) writeBinaryFrom(messageType byte, payload []byte) error {
	client, err := s.current()
	if err != nil {
		return err
	}
	return client.WriteBinaryFrom(messageType, payload)
}

func (s *socketSlot) writeJSON(v any) error {
	client, err := s.current()
	if err != nil {
		return err
	}
	return client.WriteJSON(v)
}

type remoteOutputBatcher struct {
	mu       sync.Mutex
	socket   *socketSlot
	pending  []byte
	lastSend time.Time
}

func newRemoteOutputBatcher(socket *socketSlot) *remoteOutputBatcher {
	return &remoteOutputBatcher{
		socket:  socket,
		pending: make([]byte, 0, remoteOutputMaxBatch),
	}
}

func (b *remoteOutputBatcher) start(done <-chan struct{}) {
	ticker := time.NewTicker(remoteOutputFlushDelay)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				b.flush(false)
			case <-done:
				b.flush(true)
				return
			}
		}
	}()
}

func (b *remoteOutputBatcher) write(data []byte) {
	if len(data) == 0 {
		return
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	if len(b.pending) == 0 && shouldSendRemoteOutputImmediately(b.lastSend, now) {
		b.lastSend = now
		_ = b.socket.writeBinaryFrom(protocol.BinaryTTYOutput, data)
		return
	}

	if len(data) > cap(b.pending)-len(b.pending) {
		b.flushLocked(now)
	}

	if len(data) > cap(b.pending) {
		b.lastSend = now
		_ = b.socket.writeBinaryFrom(protocol.BinaryTTYOutput, data)
		return
	}

	b.pending = append(b.pending, data...)
	if len(b.pending) == cap(b.pending) {
		b.flushLocked(now)
	}
}

func (b *remoteOutputBatcher) flush(force bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.pending) == 0 {
		return
	}

	now := time.Now()
	if !force && now.Sub(b.lastSend) < remoteOutputFlushDelay {
		return
	}

	b.flushLocked(now)
}

func (b *remoteOutputBatcher) flushLocked(now time.Time) {
	if len(b.pending) == 0 {
		return
	}

	_ = b.socket.writeBinaryFrom(protocol.BinaryTTYOutput, b.pending)
	b.pending = b.pending[:0]
	b.lastSend = now
}

func shouldSendRemoteOutputImmediately(lastSend time.Time, now time.Time) bool {
	return lastSend.IsZero() || now.Sub(lastSend) >= remoteOutputFlushDelay
}

type Config struct {
	ServerURL string
	SessionID string
	Shell     string
}

type connectInfo struct {
	ViewerURL        string
	HostWebSocketURL string
}

type createSessionResponse struct {
	SessionID        string `json:"sessionId"`
	ViewerURL        string `json:"viewerUrl"`
	HostWebSocketURL string `json:"hostWebSocketUrl"`
}

func Run(ctx context.Context, cfg Config) error {
	select {
	case <-ctx.Done():
		return nil
	default:
	}

	if os.Getenv(nestedAgentEnv) != "" {
		fmt.Fprintln(os.Stderr, "ttys-agent is already active in this terminal session.")
		fmt.Fprintln(os.Stderr, "Open a new local terminal, or exit the current shared shell before starting another agent.")
		return nil
	}

	shellPath := cfg.Shell
	if shellPath == "" {
		shellPath = platform.DefaultShell()
	}

	connectInfo, err := resolveConnection(ctx, cfg)
	if err != nil {
		return err
	}

	terminal, err := pty.Start(prepareShellLaunch(shellPath))
	if err != nil {
		return err
	}
	defer terminal.Close()

	modal := newApprovalModal(os.Stdout)
	socket := &socketSlot{}
	defer socket.closeCurrent()

	errCh := make(chan error, 4)
	done := make(chan struct{})
	firstSocketConnected := make(chan struct{})
	statusCh := make(chan protocol.SessionStatusPayload, 4)
	decisionCh := make(chan modalDecision, 2)
	remoteOutput := newRemoteOutputBatcher(socket)
	remoteOutput.start(done)
	defer remoteOutput.flush(true)
	var once sync.Once

	stop := func(runErr error) {
		once.Do(func() {
			errCh <- runErr
			close(done)
		})
	}

	forwardOutput := func(data []byte) error {
		if len(data) == 0 {
			return nil
		}
		if _, writeErr := os.Stdout.Write(data); writeErr != nil {
			return writeErr
		}
		remoteOutput.write(data)
		return nil
	}

	go func() {
		if runErr := manageSocket(ctx, connectInfo.HostWebSocketURL, socket, terminal, statusCh, firstSocketConnected, done); runErr != nil {
			stop(runErr)
		}
	}()

	go func() {
		if waitErr := terminal.Wait(); waitErr != nil {
			stop(waitErr)
			return
		}
		stop(io.EOF)
	}()

	select {
	case <-firstSocketConnected:
	case <-ctx.Done():
		return nil
	case runErr := <-errCh:
		printSessionEnded(!errors.Is(runErr, io.EOF))
		if errors.Is(runErr, io.EOF) {
			return nil
		}
		return runErr
	}

	printSessionStarted(connectInfo.ViewerURL)

	rawTerminal, err := enterRawTerminal()
	if err != nil {
		return err
	}
	rawClosed := false
	closeRawTerminal := func() {
		if !rawClosed {
			_ = rawTerminal.Close()
			rawClosed = true
		}
	}
	defer closeRawTerminal()

	go func() {
		if runErr := streamPTYOutput(terminal, modal, forwardOutput, done); runErr != nil {
			stop(runErr)
		}
	}()

	go func() {
		if runErr := streamLocalInput(terminal, modal, forwardOutput, decisionCh, done); runErr != nil {
			stop(runErr)
		}
	}()

	go func() {
		if runErr := handleSessionStatus(modal, statusCh, forwardOutput, done); runErr != nil {
			stop(runErr)
		}
	}()

	go func() {
		if runErr := forwardModalDecisions(socket, decisionCh, done); runErr != nil {
			stop(runErr)
		}
	}()

	go watchResize(terminal, modal, done)

	select {
	case <-ctx.Done():
		closeRawTerminal()
		printSessionEnded(false)
		return nil
	case runErr := <-errCh:
		closeRawTerminal()
		if errors.Is(runErr, io.EOF) {
			printSessionEnded(false)
			return nil
		}
		printSessionEnded(true)
		return runErr
	}
}

func printSessionStarted(viewerURL string) {
	fmt.Fprintln(os.Stderr, "ttys-agent: shared shell is active.")
	fmt.Fprintf(os.Stderr, "Share URL: %s\n", viewerURL)
	fmt.Fprintln(os.Stderr, "Exit the shared shell with Ctrl-D or 'exit'.")
	fmt.Fprintln(os.Stderr)
}

func printSessionEnded(failed bool) {
	if failed {
		fmt.Fprintln(os.Stderr, "\nttys-agent: shared shell ended with an error.")
		return
	}
	fmt.Fprintln(os.Stderr, "\nttys-agent: shared shell ended. Remote access is closed.")
}

func resolveConnection(ctx context.Context, cfg Config) (connectInfo, error) {
	baseURL, err := url.Parse(cfg.ServerURL)
	if err != nil {
		return connectInfo{}, err
	}

	switch baseURL.Scheme {
	case "ws", "wss":
		if cfg.SessionID == "" {
			return connectInfo{
				ViewerURL:        viewerURLFromWebSocket(baseURL),
				HostWebSocketURL: baseURL.String(),
			}, nil
		}
		return connectInfo{}, errors.New("session flag is not supported when server is a direct websocket URL")
	case "http", "https":
		if cfg.SessionID != "" {
			return connectInfo{
				ViewerURL:        resolveRelativeURL(baseURL, "/s/"+cfg.SessionID),
				HostWebSocketURL: websocketURL(baseURL, "/api/session/"+cfg.SessionID+"/host"),
			}, nil
		}
		return createSession(ctx, baseURL)
	default:
		return connectInfo{}, fmt.Errorf("unsupported server URL scheme %q", baseURL.Scheme)
	}
}

func createSession(ctx context.Context, baseURL *url.URL) (connectInfo, error) {
	requestURL := resolveRelativeURL(baseURL, "/api/session")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, bytes.NewReader(nil))
	if err != nil {
		return connectInfo{}, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return connectInfo{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return connectInfo{}, fmt.Errorf("create session failed: %s", strings.TrimSpace(string(body)))
	}

	var created createSessionResponse
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		return connectInfo{}, err
	}

	return connectInfo{
		ViewerURL:        resolveRelativeURL(baseURL, created.ViewerURL),
		HostWebSocketURL: websocketURL(baseURL, created.HostWebSocketURL),
	}, nil
}

func resolveRelativeURL(baseURL *url.URL, value string) string {
	resolved := *baseURL
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		return value
	}
	resolved.Path = value
	resolved.RawQuery = ""
	resolved.Fragment = ""
	return resolved.String()
}

func websocketURL(baseURL *url.URL, route string) string {
	resolved := *baseURL
	switch resolved.Scheme {
	case "https":
		resolved.Scheme = "wss"
	default:
		resolved.Scheme = "ws"
	}
	resolved.Path = route
	resolved.RawQuery = ""
	resolved.Fragment = ""
	return resolved.String()
}

func viewerURLFromWebSocket(websocketURL *url.URL) string {
	viewer := *websocketURL
	switch viewer.Scheme {
	case "wss":
		viewer.Scheme = "https"
	default:
		viewer.Scheme = "http"
	}
	parts := strings.Split(strings.Trim(viewer.Path, "/"), "/")
	if len(parts) >= 3 {
		viewer.Path = "/s/" + parts[2]
		viewer.RawQuery = ""
		viewer.Fragment = ""
	}
	return viewer.String()
}

func streamPTYOutput(
	terminal *pty.Session,
	modal *approvalModal,
	forward func([]byte) error,
	done <-chan struct{},
) error {
	buf := make([]byte, 4096)

	for {
		select {
		case <-done:
			return nil
		default:
		}

		n, err := terminal.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			if writeErr := modal.HandlePTYOutput(chunk, forward); writeErr != nil {
				return writeErr
			}
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				return io.EOF
			}
			return err
		}
	}
}

func manageSocket(
	ctx context.Context,
	hostWebSocketURL string,
	slot *socketSlot,
	terminal *pty.Session,
	statusCh chan<- protocol.SessionStatusPayload,
	firstConnected chan<- struct{},
	done <-chan struct{},
) error {
	delay := 250 * time.Millisecond
	var once sync.Once
	for {
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return nil
		default:
		}

		client, err := transport.Dial(ctx, hostWebSocketURL)
		if err != nil {
			select {
			case <-done:
				return nil
			case <-ctx.Done():
				return nil
			case <-time.After(delay):
			}
			delay = minDuration(delay*2, 5*time.Second)
			continue
		}

		delay = 250 * time.Millisecond
		slot.set(client)
		once.Do(func() {
			close(firstConnected)
		})
		readSocketFrames(terminal, client, statusCh, done)
		slot.clear(client)
		_ = client.Close()
	}
}

func readSocketFrames(
	terminal *pty.Session,
	client *transport.Client,
	statusCh chan<- protocol.SessionStatusPayload,
	done <-chan struct{},
) {
	for {
		select {
		case <-done:
			return
		default:
		}

		messageType, payload, err := client.ReadMessage()
		if err != nil {
			return
		}

		switch messageType {
		case transport.TextMessage:
			_ = handleControlFrame(payload, statusCh)
		case transport.BinaryMessage:
			if kind, data, ok := protocol.DecodeBinary(payload); ok && kind == protocol.BinaryStdin {
				_, _ = terminal.Write(data)
			}
		}
	}
}

func handleControlFrame(
	payload []byte,
	statusCh chan<- protocol.SessionStatusPayload,
) error {
	var envelope protocol.Envelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil
	}

	switch envelope.Type {
	case protocol.TypeSessionStatus:
		var status protocol.SessionStatusPayload
		if err := json.Unmarshal(envelope.Payload, &status); err != nil {
			return err
		}
		select {
		case statusCh <- status:
		default:
		}
		return nil
	default:
		return nil
	}
}

func minDuration(left, right time.Duration) time.Duration {
	if left < right {
		return left
	}
	return right
}

func streamLocalInput(
	terminal *pty.Session,
	modal *approvalModal,
	forward func([]byte) error,
	decisionCh chan<- modalDecision,
	done <-chan struct{},
) error {
	buf := make([]byte, 4096)
	for {
		select {
		case <-done:
			return nil
		default:
		}

		n, err := os.Stdin.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			handled, decision, handleErr := modal.HandleLocalInput(chunk, forward)
			if handleErr != nil {
				return handleErr
			}
			if decision != nil {
				select {
				case decisionCh <- *decision:
				case <-done:
					return nil
				}
			}
			if !handled {
				if _, writeErr := terminal.Write(chunk); writeErr != nil {
					return writeErr
				}
			}
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func handleSessionStatus(
	modal *approvalModal,
	statusCh <-chan protocol.SessionStatusPayload,
	forward func([]byte) error,
	done <-chan struct{},
) error {
	for {
		select {
		case <-done:
			return nil
		case status := <-statusCh:
			if err := modal.SyncPendingRequest(status.PendingControlRequest, forward); err != nil {
				return err
			}
		}
	}
}

func forwardModalDecisions(
	socket *socketSlot,
	decisionCh <-chan modalDecision,
	done <-chan struct{},
) error {
	for {
		select {
		case <-done:
			return nil
		case decision := <-decisionCh:
			switch decision.Action {
			case modalApprove:
				if err := socket.writeJSON(map[string]any{
					"type": protocol.TypeControlApprove,
					"payload": protocol.ControlApprovePayload{
						ViewerID:     decision.ViewerID,
						LeaseSeconds: decision.LeaseSeconds,
					},
				}); err != nil && !errors.Is(err, errSocketDisconnected) {
					return err
				}
			case modalReject:
				if err := socket.writeJSON(map[string]any{
					"type": protocol.TypeControlReject,
					"payload": protocol.ControlRejectPayload{
						ViewerID: decision.ViewerID,
					},
				}); err != nil && !errors.Is(err, errSocketDisconnected) {
					return err
				}
			}
		}
	}
}

type rawTerminal struct {
	state *term.State
}

func enterRawTerminal() (*rawTerminal, error) {
	state, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return nil, err
	}
	return &rawTerminal{state: state}, nil
}

func (r *rawTerminal) Close() error {
	return term.Restore(int(os.Stdin.Fd()), r.state)
}
