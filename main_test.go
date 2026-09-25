package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestDeployStateConcurrency(t *testing.T) {
	s := &Server{}
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(idx int) {
			defer wg.Done()
			s.setDeployState(idx%2 == 0, "status message", "")
		}(i)

		go func() {
			defer wg.Done()
			_, _, _ = s.getDeployState()
		}()
	}

	wg.Wait()
}

func TestEmulatorStatusJSON(t *testing.T) {
	status := EmulatorStatus{
		Online:        true,
		IsDeploying:   true,
		DeployMessage: "Deploying all proxy bundles...",
	}

	data, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Failed to marshal EmulatorStatus: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	if isDeploying, ok := parsed["isDeploying"].(bool); !ok || !isDeploying {
		t.Errorf("Expected isDeploying to be true, got %v", parsed["isDeploying"])
	}

	if msg, ok := parsed["deployMessage"].(string); !ok || msg != "Deploying all proxy bundles..." {
		t.Errorf("Expected deployMessage to match, got %v", parsed["deployMessage"])
	}
}

func TestDeployResponseJSON(t *testing.T) {
	resp := DeployResponse{
		Success:       true,
		Message:       "Deployed successfully",
		TotalDeployed: 3,
		DeployedCount: 3,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal DeployResponse: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	if total, ok := parsed["totalDeployed"].(float64); !ok || int(total) != 3 {
		t.Errorf("Expected totalDeployed 3, got %v", parsed["totalDeployed"])
	}
	if count, ok := parsed["deployedCount"].(float64); !ok || int(count) != 3 {
		t.Errorf("Expected deployedCount 3, got %v", parsed["deployedCount"])
	}
}

func TestEvaluateAssertion(t *testing.T) {
	targetLat := int64(85)
	resp := &TestResponse{
		StatusCode:      200,
		StatusText:      "200 OK",
		DurationMs:      150,
		TargetLatencyMs: &targetLat,
		Headers: map[string]string{
			"Content-Type": "application/json; charset=utf-8",
			"x-request-id": "req-12345",
		},
		Body: `{"model":"google/gemini-3.8-flash","id":123,"user":{"name":"John"},"choices":[{"message":{"content":"Hello"}}]}`,
		Request: &TestRequest{
			Proxy:  "testproxy",
			Method: "POST",
			Path:   "/testproxy/123",
			Headers: map[string]string{
				"Authorization": "Bearer secret-token",
				"Content-Type":  "application/json",
			},
			Body: `{"id":123,"user":{"name":"John"}}`,
		},
		TraceData: map[string]interface{}{
			"error": false,
			"variables": map[string]interface{}{
				"ext1": "one",
			},
			"transactions": []interface{}{
				map[string]interface{}{
					"error": false,
					"point": []interface{}{
						map[string]interface{}{
							"id":    "Step-VerifyAPIKey",
							"error": false,
						},
					},
				},
			},
		},
	}

	tests := []struct {
		assertion  string
		expectPass bool
	}{
		// Basic status and duration
		{"status.code == 200", true},
		{"status.code != 400", true},
		{"status.code == 404", false},
		{"response.status == 200", true},
		{"response.status.code >= 200", true},
		{"duration < 1000", true},
		{"duration > 500", false},
		{"total.latency == 150", true},
		{"target.latency == 85", true},
		{"target.latency < 100", true},
		{"proxy.latency == 65", true},
		{"proxy.latency < 100", true},

		// Headers
		{"headers.content-type contains json", true},
		{"response.headers.Content-Type contains \"application/json\"", true},
		{"headers['x-request-id'] == req-12345", true},
		{"request.headers.Authorization exists", true},
		{"request.headers.MissingHeader not exists", true},
		{"request.headers.MissingHeader exists", false},

		// Body & JSON nested fields
		{"body contains gemini-3.8-flash", true},
		{"response.body.user.name == \"John\"", true},
		{"request.body.user.name == \"John\"", true},
		{"response.body.id == 123", true},
		{"request.body.id == 123", true},
		{"request.path.id == 123", true},

		// Trace
		{"trace.error == false", true},
		{"trace.steps contains Step-VerifyAPIKey", true},

		// Variables & operators
		{"var.ext1 == \"one\"", true},
		{"var.ext1 == \"one\" # exactly equals", true},
		{"var.ext1 != \"one\"", false},
		{"var.ext1 != \"two\"", true},
		{"var.ext1 contains \"one\"", true},
		{"var.ext1 not contains \"one\"", false},
		{"var.ext1 not contains \"two\"", true},
		{"var.ext1 startsWith \"one\"", true},
		{"var.ext1 startsWith \"on\"", true},
		{"var.ext1 startsWith \"two\"", false},
		{"var.ext1 endsWith \"one\"", true},
		{"var.ext1 endsWith \"ne\"", true},
		{"var.ext1 endsWith \"two\"", false},
		{"var.ext1 matches /one.*/", true},
		{"var.ext1 matches /.*ne$/", true},
		{"var.ext1 matches /^two/", false},
		{"var.ext1 exists", true},
		{"var.missing not exists", true},
	}

	for _, tc := range tests {
		res := EvaluateAssertion(tc.assertion, resp)
		if res.Passed != tc.expectPass {
			t.Errorf("Assertion %q: expected passed=%v, got %v (actual=%q, expected=%q, error=%q)",
				tc.assertion, tc.expectPass, res.Passed, res.Actual, res.Expected, res.Error)
		}
	}

	// Test EvaluateAssertions with comma-separated and multi-line assertions
	multiList := []string{
		"response.body.user.name == \"John\", request.headers.Authorization exists",
		"var.ext1 == \"one\"\nresponse.status == 200",
	}
	multiRes := EvaluateAssertions(multiList, resp)
	if len(multiRes) != 4 {
		t.Fatalf("Expected 4 assertion results, got %d", len(multiRes))
	}
	for i, r := range multiRes {
		if !r.Passed {
			t.Errorf("Multi-assertion %d (%q) failed: actual=%q, expected=%q", i, r.Assertion, r.Actual, r.Expected)
		}
	}
}

func TestTestHistoryManager(t *testing.T) {
	thm := NewTestHistoryManager(10)

	thm.Record(TestRunResult{
		TestName: "test-proxy-1",
		Proxy:    "TestProxy",
		Passed:   true,
	})
	thm.Record(TestRunResult{
		TestName: "test-quotes-1",
		Proxy:    "QuoteOfTheDayProxy",
		Passed:   false,
	})
	thm.Record(TestRunResult{
		TestName: "test-proxy-2",
		Proxy:    "TestProxy",
		Passed:   true,
	})

	allRuns := thm.GetHistory("")
	if len(allRuns) != 3 {
		t.Fatalf("Expected 3 runs, got %d", len(allRuns))
	}

	proxyRuns := thm.GetHistory("TestProxy")
	if len(proxyRuns) != 2 {
		t.Fatalf("Expected 2 runs for TestProxy, got %d", len(proxyRuns))
	}

	thm.Clear("TestProxy")
	proxyRunsAfter := thm.GetHistory("TestProxy")
	if len(proxyRunsAfter) != 0 {
		t.Fatalf("Expected 0 runs after clear, got %d", len(proxyRunsAfter))
	}

	quoteRuns := thm.GetHistory("QuoteOfTheDayProxy")
	if len(quoteRuns) != 1 {
		t.Fatalf("Expected 1 run for QuoteOfTheDayProxy after clearing TestProxy, got %d", len(quoteRuns))
	}
}

func TestTestHistoryAPIEndpoints(t *testing.T) {
	s := &Server{
		TestHistory: NewTestHistoryManager(10),
	}

	rec := s.TestHistory.Record(TestRunResult{
		TestName:   "unit-test-1",
		Proxy:      "TestProxy",
		Passed:     true,
		StatusCode: 200,
		Response: &TestResponse{
			StatusCode: 200,
			Body:       `{"status":"ok"}`,
			TraceData: map[string]interface{}{
				"transactions": []interface{}{},
			},
		},
		Assertions: []AssertionResult{
			{Assertion: "status.code == 200", Passed: true, Actual: "200", Expected: "200"},
		},
	})
	runID := rec.ID

	// Test GET /tester/api/tests/history
	req := httptest.NewRequest("GET", "/tester/api/tests/history?proxy=TestProxy", nil)
	w := httptest.NewRecorder()
	s.handleTestsHistory(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	var history []TestRunResult
	if err := json.Unmarshal(w.Body.Bytes(), &history); err != nil {
		t.Fatalf("Failed to parse history JSON: %v", err)
	}
	if len(history) != 1 || history[0].ID != runID {
		t.Fatalf("Expected 1 history item with ID %s, got %+v", runID, history)
	}

	// Test GET /tester/api/tests/history/{id}/result
	reqResult := httptest.NewRequest("GET", "/tester/api/tests/history/"+runID+"/result", nil)
	wResult := httptest.NewRecorder()
	s.handleTestHistoryDetail(wResult, reqResult)

	if wResult.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for result download, got %d", wResult.Code)
	}
	disp := wResult.Header().Get("Content-Disposition")
	if disp == "" {
		t.Errorf("Expected Content-Disposition header, got none")
	}

	// Test DELETE /tester/api/tests/history?proxy=TestProxy
	reqDel := httptest.NewRequest("DELETE", "/tester/api/tests/history?proxy=TestProxy", nil)
	wDel := httptest.NewRecorder()
	s.handleTestsHistory(wDel, reqDel)

	if wDel.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for DELETE, got %d", wDel.Code)
	}
	if len(s.TestHistory.GetHistory("TestProxy")) != 0 {
		t.Errorf("Expected 0 history items after DELETE")
	}
}

