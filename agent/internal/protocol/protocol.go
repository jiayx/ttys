package protocol

import "encoding/json"

const (
	TypeStdin          = "stdin"
	TypeSessionStatus  = "session.status"
	TypeControlRequest = "control.request"
	TypeControlApprove = "control.approve"
	TypeControlReject  = "control.reject"
	TypeControlRevoke  = "control.revoke"
)

type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type StdinPayload struct {
	Data string `json:"data"`
}

type ControlRequestPayload struct {
	ViewerID     string `json:"viewerId"`
	LeaseSeconds int    `json:"leaseSeconds"`
}

type ControlApprovePayload struct {
	ViewerID     string `json:"viewerId"`
	LeaseSeconds int    `json:"leaseSeconds"`
}

type ControlRejectPayload struct {
	ViewerID string `json:"viewerId"`
}

type ControlRevokePayload struct {
	ViewerID string `json:"viewerId,omitempty"`
}

type SessionStatusPayload struct {
	Role                     string                 `json:"role"`
	State                    string                 `json:"state"`
	HostConnected            bool                   `json:"hostConnected"`
	ViewerCount              int                    `json:"viewerCount"`
	ViewerID                 string                 `json:"viewerId"`
	CanWrite                 bool                   `json:"canWrite"`
	ControllerViewerID       string                 `json:"controllerViewerId"`
	ControlLeaseExpiresAt    int64                  `json:"controlLeaseExpiresAt"`
	PendingControlRequest    *ControlRequestPayload `json:"pendingControlRequest"`
	HasPendingControlRequest bool                   `json:"hasPendingControlRequest"`
	SessionExpiresAt         int64                  `json:"sessionExpiresAt"`
	HostDisconnectDeadline   int64                  `json:"hostDisconnectDeadline"`
	PendingRequestExpiresAt  int64                  `json:"pendingRequestExpiresAt"`
}
