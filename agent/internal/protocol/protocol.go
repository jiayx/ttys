package protocol

import "encoding/json"

const (
	TypeSessionStatus  = "session.status"
	TypeControlRequest = "control.request"
	TypeControlApprove = "control.approve"
	TypeControlReject  = "control.reject"
	TypeControlRevoke  = "control.revoke"
)

const (
	BinaryTTYOutput byte = 0x01
	BinaryStdin     byte = 0x02
)

type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func EncodeBinary(messageType byte, payload []byte) []byte {
	msg := make([]byte, len(payload)+1)
	msg[0] = messageType
	copy(msg[1:], payload)
	return msg
}

func DecodeBinary(payload []byte) (byte, []byte, bool) {
	if len(payload) == 0 {
		return 0, nil, false
	}
	switch payload[0] {
	case BinaryTTYOutput, BinaryStdin:
		return payload[0], payload[1:], true
	default:
		return 0, nil, false
	}
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
