package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	resp := &TestResponse{
		StatusCode: 200,
		StatusText: "200 OK",
		DurationMs: 150,
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


