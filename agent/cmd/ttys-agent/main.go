package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/jiayx/ttys/agent/internal/session"
)

func main() {
	server := flag.String("server", "http://127.0.0.1:8787", "ttys server base URL or direct host websocket URL")
	sessionID := flag.String("session", "", "existing session ID to attach as host when using an HTTP server URL")
	shell := flag.String("shell", "", "shell to launch")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := session.Config{
		ServerURL: *server,
		SessionID: *sessionID,
		Shell:     *shell,
	}

	if err := session.Run(ctx, cfg); err != nil {
		log.Fatal(err)
	}
}
