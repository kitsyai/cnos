package cnos

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// receiverBody is the inbound push wire shape (values scoped to a key/group):
// { revision?, generation?, schemaId?, effectiveAt?, values }.
type receiverBody struct {
	Revision    string         `json:"revision"`
	Generation  int64          `json:"generation"`
	SchemaId    string         `json:"schemaId"`
	EffectiveAt string         `json:"effectiveAt"`
	Values      map[string]any `json:"values"`
}

// receiver returns a latching http.Handler for POSTed pushes on the source. It
// verifies bearer/HMAC via the source's `verify` secret ref and routes accepted
// payloads through the SAME ingest path (validate → atomic commit → notify).
// It never starts its own server; mount it on the host mux at "/cnos/vars/".
func (variables *varRuntime) receiver(sourceName string) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		source, ok := variables.sources[sourceName]
		if !ok {
			http.Error(writer, "unknown source", http.StatusNotFound)
			return
		}

		body, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		if err != nil {
			http.Error(writer, "read error", http.StatusBadRequest)
			return
		}
		if err := variables.verifyInbound(source, request, body); err != nil {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}

		scope := scopeFromPath(request.URL.Path)
		if scope == "" {
			http.Error(writer, "missing scope", http.StatusBadRequest)
			return
		}

		var payload receiverBody
		if err := json.Unmarshal(body, &payload); err != nil || payload.Values == nil {
			http.Error(writer, "bad payload", http.StatusBadRequest)
			return
		}

		// Defaults when absent — identical to the Node SDK receiver:
		//   revision   = "sha256:" + hex(sha256(canonical JSON of values))
		//   generation = current unix millis
		revision := payload.Revision
		if revision == "" {
			revision = defaultVarRevision(payload.Values)
		}
		generation := payload.Generation
		if generation == 0 {
			generation = time.Now().UnixMilli()
		}
		effectiveAt := payload.EffectiveAt
		if effectiveAt == "" {
			effectiveAt = time.Now().UTC().Format(time.RFC3339)
		}

		batch := varBatch{
			group:       groupFromVarKey(scope),
			generation:  generation,
			revision:    revision,
			schemaId:    payload.SchemaId,
			effectiveAt: effectiveAt,
			values:      payload.Values,
		}
		if err := variables.ingest(batch, "push"); err != nil {
			http.Error(writer, "rejected", http.StatusUnprocessableEntity)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})
}

// verifyInbound checks the request against the source's verify secret: a bearer
// token match (Authorization: Bearer) or an HMAC-SHA256 body signature
// (X-CNOS-Signature: sha256=<hex>). Both comparisons are constant time.
func (variables *varRuntime) verifyInbound(source VarSourceDef, request *http.Request, body []byte) error {
	if source.Verify == "" {
		return fmt.Errorf("cnos: var source %q has no verify secret", source.Verify)
	}
	secret, found, err := variables.runtime.Read(source.Verify)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("cnos: var receiver verify secret unresolved")
	}
	token, _ := secret.(string)
	if token == "" {
		return fmt.Errorf("cnos: var receiver verify secret empty")
	}

	if auth := request.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		presented := strings.TrimPrefix(auth, "Bearer ")
		if hmac.Equal([]byte(presented), []byte(token)) {
			return nil
		}
		return fmt.Errorf("cnos: var receiver bearer mismatch")
	}

	if signature := request.Header.Get("X-CNOS-Signature"); signature != "" {
		mac := hmac.New(sha256.New, []byte(token))
		mac.Write(body)
		expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if hmac.Equal([]byte(signature), []byte(expected)) {
			return nil
		}
		return fmt.Errorf("cnos: var receiver hmac mismatch")
	}

	return fmt.Errorf("cnos: var receiver missing credentials")
}

// defaultVarRevision derives a content-addressed revision for a values map when a
// push omits one: "sha256:" + hex(sha256(canonical JSON of values)). Canonical JSON
// sorts object keys and emits compact output with HTML escaping off, matching the
// Node SDK receiver so an omitted revision hashes identically across SDKs.
func defaultVarRevision(values map[string]any) string {
	sum := sha256.Sum256([]byte(canonicalVarJSON(values)))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// canonicalVarJSON serializes a value with sorted object keys, compact, no HTML
// escaping. Go's encoding/json already sorts map keys; disabling HTML escaping keeps
// parity with the Node canonicalizer (which does not escape <, >, &).
func canonicalVarJSON(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return ""
	}
	return strings.TrimRight(buffer.String(), "\n")
}

// scopeFromPath extracts the scope segment after "/cnos/vars/".
func scopeFromPath(path string) string {
	trimmed := strings.TrimRight(path, "/")
	if index := strings.Index(trimmed, "/cnos/vars/"); index >= 0 {
		return trimmed[index+len("/cnos/vars/"):]
	}
	if index := strings.LastIndex(trimmed, "/"); index >= 0 {
		return trimmed[index+1:]
	}
	return trimmed
}