func TestDataSubdirectoriesAndResourceEndpoints(t *testing.T) {
	bm := NewBundleManager("data", ".")

	// Test finding files in data subdirectories
	prodPath := bm.FindDataFile("products", "products.json")
	if prodPath == "" {
		t.Fatalf("Expected to find products.json in data/products/products.json")
	}

	devPath := bm.FindDataFile("developers", "developers.json")
	if devPath == "" {
		t.Fatalf("Expected to find developers.json in data/developers/developers.json")
	}

	appsPath := bm.FindDataFile("developerapps", "developerapps.json")
	if appsPath == "" {
		t.Fatalf("Expected to find developerapps.json in data/developerapps/developerapps.json")
	}

	mapsPath := bm.FindDataFile("maps", "maps.json")
	if mapsPath == "" {
		t.Fatalf("Expected to find maps.json in data/maps/maps.json")
	}

	dcPath := bm.FindDataFile("datacollectors", "datacollectors.json")
	if dcPath == "" {
		t.Fatalf("Expected to find datacollectors.json in data/datacollectors/datacollectors.json")
	}

	// Test GetProducts and verify llmOperationGroup
	prods, err := bm.GetProducts()
	if err != nil {
		t.Fatalf("Failed to get products: %v", err)
	}
	if len(prods) == 0 {
		t.Fatalf("Expected at least 1 product")
	}

	foundLLM := false
	for _, p := range prods {
		if llmGroup, ok := p["llmOperationGroup"].(map[string]interface{}); ok {
			if configs, ok := llmGroup["operationConfigs"].([]interface{}); ok && len(configs) > 0 {
				for _, cfg := range configs {
					if cfgMap, ok := cfg.(map[string]interface{}); ok {
						if src, _ := cfgMap["apiSource"].(string); src == "REST-AI-Completions" {
							foundLLM = true
						}
					}
				}
			}
		}
	}
	if !foundLLM {
		t.Errorf("Expected test-product to have llmOperationGroup with REST-AI-Completions")
	}

	// Test GetUsers
	users, err := bm.GetUsers()
	if err != nil {
		t.Fatalf("Failed to get users: %v", err)
	}
	if len(users) == 0 {
		t.Fatalf("Expected at least 1 user")
	}

	// Test GetApps
	apps, err := bm.GetApps()
	if err != nil {
		t.Fatalf("Failed to get apps: %v", err)
	}
	if len(apps) == 0 {
		t.Fatalf("Expected at least 1 app")
	}

	// Test HTTP endpoints
	s := &Server{
		BundleManager:  bm,
		EmulatorClient: NewEmulatorClient("http://localhost:8998", "http://localhost:8998"),
	}

	// GET /tester/api/products
	reqP := httptest.NewRequest("GET", "/tester/api/products", nil)
	wP := httptest.NewRecorder()
	s.handleProducts(wP, reqP)
	if wP.Code != http.StatusOK {
		t.Errorf("handleProducts status: expected 200, got %d", wP.Code)
	}

	// GET /tester/api/users
	reqU := httptest.NewRequest("GET", "/tester/api/users", nil)
	wU := httptest.NewRecorder()
	s.handleUsers(wU, reqU)
	if wU.Code != http.StatusOK {
		t.Errorf("handleUsers status: expected 200, got %d", wU.Code)
	}

	// GET /tester/api/apps
	reqA := httptest.NewRequest("GET", "/tester/api/apps", nil)
	wA := httptest.NewRecorder()
	s.handleApps(wA, reqA)
	if wA.Code != http.StatusOK {
		t.Errorf("handleApps status: expected 200, got %d", wA.Code)
	}
}

