package main

import (
	"fmt"
	"io"
	"net/http"
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

	// 2a. Inject Google access token if no Authorization bearer token is present in test request headers
	if !hasAuthorizationBearerToken(req.Headers) && pt.TokenProvider != nil {
		token, tokenErr := pt.TokenProvider.GetAccessToken(httpReq.Context())
		if tokenErr == nil && token != "" {
			req.Headers = injectGoogleAccessToken(req.Headers, token)
		} else if tokenErr != nil {
			// Log informative notice; continue without token so offline/unauthenticated proxies still run
			fmt.Printf("Notice: could not acquire Google access token: %v\n", tokenErr)
		}
	}

	// Apply headers
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	if httpReq.Header.Get("User-Agent") == "" {
		httpReq.Header.Set("User-Agent", "Apigee-Emulator-Manager/1.0")
	}

	// Ensure API key headers are synchronized across both standard and AI key formats
	apiKey := httpReq.Header.Get("x-api-key")
	aiKey := httpReq.Header.Get("x-ai-key")
	if apiKey != "" && aiKey == "" {
		httpReq.Header.Set("x-ai-key", apiKey)
	} else if aiKey != "" && apiKey == "" {
		httpReq.Header.Set("x-api-key", aiKey)
	}

	// Record effective headers dispatched
	if req.Headers == nil {
		req.Headers = make(map[string]string)
	}
	for k := range httpReq.Header {
		req.Headers[k] = httpReq.Header.Get(k)
	}

	// 3. Measure execution latency
	startTime := time.Now()
	resp, err := pt.Client.Do(httpReq)
	duration := time.Since(startTime).Milliseconds()

	// If 401 Unauthorized (InvalidApiKey) occurs, try resolving active keys from emulator datastore
	if err == nil && resp.StatusCode == 401 && (apiKey != "" || aiKey != "") {
		if activeKeys, keyErr := pt.Emulator.GetActiveConsumerKeys(); keyErr == nil && len(activeKeys) > 0 {
			activeKey := activeKeys[0]
			currentKey := apiKey
			if currentKey == "" {
				currentKey = aiKey
			}
			if activeKey != currentKey {
				resp.Body.Close()
				var retryBodyReader io.Reader
				if req.Body != "" && method != http.MethodGet && method != http.MethodHead {
					retryBodyReader = strings.NewReader(req.Body)
				}
				if retryReq, rErr := http.NewRequest(method, targetURL, retryBodyReader); rErr == nil {
					for k, v := range req.Headers {
						retryReq.Header.Set(k, v)
					}
					retryReq.Header.Set("x-api-key", activeKey)
					retryReq.Header.Set("x-ai-key", activeKey)
					req.Headers["x-api-key"] = activeKey
					req.Headers["x-ai-key"] = activeKey
					if retryReq.Header.Get("User-Agent") == "" {
						retryReq.Header.Set("User-Agent", "Apigee-Emulator-Manager/1.0")
					}
					retryStart := time.Now()
					if retryResp, doErr := pt.Client.Do(retryReq); doErr == nil {
						resp = retryResp
						duration = time.Since(retryStart).Milliseconds()
					}
				}
			}
		}
	}

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

	// 5. Fetch trace data if trace was enabled
	if traceSessionID != "" {
		// Small buffer wait for emulator to record trace
		time.Sleep(150 * time.Millisecond)
		traceData, err := pt.Emulator.GetTraceTransactions(traceSessionID)
		if err == nil && traceData != nil {
			testResp.TraceData = traceData
		} else if err != nil {
			fmt.Printf("Warning: failed to retrieve trace transactions for session %s: %v\n", traceSessionID, err)
		}
	}

	return testResp, nil
}
