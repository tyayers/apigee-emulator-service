package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRedactKVMValue(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		expected  string
		minRedact float64
		maxRedact float64
	}{
		{
			name:      "Sample API Key 32 chars",
			input:     "mock-secret-key-1234567890abcdef",
			expected:  "mock***",
			minRedact: 0.80,
			maxRedact: 0.90,
		},
		{
			name:      "Custom Service Key",
			input:     "custom-service-secret-token-987654",
			expected:  "cust***",
			minRedact: 0.80,
			maxRedact: 0.95,
		},
		{
			name:      "Medium Secret 16 chars",
			input:     "supersecret12345",
			expected:  "supe***",
			minRedact: 0.70,
			maxRedact: 0.90,
		},
		{
			name:     "Short String < 6 chars",
			input:    "test",
			expected: "test", // Not redacted
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := RedactKVMValue(tc.input)
			if got != tc.expected {
				t.Errorf("RedactKVMValue(%q) = %q, expected %q", tc.input, got, tc.expected)
			}
			if tc.minRedact > 0 {
				visibleChars := len(strings.TrimSuffix(got, "***"))
				redactedFraction := float64(len(tc.input)-visibleChars) / float64(len(tc.input))
				if redactedFraction < tc.minRedact || redactedFraction > tc.maxRedact {
					t.Errorf("Redacted fraction %f not within [%f, %f]", redactedFraction, tc.minRedact, tc.maxRedact)
				}
			}
		})
	}
}

func TestExtractKVMSecretValues(t *testing.T) {
	rawJSON := `[
		{
			"name": "Backend-Config",
			"scope": "environment",
			"entries": {
				"ApiKey": "secret-sample-token-123456789",
				"Endpoint": "https://example.com/api",
				"ContentType": "application/json",
				"Unresolved": "env.{UNSET_KEY}"
			}
		},
		{
			"name": "Legacy-Config",
			"entries": [
				{
					"name": "AuthToken",
					"value": "custom-secret-key-987654321"
				}
			]
		}
	]`

	var parsed []map[string]interface{}
	if err := json.Unmarshal([]byte(rawJSON), &parsed); err != nil {
		t.Fatalf("Failed to parse test JSON: %v", err)
	}

	secrets := ExtractKVMSecretValues(parsed)
	if len(secrets) != 2 {
		t.Fatalf("Expected 2 secrets, got %d: %v", len(secrets), secrets)
	}

	if secrets[0] != "secret-sample-token-123456789" {
		t.Errorf("Expected first secret, got: %s", secrets[0])
	}
	if secrets[1] != "custom-secret-key-987654321" {
		t.Errorf("Expected second secret, got: %s", secrets[1])
	}
}

func TestRedactTraceData(t *testing.T) {
	secretOne := "mock-secret-token-123456789"
	secretTwo := "custom-secret-key-987654321"

	trace := map[string]interface{}{
		"traceSessionId": "session-123",
		"transactions": []interface{}{
			map[string]interface{}{
				"point": []interface{}{
					map[string]interface{}{
						"name": "Flow_Request",
						"properties": map[string]interface{}{
							"variable": []interface{}{
								map[string]interface{}{
									"name":  "propertyset.Backend-Config.ApiKey",
									"value": secretOne,
								},
								map[string]interface{}{
									"name":  "request.header.x-api-key",
									"value": secretOne,
								},
								map[string]interface{}{
									"name":  "target.url",
									"value": "https://example.com/api?key=" + secretOne,
								},
								map[string]interface{}{
									"name":  "another.variable",
									"value": "Bearer " + secretTwo,
								},
							},
						},
					},
				},
			},
		},
	}

	redacted := RedactTraceData(trace, []string{secretOne, secretTwo})

	b, _ := json.Marshal(redacted)
	jsonStr := string(b)

	// Original secrets must NOT be anywhere in the trace JSON
	if strings.Contains(jsonStr, secretOne) {
		t.Errorf("Trace JSON still contains raw secretOne: %s", jsonStr)
	}
	if strings.Contains(jsonStr, secretTwo) {
		t.Errorf("Trace JSON still contains raw secretTwo: %s", jsonStr)
	}

	// Redacted strings MUST be present
	if !strings.Contains(jsonStr, "mock***") {
		t.Errorf("Expected trace to contain 'mock***', got: %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "cust***") {
		t.Errorf("Expected trace to contain 'cust***', got: %s", jsonStr)
	}

	// Key names must be preserved
	if !strings.Contains(jsonStr, "ApiKey") {
		t.Errorf("Expected trace to preserve variable name 'ApiKey', got: %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "target.url") {
		t.Errorf("Expected trace to preserve 'target.url', got: %s", jsonStr)
	}
}

func TestEmulatorClient_GetTraceTransactions_Redaction(t *testing.T) {
	testSecret := "custom-mock-secret-key-987654"

	// Mock Apigee emulator management server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/emulator/trace/transactions") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{
				"point": [
					{
						"id": "Execution",
						"results": [
							{
								"name": "propertyset.Backend-Config.ApiKey",
								"value": "` + testSecret + `"
							},
							{
								"name": "url",
								"value": "https://example.com/api?key=` + testSecret + `"
							}
						]
					}
				]
			}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewEmulatorClient(server.URL, server.URL)
	client.KVMSecretProvider = func() []string {
		return []string{testSecret}
	}

	traceData, err := client.GetTraceTransactions("sess-abc")
	if err != nil {
		t.Fatalf("GetTraceTransactions failed: %v", err)
	}

	b, _ := json.Marshal(traceData)
	jsonStr := string(b)

	if strings.Contains(jsonStr, testSecret) {
		t.Errorf("GetTraceTransactions result contains raw secret: %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "cust***") {
		t.Errorf("GetTraceTransactions result missing 'cust***': %s", jsonStr)
	}
}
