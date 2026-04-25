package transport

import (
	"context"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

const (
	TextMessage   = websocket.TextMessage
	BinaryMessage = websocket.BinaryMessage
)

type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func Dial(ctx context.Context, serverURL string) (*Client, error) {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, serverURL, http.Header{})
	if err != nil {
		return nil, err
	}

	return &Client{conn: conn}, nil
}

func (c *Client) ReadMessage() (int, []byte, error) {
	return c.conn.ReadMessage()
}

func (c *Client) WriteText(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, data)
}

func (c *Client) WriteBinary(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.BinaryMessage, data)
}

func (c *Client) WriteBinaryParts(parts ...[]byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	writer, err := c.conn.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return err
	}

	for _, part := range parts {
		if len(part) == 0 {
			continue
		}
		if _, err := writer.Write(part); err != nil {
			_ = writer.Close()
			return err
		}
	}

	return writer.Close()
}

func (c *Client) WriteBinaryFrom(messageType byte, payload []byte) error {
	return c.WriteBinaryParts([]byte{messageType}, payload)
}

func (c *Client) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

func (c *Client) Close() error {
	return c.conn.Close()
}