func TestEmulatorStateAndSetupTestDataEndpoints(t *testing.T) {
	bm := NewBundleManager("data", ".")
	s := &Server{
		BundleManager:     bm,
		DeploymentManager: NewDeploymentManager("data"),
		EmulatorClient:    NewEmulatorClient("http://localhost:8998", "http://localhost:8080"),
	}

	// GET /tester/api/emulator/state
	reqState := httptest.NewRequest("GET", "/tester/api/emulator/state", nil)
	wState := httptest.NewRecorder()
	s.handleEmulatorState(wState, reqState)
	if wState.Code != http.StatusOK {
		t.Errorf("handleEmulatorState status: expected 200, got %d", wState.Code)
	}

	var stateResp EmulatorStateResponse
	if err := json.Unmarshal(wState.Body.Bytes(), &stateResp); err != nil {
		t.Fatalf("Failed to parse emulator state response: %v", err)
	}
	if len(stateResp.ValidationChecks) == 0 {
		t.Errorf("Expected validation checks in emulator state response")
	}

	// POST /tester/api/emulator/setup-testdata
	reqSetup := httptest.NewRequest("POST", "/tester/api/emulator/setup-testdata", nil)
	wSetup := httptest.NewRecorder()
	s.handleSetupTestData(wSetup, reqSetup)
	var setupResp map[string]interface{}
	if err := json.Unmarshal(wSetup.Body.Bytes(), &setupResp); err != nil {
		t.Fatalf("Failed to parse setup-testdata response: %v", err)
	}
}

