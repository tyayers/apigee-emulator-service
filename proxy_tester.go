package main

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ProxyTester executes test HTTP requests against Apigee runtime and captures traces.
type ProxyTester struct {
	Emulator      *EmulatorClient
	Client        *http.Client
	TokenProvider GoogleTokenProvider
}

// NewProxyTester creates a new ProxyTester instance.
func NewProxyTester(emulator *EmulatorClient) *ProxyTester {
	return &ProxyTester{
		Emulator: emulator,
		Client: &http.Client{
			Timeout: 120 * time.Second, // Support long LLM generation
		},
		TokenProvider: NewCloudRunTokenProvider(),
	}
}

// Execute runs the test request against the emulator runtime.
func (pt *ProxyTester) Execute(req TestRequest) (*TestResponse, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	path := strings.TrimSpace(req.Path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	targetURL := fmt.Sprintf("%s%s", pt.Emulator.RuntimeURL, path)

	var traceSessionID string
	var err error

	// 1. Optionally start trace session
	if req.RecordTrace && req.Proxy != "" {
		traceSessionID, err = pt.Emulator.StartTraceSession(req.Proxy)
		if err != nil {
			// Log error but proceed with call
			fmt.Printf("Warning: failed to start trace session for %s: %v\n", req.Proxy, err)
		}
	}

	// 2. Prepare HTTP request
	var bodyReader io.Reader
	if req.Body != "" && method != http.MethodGet && method != http.MethodHead {
		bodyReader = strings.NewReader(req.Body)
	}

	httpReq, err := http.NewRequest(method, targetURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create http request: %w", err)
	}

	// Clean and normalize incoming request headers case-insensitively
	effectiveHeaders := make(map[string]string)
	if req.Headers != nil {
		for k, v := range req.Headers {
			trimmedK := strings.TrimSpace(k)
			if trimmedK == "" {
				continue
			}
			foundKey := ""
			for existingKey := range effectiveHeaders {
				if strings.EqualFold(existingKey, trimmedK) {
					foundKey = existingKey
					break
				}
			}
			if foundKey != "" {
				effectiveHeaders[foundKey] = v
			} else {
				effectiveHeaders[trimmedK] = v
			}
		}
	}

	// 2a. Inject Google access token if no Authorization bearer token is present in test request headers
	if !hasAuthorizationBearerToken(effectiveHeaders) && pt.TokenProvider != nil {
		token, tokenErr := pt.TokenProvider.GetAccessToken(httpReq.Context())
		if tokenErr == nil && token != "" {
			effectiveHeaders = injectGoogleAccessToken(effectiveHeaders, token)
		} else if tokenErr != nil {
			// Log informative notice; continue without token so offline/unauthenticated proxies still run
			fmt.Printf("Notice: could not acquire Google access token: %v\n", tokenErr)
		}
	}

	hasUA := false
	for k := range effectiveHeaders {
		if strings.EqualFold(k, "User-Agent") {
			hasUA = true
			break
		}
	}
	if !hasUA {
		effectiveHeaders["User-Agent"] = "Apigee-Emulator-Manager/1.0"
	}

	// Apply headers to HTTP request
	for k, v := range effectiveHeaders {
		httpReq.Header.Set(k, v)
	}

	// Keep req.Headers synchronized with effective dispatched headers without duplicates or extra keys
	req.Headers = effectiveHeaders

	// 3. Measure execution latency
	startTime := time.Now()
	resp, err := pt.Client.Do(httpReq)
	duration := time.Since(startTime).Milliseconds()

	if err != nil {
		return &TestResponse{
			StatusCode:     502,
			StatusText:     "502 Bad Gateway",
			DurationMs:     duration,
			Headers:        map[string]string{},
			Body:           fmt.Sprintf("Connection Error: %v", err),
			TraceSessionID: traceSessionID,
			Error:          err.Error(),
			Request:        &req,
		}, nil
	}
	defer resp.Body.Close()

	// 4. Read response body
	respBodyBytes, _ := io.ReadAll(resp.Body)
	respHeaders := make(map[string]string)
	for k, vals := range resp.Header {
		respHeaders[k] = strings.Join(vals, ", ")
	}

	testResp := &TestResponse{
		StatusCode:     resp.StatusCode,
		StatusText:     resp.Status,
		DurationMs:     duration,
		Headers:        respHeaders,
		Body:           string(respBodyBytes),
		TraceSessionID: traceSessionID,
		Request:        &req,
	}

	for k, v := range respHeaders {
		if strings.EqualFold(k, "X-Apigee-target-latency") {
			if lat, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				testResp.TargetLatencyMs = &lat
				break
			}
		}
	}

	// 5. Fetch trace data if trace was enabled
	if traceSessionID != "" {
		// Small buffer wait for emulator to record trace
		time.Sleep(150 * time.Millisecond)
		traceData, err := pt.Emulator.GetTraceTransactions(traceSessionID)
		if err == nil && traceData != nil {
			testResp.TraceData = traceData
			if testResp.TargetLatencyMs == nil {
				if lat := extractTargetLatencyFromTrace(traceData); lat != nil {
					testResp.TargetLatencyMs = lat
				}
			}
		} else if err != nil {
			fmt.Printf("Warning: failed to retrieve trace transactions for session %s: %v\n", traceSessionID, err)
		}
	}

	return testResp, nil
}

// extractTargetLatencyFromTrace recursively searches the Apigee trace structure for target latency
func extractTargetLatencyFromTrace(data interface{}) *int64 {
	var targetLat *int64
	var targetSentStart, targetRecvEnd int64

	var walk func(v interface{})
	walk = func(v interface{}) {
		if targetLat != nil || v == nil {
			return
		}
		switch val := v.(type) {
		case map[string]interface{}:
			if name, ok := val["name"].(string); ok {
				if strings.EqualFold(name, "X-Apigee-target-latency") {
					if strVal, ok := val["value"].(string); ok {
						if parsed, err := strconv.ParseInt(strings.TrimSpace(strVal), 10, 64); err == nil {
							targetLat = &parsed
							return
						}
					}
				} else if name == "target.sent.start.timestamp" {
					if strVal, ok := val["value"].(string); ok {
						if parsed, err := strconv.ParseInt(strings.TrimSpace(strVal), 10, 64); err == nil {
							targetSentStart = parsed
						}
					}
				} else if name == "target.received.end.timestamp" {
					if strVal, ok := val["value"].(string); ok {
						if parsed, err := strconv.ParseInt(strings.TrimSpace(strVal), 10, 64); err == nil {
							targetRecvEnd = parsed
						}
					}
				}
			}
			for _, child := range val {
				walk(child)
				if targetLat != nil {
					return
				}
			}
		case []interface{}:
			for _, item := range val {
				walk(item)
				if targetLat != nil {
					return
				}
			}
		}
	}

	walk(data)
	if targetLat != nil {
		return targetLat
	}
	if targetRecvEnd > 0 && targetSentStart > 0 && targetRecvEnd >= targetSentStart {
		diff := targetRecvEnd - targetSentStart
		return &diff
	}
	return nil
}
