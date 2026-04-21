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
	"path"
	"strings"
	"sync"
	"time"

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

func Run(ctx context.Context, cfg Config) error {
	select {
	case <-ctx.Done():
		return nil
	default:
	}

	shell := cfg.Shell
	if shell == "" {
		shell = platform.DefaultShell()
	}

	connectInfo, err := resolveConnection(ctx, cfg)
	if err != nil {
		return err
	}

	terminal, err := pty.Start(shell)
	if err != nil {
		return err
	}
	defer terminal.Close()

	local, err := newLocalTerminal()
	if err != nil {
		return err
	}
	local.Enter()
	defer local.Close()

	client, err := transport.Dial(ctx, connectInfo.HostWebSocketURL)
	if err != nil {
		return err
	}
	defer client.Close()
	local.SetNote("shared session ready", 2*time.Second)
	local.RenderStatusBar()

	errCh := make(chan error, 3)
	done := make(chan struct{})
	statusCh := make(chan protocol.SessionStatusPayload, 1)
	statusStore := &sessionStatusStore{}
	var once sync.Once

	stop := func(err error) {
		once.Do(func() {
			errCh <- err
			close(done)
		})
	}

	go func() {
		if err := streamPTYToSocket(terminal, client, local, done); err != nil {
			stop(err)
		}
	}()

	go func() {
		if err := streamSocketToPTY(terminal, client, statusCh, done); err != nil {
			stop(err)
		}
	}()

	go func() {
		if err := runLocalInput(terminal, client, statusCh, statusStore, local, done); err != nil {
			stop(err)
		}
	}()

	go startStatusTicker(local, done)
	go watchResize(terminal, local, done)

	go func() {
		if err := terminal.Wait(); err != nil {
			stop(err)
			return
		}
		stop(io.EOF)
	}()

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		if errors.Is(err, io.EOF) || errors.Is(err, errStopSharing) {
			return nil
		}
		return err
	}
}

type connectInfo struct {
	SessionID        string
	ViewerURL        string
	HostWebSocketURL string
}

type createSessionResponse struct {
	SessionID          string `json:"sessionId"`
	ViewerURL          string `json:"viewerUrl"`
	HostWebSocketURL   string `json:"hostWebSocketUrl"`
	ViewerWebSocketURL string `json:"viewerWebSocketUrl"`
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
				SessionID:        sessionIDFromPath(baseURL.Path),
				ViewerURL:        viewerURLFromWebSocket(baseURL),
				HostWebSocketURL: baseURL.String(),
			}, nil
		}
		return connectInfo{}, errors.New("session flag is not supported when server is a direct websocket URL")
	case "http", "https":
		if cfg.SessionID != "" {
			return connectInfo{
				SessionID:        cfg.SessionID,
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
		SessionID:        created.SessionID,
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

func sessionIDFromPath(p string) string {
	trimmed := strings.Trim(path.Clean(p), "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) >= 3 {
		return parts[2]
	}
	return ""
}

func streamPTYToSocket(
	terminal *pty.Session,
	client *transport.Client,
	local *localTerminal,
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
			if writeErr := local.WritePTYOutput(buf[:n]); writeErr != nil {
				return writeErr
			}
			if writeErr := client.WriteText(buf[:n]); writeErr != nil {
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

func streamSocketToPTY(
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
	case protocol.TypeResize:
		var resize protocol.ResizePayload
		if err := json.Unmarshal(envelope.Payload, &resize); err != nil {
			return err
		}
		return terminal.Resize(resize.Cols, resize.Rows)
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

func runLocalInput(
	terminal *pty.Session,
	client *transport.Client,
	statusCh <-chan protocol.SessionStatusPayload,
	statusStore *sessionStatusStore,
	local *localTerminal,
	done <-chan struct{},
) error {
	inputCh := make(chan byte, 16)
	errCh := make(chan error, 1)

	go readLocalBytes(inputCh, errCh, done)

	prefixMode := false

	for {
		select {
		case <-done:
			return nil
		case status := <-statusCh:
			statusStore.Set(status)
			local.UpdateStatus(status)
			if status.PendingControlRequest != nil {
				local.SetNote(
					fmt.Sprintf(
						"request from %s | Ctrl-G then a/d",
						status.PendingControlRequest.ViewerID,
					),
					4*time.Second,
				)
			}
			local.RenderStatusBar()
		case b := <-inputCh:
			if prefixMode {
				if err := handleLocalAction(b, client, statusStore, local); err != nil {
					return err
				}
				prefixMode = false
				local.SetPrefixMode(false)
				local.RenderStatusBar()
				continue
			}

			if b == localPrefixKey {
				prefixMode = true
				local.SetPrefixMode(true)
				local.RenderStatusBar()
				continue
			}

			if _, err := terminal.Write([]byte{b}); err != nil {
				return err
			}
		case err := <-errCh:
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func readLocalBytes(inputCh chan<- byte, errCh chan<- error, done <-chan struct{}) {
	buf := make([]byte, 1)
	for {
		select {
		case <-done:
			return
		default:
		}

		n, err := os.Stdin.Read(buf)
		if err != nil {
			errCh <- err
			return
		}
		if n == 1 {
			inputCh <- buf[0]
		}
	}
}

type sessionStatusStore struct {
	mu     sync.RWMutex
	status protocol.SessionStatusPayload
}

func (s *sessionStatusStore) Get() protocol.SessionStatusPayload {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func (s *sessionStatusStore) Set(status protocol.SessionStatusPayload) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = status
}

func emptyFallback(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
