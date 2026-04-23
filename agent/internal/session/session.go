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

	"golang.org/x/term"

	"github.com/jiayx/ttys/agent/internal/platform"
	"github.com/jiayx/ttys/agent/internal/protocol"
	"github.com/jiayx/ttys/agent/internal/pty"
	"github.com/jiayx/ttys/agent/internal/transport"
)

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

	fmt.Fprintf(os.Stdout, "Share URL: %s\n", connectInfo.ViewerURL)
	fmt.Fprintln(os.Stdout, "Exit this shared shell with Ctrl-D or 'exit'.")

	rawTerminal, err := enterRawTerminal()
	if err != nil {
		return err
	}
	defer rawTerminal.Close()

	client, err := transport.Dial(ctx, connectInfo.HostWebSocketURL)
	if err != nil {
		return err
	}
	defer client.Close()

	modal := newApprovalModal(os.Stdout)

	errCh := make(chan error, 4)
	done := make(chan struct{})
	statusCh := make(chan protocol.SessionStatusPayload, 4)
	decisionCh := make(chan modalDecision, 2)
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
		return client.WriteText(data)
	}

	go func() {
		if runErr := streamPTYOutput(terminal, modal, forwardOutput, done); runErr != nil {
			stop(runErr)
		}
	}()

	go func() {
		if runErr := streamSocketFrames(terminal, client, statusCh, done); runErr != nil {
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
		if runErr := forwardModalDecisions(client, decisionCh, done); runErr != nil {
			stop(runErr)
		}
	}()

	go watchResize(terminal, modal, done)

	go func() {
		if waitErr := terminal.Wait(); waitErr != nil {
			stop(waitErr)
			return
		}
		stop(io.EOF)
	}()

	select {
	case <-ctx.Done():
		return nil
	case runErr := <-errCh:
		if errors.Is(runErr, io.EOF) {
			return nil
		}
		return runErr
	}
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

func streamSocketFrames(
	terminal *pty.Session,
	client *transport.Client,
	statusCh chan<- protocol.SessionStatusPayload,
	done <-chan struct{},
) error {
	for {
		select {
		case <-done:
			return nil
		default:
		}

		_, payload, err := client.ReadMessage()
		if err != nil {
			return err
		}

		if err := handleControlFrame(terminal, payload, statusCh); err != nil {
			return err
		}
	}
}

func handleControlFrame(
	terminal *pty.Session,
	payload []byte,
	statusCh chan<- protocol.SessionStatusPayload,
) error {
	var envelope protocol.Envelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil
	}

	switch envelope.Type {
	case protocol.TypeStdin:
		var stdin protocol.StdinPayload
		if err := json.Unmarshal(envelope.Payload, &stdin); err != nil {
			return err
		}
		_, err := terminal.Write([]byte(stdin.Data))
		return err
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
	client *transport.Client,
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
				if err := client.WriteJSON(map[string]any{
					"type": protocol.TypeControlApprove,
					"payload": protocol.ControlApprovePayload{
						ViewerID:     decision.ViewerID,
						LeaseSeconds: decision.LeaseSeconds,
					},
				}); err != nil {
					return err
				}
			case modalReject:
				if err := client.WriteJSON(map[string]any{
					"type": protocol.TypeControlReject,
					"payload": protocol.ControlRejectPayload{
						ViewerID: decision.ViewerID,
					},
				}); err != nil {
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
