package cnos

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const (
	pullOK = iota
	pullNotModified
	pullNoHead
)

// pullResult is a parsed http pull response.
type pullResult struct {
	status      int
	generation  int64
	revision    string
	schemaId    string
	effectiveAt string
	values      map[string]any
}

// pullBody is the 200 response wire shape:
// { generation, revision, schemaId?, effectiveAt, values }.
type pullBody struct {
	Generation  int64          `json:"generation"`
	Revision    string         `json:"revision"`
	SchemaId    string         `json:"schemaId"`
	EffectiveAt string         `json:"effectiveAt"`
	Values      map[string]any `json:"values"`
}

// errorBody carries the wire error code field.
type errorBody struct {
	Code string `json:"code"`
}

// pull performs GET {url}/cnos/vars?<scopeKind>=<scope> honoring the wire
// contract: 200 → snapshot, 304 (If-None-Match) → keep cache, 404 no-head →
// fall back to overlay tiers. ETag fills a missing revision.
func (variables *varRuntime) pull(ctx context.Context, source VarSourceDef, scopeKind, scope, knownRevision string) (pullResult, error) {
	endpoint := strings.TrimRight(source.URL, "/") + "/cnos/vars"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return pullResult{}, err
	}
	query := request.URL.Query()
	query.Set(scopeKind, scope)
	request.URL.RawQuery = query.Encode()

	if err := variables.applyAuth(request, source); err != nil {
		return pullResult{}, err
	}
	if knownRevision != "" {
		request.Header.Set("If-None-Match", knownRevision)
	}

	response, err := variables.httpClient.Do(request)
	if err != nil {
		return pullResult{}, err
	}
	defer response.Body.Close()

	switch response.StatusCode {
	case http.StatusOK:
		var body pullBody
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			return pullResult{}, fmt.Errorf("cnos: decode var pull %s=%s: %w", scopeKind, scope, err)
		}
		revision := body.Revision
		if revision == "" {
			revision = response.Header.Get("ETag")
		}
		return pullResult{
			status:      pullOK,
			generation:  body.Generation,
			revision:    revision,
			schemaId:    body.SchemaId,
			effectiveAt: body.EffectiveAt,
			values:      body.Values,
		}, nil
	case http.StatusNotModified:
		return pullResult{status: pullNotModified}, nil
	case http.StatusNotFound:
		var body errorBody
		_ = json.NewDecoder(response.Body).Decode(&body)
		if body.Code == "" || body.Code == "no-head" || body.Code == "not-found" {
			return pullResult{status: pullNoHead}, nil
		}
		return pullResult{}, fmt.Errorf("cnos: var pull %s=%s failed: %s", scopeKind, scope, body.Code)
	default:
		var body errorBody
		_ = json.NewDecoder(response.Body).Decode(&body)
		if body.Code != "" {
			return pullResult{}, fmt.Errorf("cnos: var pull %s=%s failed (%d): %s", scopeKind, scope, response.StatusCode, body.Code)
		}
		return pullResult{}, fmt.Errorf("cnos: var pull %s=%s failed: %d", scopeKind, scope, response.StatusCode)
	}
}

// applyAuth resolves the source's bearer secret ref via the existing Go secrets
// machinery and sets the Authorization header.
func (variables *varRuntime) applyAuth(request *http.Request, source VarSourceDef) error {
	ref, ok := source.Auth["bearer"]
	if !ok || ref == "" {
		return nil
	}
	secret, found, err := variables.runtime.Read(ref)
	if err != nil {
		return fmt.Errorf("cnos: resolve var source auth secret %q: %w", ref, err)
	}
	if !found {
		return fmt.Errorf("cnos: var source auth secret %q unresolved", ref)
	}
	if token, ok := secret.(string); ok && token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return nil
}
