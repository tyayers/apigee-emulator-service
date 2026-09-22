package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHasAuthorizationBearerToken(t *testing.T) {
	// Negative test cases: verify that missing, empty, or placeholder authorization
	// headers are correctly identified as NOT having an active bearer token,
	// so automatic token injection is allowed to proceed.
	tests := []struct {
		name     string
		headers  map[string]string
		expected bool
	}{
		{
			name:     "nil headers",
			headers:  nil,
			expected: false,
		},
		{
			name:     "empty headers",
			headers:  map[string]string{},
			expected: false,
		},
		{
			name:     "no authorization header",
			headers:  map[string]string{"x-api-key": "123", "Content-Type": "application/json"},
			expected: false,
		},
		{
			name:     "empty authorization value",
			headers:  map[string]string{"Authorization": ""},
			expected: false,
		},
		{
			name:     "whitespace authorization value",
			headers:  map[string]string{"Authorization": "   "},
			expected: false,
		},
		{
			name:     "just bearer word without space or token",
			headers:  map[string]string{"Authorization": "Bearer"},
			expected: false,
		},
		{
			name:     "bearer with only whitespace",
			headers:  map[string]string{"Authorization": "Bearer   "},
			expected: false,
		},
		{
			name:     "bearer placeholder <token>",
			headers:  map[string]string{"Authorization": "Bearer <token>"},
			expected: false,
		},
		{
			name:     "bearer placeholder auto",
			headers:  map[string]string{"Authorization": "Bearer auto"},
			expected: false,
		},
		{
			name:     "bearer placeholder $token",
			headers:  map[string]string{"Authorization": "Bearer $TOKEN"},
			expected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := hasAuthorizationBearerToken(tc.headers)
			if res != tc.expected {
				t.Errorf("hasAuthorizationBearerToken(%v) = %v, expected %v", tc.headers, res, tc.expected)
			}
		})
	}
}

func TestInjectGoogleAccessToken(t *testing.T) {
	t.Run("nil map", func(t *testing.T) {
		res := injectGoogleAccessToken(nil, "token123")
		if res["Authorization"] != "Bearer token123" {
			t.Errorf("Expected 'Bearer token123', got '%s'", res["Authorization"])
		}
	})

	t.Run("overwrites empty or existing lowercase authorization", func(t *testing.T) {
		headers := map[string]string{
			"authorization": "Bearer ",
			"x-api-key":     "key1",
		}
		res := injectGoogleAccessToken(headers, "newToken")
		if res["Authorization"] != "Bearer newToken" {
			t.Errorf("Expected 'Bearer newToken', got '%s'", res["Authorization"])
		}
		if _, exists := res["authorization"]; exists {
			t.Errorf("Expected old lowercase 'authorization' key to be removed")
		}
		if res["x-api-key"] != "key1" {
			t.Errorf("Expected other headers to be preserved")
		}
	})
}

type staticMockTokenProvider struct {
	token string
	err   error
}

func (s *staticMockTokenProvider) GetAccessToken(ctx context.Context) (string, error) {
	return s.token, s.err
}

func TestProxyTester_Execute_TokenInjection(t *testing.T) {
	mockRuntime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer mockRuntime.Close()

	emulatorClient := NewEmulatorClient("http://127.0.0.1:9999", mockRuntime.URL)

	t.Run("proceeds without error when token provider fails", func(t *testing.T) {
		pt := NewProxyTester(emulatorClient)
		pt.TokenProvider = &staticMockTokenProvider{err: fmt.Errorf("metadata server unreachable")}

		req := TestRequest{
			Method: "GET",
			Path:   "/test-endpoint",
			Headers: map[string]string{
				"x-api-key": "key1",
			},
		}

		resp, err := pt.Execute(req)
		if err != nil {
			t.Fatalf("Execute should not return error when token provider fails, got %v", err)
		}
		if resp.StatusCode != 200 {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}
	})
}
