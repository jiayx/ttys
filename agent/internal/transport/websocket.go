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

func (c *Client) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

func (c *Client) Close() error {
	return c.conn.Close()
}