func TestProxyYamlEndpoints(t *testing.T) {
	bm := NewBundleManager("data", ".")
	s := &Server{
		BundleManager:     bm,
		DeploymentManager: NewDeploymentManager("data"),
		RootDir:           ".",
	}

	// 1. Valid proxy with root YAML file: TestProxy
	req1 := httptest.NewRequest("GET", "/tester/api/proxies/yaml?name=TestProxy", nil)
	w1 := httptest.NewRecorder()
	s.handleProxyYaml(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("handleProxyYaml TestProxy expected 200, got %d: %s", w1.Code, w1.Body.String())
	}
	var resp1 ProxyYamlResponse
	if err := json.Unmarshal(w1.Body.Bytes(), &resp1); err != nil {
		t.Fatalf("Failed to parse TestProxy response: %v", err)
	}
	if !resp1.Success || resp1.YAML == "" || resp1.Proxy != "TestProxy" {
		t.Errorf("Unexpected TestProxy response: %+v", resp1)
	}
	if resp1.DisplayName != "Hello World Proxy" {
		t.Errorf("Expected TestProxy DisplayName 'Hello World Proxy', got %q", resp1.DisplayName)
	}

	// 2. Valid proxy with template YAML file: REST-AI-Completions
	req2 := httptest.NewRequest("GET", "/tester/api/proxies/yaml?proxy=REST-AI-Completions", nil)
	w2 := httptest.NewRecorder()
	s.handleProxyYaml(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("handleProxyYaml REST-AI-Completions expected 200, got %d: %s", w2.Code, w2.Body.String())
	}
	var resp2 ProxyYamlResponse
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatalf("Failed to parse REST-AI-Completions response: %v", err)
	}
	if !resp2.Success || resp2.YAML == "" {
		t.Errorf("Unexpected REST-AI-Completions response: %+v", resp2)
	}
	if resp2.DisplayName != "Completions API" {
		t.Errorf("Expected REST-AI-Completions DisplayName 'Completions API', got %q", resp2.DisplayName)
	}

	// 3. Missing query parameter
	req3 := httptest.NewRequest("GET", "/tester/api/proxies/yaml", nil)
	w3 := httptest.NewRecorder()
	s.handleProxyYaml(w3, req3)
	if w3.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for missing name, got %d", w3.Code)
	}

	// 4. Non-existent proxy
	req4 := httptest.NewRequest("GET", "/tester/api/proxies/yaml?name=NonExistentProxy123", nil)
	w4 := httptest.NewRecorder()
	s.handleProxyYaml(w4, req4)
	if w4.Code != http.StatusNotFound {
		t.Errorf("Expected 404 for non-existent proxy, got %d", w4.Code)
	}
}

