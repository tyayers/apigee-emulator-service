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
		Body: `{"model":"google/gemini-3.8-flash","choices":[{"message":{"content":"Hello"}}]`,
		TraceData: map[string]interface{}{
			"error": false,
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
		assertion string
		expectPass bool
	}{
		{"status.code == 200", true},
		{"status.code != 400", true},
		{"status.code == 404", false},
		{"response.status.code >= 200", true},
		{"duration < 1000", true},
		{"duration > 500", false},
		{"headers.content-type contains json", true},
		{"headers['x-request-id'] == req-12345", true},
		{"body contains gemini-3.8-flash", true},
		{"trace.error == false", true},
		{"trace.steps contains Step-VerifyAPIKey", true},
	}

	for _, tc := range tests {
		res := EvaluateAssertion(tc.assertion, resp)
		if res.Passed != tc.expectPass {
			t.Errorf("Assertion %q: expected passed=%v, got %v (actual=%q, error=%q)",
				tc.assertion, tc.expectPass, res.Passed, res.Actual, res.Error)
		}
	}
}

func TestTestHistoryManager(t *testing.T) {
	thm := NewTestHistoryManager(10)

	thm.Record(TestRunResult{
		TestName: "test-completions",
		Proxy:    "REST-AI-Completions",
		Passed:   true,
	})
	thm.Record(TestRunResult{
		TestName: "test-messages",
		Proxy:    "REST-AI-Messages",
		Passed:   false,
	})
	thm.Record(TestRunResult{
		TestName: "test-completions-2",
		Proxy:    "REST-AI-Completions",
		Passed:   true,
	})

	allRuns := thm.GetHistory("")
	if len(allRuns) != 3 {
		t.Fatalf("Expected 3 runs, got %d", len(allRuns))
	}

	compRuns := thm.GetHistory("REST-AI-Completions")
	if len(compRuns) != 2 {
		t.Fatalf("Expected 2 runs for completions, got %d", len(compRuns))
	}

	thm.Clear("REST-AI-Completions")
	compRunsAfter := thm.GetHistory("REST-AI-Completions")
	if len(compRunsAfter) != 0 {
		t.Fatalf("Expected 0 runs after clear, got %d", len(compRunsAfter))
	}

	msgRuns := thm.GetHistory("REST-AI-Messages")
	if len(msgRuns) != 1 {
		t.Fatalf("Expected 1 run for messages after clearing completions, got %d", len(msgRuns))
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