func TestKVMEnvResolution(t *testing.T) {
	tmpDir := t.TempDir()
	mapsDir := filepath.Join(tmpDir, "maps")
	if err := os.MkdirAll(mapsDir, 0755); err != nil {
		t.Fatalf("Failed to create temp maps dir: %v", err)
	}
	productsDir := filepath.Join(tmpDir, "products")
	if err := os.MkdirAll(productsDir, 0755); err != nil {
		t.Fatalf("Failed to create temp products dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(productsDir, "products.json"), []byte("[]"), 0644); err != nil {
		t.Fatalf("Failed to write dummy products.json: %v", err)
	}

	// Set test environment variables
	t.Setenv("CLOUD_RUN_OPENAI_KEY", "sk-proj-test123456789")
	t.Setenv("CLOUD_RUN_ANTHROPIC_KEY", "sk-ant-test987654321")
	t.Setenv("CLOUD_RUN_MODEL_TOKEN", "bearer-token-xyz")
	t.Setenv("CLOUD_RUN_ARRAY_VAR", "array-replacement-value")

	initialKVM := `[
  {
    "name": "AI-Config",
    "scope": "environment",
    "environment": "test",
    "entries": {
      "OpenAIKey": "env.{CLOUD_RUN_OPENAI_KEY}",
      "AnthropicKey": "env.CLOUD_RUN_ANTHROPIC_KEY",
      "ModelRouting": "{\"token\": \"env.{CLOUD_RUN_MODEL_TOKEN}\"}",
      "UnsetKey": "env.{NOT_SET_VAR_123}",
      "StaticKey": "static-value-123"
    }
  },
  {
    "name": "ArrayMap",
    "scope": "environment",
    "entries": [
      {
        "name": "SecretKey",
        "value": "env.{CLOUD_RUN_ARRAY_VAR}"
      }
    ]
  }
]`

	mapsFilePath := filepath.Join(mapsDir, "maps.json")
	if err := os.WriteFile(mapsFilePath, []byte(initialKVM), 0644); err != nil {
		t.Fatalf("Failed to write initial maps.json: %v", err)
	}

	bm := NewBundleManager(tmpDir, tmpDir)

	// 1. Test ResolveKVMEnvVars
	resolvedBytes, err := bm.ResolveKVMEnvVars()
	if err != nil {
		t.Fatalf("ResolveKVMEnvVars failed: %v", err)
	}

	resolvedStr := string(resolvedBytes)

	// Check that values are replaced and NO "{}" remains around the replaced values
	if !strings.Contains(resolvedStr, "sk-proj-test123456789") {
		t.Errorf("Expected resolved string to contain OpenAI key, got: %s", resolvedStr)
	}
	if strings.Contains(resolvedStr, "env.{CLOUD_RUN_OPENAI_KEY}") {
		t.Errorf("Resolved string still contains env.{CLOUD_RUN_OPENAI_KEY}")
	}
	if strings.Contains(resolvedStr, "{sk-proj-test123456789}") {
		t.Errorf("Resolved string contains brackets around replaced value: %s", resolvedStr)
	}

	if !strings.Contains(resolvedStr, "sk-ant-test987654321") {
		t.Errorf("Expected resolved string to contain Anthropic key, got: %s", resolvedStr)
	}
	if strings.Contains(resolvedStr, "env.CLOUD_RUN_ANTHROPIC_KEY") {
		t.Errorf("Resolved string still contains env.CLOUD_RUN_ANTHROPIC_KEY")
	}

	if !strings.Contains(resolvedStr, "bearer-token-xyz") {
		t.Errorf("Expected resolved string to contain embedded model token, got: %s", resolvedStr)
	}

	if !strings.Contains(resolvedStr, "array-replacement-value") {
		t.Errorf("Expected array entry to contain resolved value, got: %s", resolvedStr)
	}

	if !strings.Contains(resolvedStr, "static-value-123") {
		t.Errorf("Expected static value to be preserved, got: %s", resolvedStr)
	}

	// 2. Check that the KVM JSON file ON DISK was updated
	diskBytes, err := os.ReadFile(mapsFilePath)
	if err != nil {
		t.Fatalf("Failed to read updated maps.json from disk: %v", err)
	}
	if string(diskBytes) != resolvedStr {
		t.Errorf("Disk file content does not match resolved output")
	}

	// 3. Test GetMaps returns resolved entries
	maps, err := bm.GetMaps()
	if err != nil {
		t.Fatalf("GetMaps failed: %v", err)
	}
	if len(maps) != 2 {
		t.Fatalf("Expected 2 maps, got %d", len(maps))
	}
	aiConfigEntries, ok := maps[0]["entries"].(map[string]interface{})
	if !ok {
		t.Fatalf("Expected entries map in first map, got: %+v", maps[0])
	}
	if aiConfigEntries["OpenAIKey"] != "sk-proj-test123456789" {
		t.Errorf("Expected OpenAIKey to be resolved in GetMaps, got: %v", aiConfigEntries["OpenAIKey"])
	}
	if aiConfigEntries["UnsetKey"] != "" {
		t.Errorf("Expected UnsetKey to resolve to empty string, got: %v", aiConfigEntries["UnsetKey"])
	}

	// 4. Test BuildTestDataBundle packages the resolved maps.json
	testDataZip, err := bm.BuildTestDataBundle([]string{})
	if err != nil {
		t.Fatalf("BuildTestDataBundle failed: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(testDataZip), int64(len(testDataZip)))
	if err != nil {
		t.Fatalf("Failed to open testdata.zip: %v", err)
	}
	var mapsZipContent string
	for _, zf := range zr.File {
		if zf.Name == "maps.json" {
			rc, err := zf.Open()
			if err != nil {
				t.Fatalf("Failed to open maps.json in zip: %v", err)
			}
			b, _ := io.ReadAll(rc)
			rc.Close()
			mapsZipContent = string(b)
			break
		}
	}
	if mapsZipContent == "" {
		t.Fatalf("maps.json not found in testdata.zip")
	}
	if !strings.Contains(mapsZipContent, "sk-proj-test123456789") {
		t.Errorf("Expected testdata.zip maps.json to contain resolved OpenAI key, got: %s", mapsZipContent)
	}
}

func TestDeploymentParameterResolution(t *testing.T) {
	t.Setenv("GOOGLE_CLOUD_PROJECT", "test-gcp-project-123")
	t.Setenv("GOOGLE_CLOUD_LOCATION", "europe-west1")
	t.Setenv("CUSTOM_ENV_VAR", "custom-value-xyz")

	rawYAML := `name: deployment-test
parameters:
  - name: GoogleCloudProject
    default: "{GOOGLE_CLOUD_PROJECT}"
  - name: ExtraParam
    default: "{CUSTOM_ENV_VAR}"
proxies:
  - name: TestProxy
    description: "Running in {GOOGLE_CLOUD_PROJECT} ({GOOGLE_CLOUD_LOCATION})"
`

	resolved := SubstituteDeploymentEnvPlaceholders(rawYAML)
	if !strings.Contains(resolved, `default: "test-gcp-project-123"`) {
		t.Errorf("Expected GoogleCloudProject default to resolve to test-gcp-project-123, got: %s", resolved)
	}
	if !strings.Contains(resolved, `default: "custom-value-xyz"`) {
		t.Errorf("Expected ExtraParam default to resolve to custom-value-xyz, got: %s", resolved)
	}
	if !strings.Contains(resolved, `description: "Running in test-gcp-project-123 (europe-west1)"`) {
		t.Errorf("Expected description to resolve to test-gcp-project-123 (europe-west1), got: %s", resolved)
	}

	// Verify {project} is NOT replaced
	unsupportedYAML := `description: "Running in {project}"`
	resolvedUnsupported := SubstituteDeploymentEnvPlaceholders(unsupportedYAML)
	if strings.Contains(resolvedUnsupported, "test-gcp-project-123") {
		t.Errorf("Expected {project} NOT to be replaced, got: %s", resolvedUnsupported)
	}

	// Test ListDeployments file reading and auto-update
	tmpDir := t.TempDir()
	depDir := filepath.Join(tmpDir, "deployments")
	if err := os.MkdirAll(depDir, 0755); err != nil {
		t.Fatalf("Failed to create deployments dir: %v", err)
	}
	depFile := filepath.Join(depDir, "test-dep.yaml")
	if err := os.WriteFile(depFile, []byte(rawYAML), 0644); err != nil {
		t.Fatalf("Failed to write dep file: %v", err)
	}

	dm := NewDeploymentManager(tmpDir)
	deps, err := dm.ListDeployments()
	if err != nil {
		t.Fatalf("ListDeployments failed: %v", err)
	}
	if len(deps) != 1 {
		t.Fatalf("Expected 1 deployment, got %d", len(deps))
	}

	// Verify file on disk remained clean (unmodified)
	diskBytes, err := os.ReadFile(depFile)
	if err != nil {
		t.Fatalf("Failed to read dep file: %v", err)
	}
	if string(diskBytes) != rawYAML {
		t.Errorf("Expected deployment file on disk to remain clean and unmodified, but it was changed:\n%s", string(diskBytes))
	}
}

func TestWarmupFirstTestPerProxy(t *testing.T) {
	// Set up mock emulator runtime server
	executedRequests := make(map[string]int)
	var reqMu sync.Mutex

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqMu.Lock()
		executedRequests[r.URL.Path]++
		reqMu.Unlock()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer mockServer.Close()

	// Set up temporary deployments directory with tests
	tmpDir := t.TempDir()
	depDir := filepath.Join(tmpDir, "deployments")
	_ = os.MkdirAll(depDir, 0755)

	depYAML := `
name: warmup-deployment
tests:
  - name: test1-for-proxy-a
    proxy: ProxyA
    path: /proxy-a/test1
    method: GET
  - name: test2-for-proxy-a
    proxy: ProxyA
    path: /proxy-a/test2
    method: POST
  - name: test1-for-proxy-b
    proxy: ProxyB
    path: /proxy-b/test1
    method: GET
`
	_ = os.WriteFile(filepath.Join(depDir, "dep.yaml"), []byte(depYAML), 0644)

	client := NewEmulatorClient(mockServer.URL, mockServer.URL)
	s := &Server{
		EmulatorClient:    client,
		DeploymentManager: NewDeploymentManager(tmpDir),
		ProxyTester:       NewProxyTester(client),
		TestHistory:       NewTestHistoryManager(100),
	}

	// Run warmup directly
	s.warmupFirstTestPerProxy()

	// Verify that the first test of ProxyA and ProxyB were executed
	reqMu.Lock()
	countA1 := executedRequests["/proxy-a/test1"]
	countA2 := executedRequests["/proxy-a/test2"]
	countB1 := executedRequests["/proxy-b/test1"]
	reqMu.Unlock()

	if countA1 != 1 {
		t.Errorf("Expected exactly 1 request to /proxy-a/test1 (first test for ProxyA), got %d", countA1)
	}
	if countA2 != 0 {
		t.Errorf("Expected 0 requests to /proxy-a/test2 (subsequent test for ProxyA), got %d", countA2)
	}
	if countB1 != 1 {
		t.Errorf("Expected exactly 1 request to /proxy-b/test1 (first test for ProxyB), got %d", countB1)
	}

	// Verify TestHistory was NOT polluted (silent execution)
	if history := s.TestHistory.GetHistory(""); len(history) != 0 {
		t.Errorf("Expected 0 records in TestHistory for silent warmup, got %d", len(history))
	}
}

func TestHandleTestsWarmupEndpoint(t *testing.T) {
	s := &Server{
		DeploymentManager: NewDeploymentManager(t.TempDir()),
	}

	req := httptest.NewRequest(http.MethodPost, "/tester/api/tests/warmup", nil)
	w := httptest.NewRecorder()
	s.handleTestsWarmup(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status OK, got %d", w.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}

	if resp["status"] != "warmup_started" {
		t.Errorf("Expected status 'warmup_started', got %v", resp["status"])
	}
}



