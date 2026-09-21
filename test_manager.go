package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TestHistoryManager manages in-memory test run history.
type TestHistoryManager struct {
	mu      sync.RWMutex
	runs    []TestRunResult
	maxRuns int
}

// NewTestHistoryManager creates a new in-memory test history manager.
func NewTestHistoryManager(maxRuns int) *TestHistoryManager {
	if maxRuns <= 0 {
		maxRuns = 300
	}
	return &TestHistoryManager{
		runs:    make([]TestRunResult, 0),
		maxRuns: maxRuns,
	}
}

// Record saves a test run result in memory (newest first).
func (thm *TestHistoryManager) Record(run TestRunResult) TestRunResult {
	thm.mu.Lock()
	defer thm.mu.Unlock()

	if run.ID == "" {
		run.ID = fmt.Sprintf("run_%d", time.Now().UnixNano())
	}
	if run.Timestamp.IsZero() {
		run.Timestamp = time.Now()
	}

	// Insert at the front (reverse chronological)
	thm.runs = append([]TestRunResult{run}, thm.runs...)
	if len(thm.runs) > thm.maxRuns {
		thm.runs = thm.runs[:thm.maxRuns]
	}

	return run
}

// GetHistory returns test runs, optionally filtered by proxy name.
func (thm *TestHistoryManager) GetHistory(proxy string) []TestRunResult {
	thm.mu.RLock()
	defer thm.mu.RUnlock()

	trimmed := strings.TrimSpace(proxy)
	if trimmed == "" {
		res := make([]TestRunResult, len(thm.runs))
		copy(res, thm.runs)
		return res
	}

	var res []TestRunResult
	for _, run := range thm.runs {
		if strings.EqualFold(run.Proxy, trimmed) {
			res = append(res, run)
		}
	}
	return res
}

// GetRun returns a specific test run by ID.
func (thm *TestHistoryManager) GetRun(id string) *TestRunResult {
	thm.mu.RLock()
	defer thm.mu.RUnlock()

	for _, run := range thm.runs {
		if run.ID == id {
			cp := run
			return &cp
		}
	}
	return nil
}

// Clear removes test runs (all or for a specific proxy).
func (thm *TestHistoryManager) Clear(proxy string) {
	thm.mu.Lock()
	defer thm.mu.Unlock()

	trimmed := strings.TrimSpace(proxy)
	if trimmed == "" {
		thm.runs = make([]TestRunResult, 0)
		return
	}

	var remaining []TestRunResult
	for _, run := range thm.runs {
		if !strings.EqualFold(run.Proxy, trimmed) {
			remaining = append(remaining, run)
		}
	}
	thm.runs = remaining
}

// EvaluateAssertions evaluates a slice of assertion expressions against a test response.
func EvaluateAssertions(assertions []string, resp *TestResponse) []AssertionResult {
	var results []AssertionResult
	for _, assertion := range assertions {
		a := strings.TrimSpace(assertion)
		if a == "" {
			continue
		}
		res := EvaluateAssertion(a, resp)
		results = append(results, res)
	}
	return results
}

// EvaluateAssertion evaluates a single assertion expression against a test response.
func EvaluateAssertion(assertion string, resp *TestResponse) AssertionResult {
	res := AssertionResult{
		Assertion: assertion,
		Passed:    false,
	}

	if resp == nil {
		res.Actual = "No response"
		res.Expected = assertion
		res.Error = "response was nil"
		return res
	}

	// Supported operators in order of evaluation (check "not contains" before "contains")
	ops := []string{"not contains", "contains", "!=", "==", ">=", "<=", ">", "<"}
	var op, left, right string

	for _, candidate := range ops {
		idx := strings.Index(strings.ToLower(assertion), candidate)
		if idx != -1 {
			op = candidate
			left = strings.TrimSpace(assertion[:idx])
			right = strings.TrimSpace(assertion[idx+len(candidate):])
			break
		}
	}

	// If no operator found, check if it's just a status code like "200" or "status.code"
	if op == "" {
		trimmed := strings.TrimSpace(assertion)
		if _, err := strconv.Atoi(trimmed); err == nil {
			op = "=="
			left = "status.code"
			right = trimmed
		} else {
			op = "=="
			left = trimmed
			right = "true"
		}
	}

	// Strip optional quotes around right side
	cleanRight := strings.Trim(right, `"'`)
	res.Expected = cleanRight

	leftLower := strings.ToLower(left)

	// 1. Status Code assertions: status.code, status, response.status.code
	if strings.Contains(leftLower, "status") {
		actualCode := resp.StatusCode
		res.Actual = strconv.Itoa(actualCode)

		expectedCode, err := strconv.Atoi(cleanRight)
		if err != nil {
			res.Error = fmt.Sprintf("invalid status code expected value: %s", cleanRight)
			return res
		}

		switch op {
		case "==":
			res.Passed = (actualCode == expectedCode)
		case "!=":
			res.Passed = (actualCode != expectedCode)
		case ">=":
			res.Passed = (actualCode >= expectedCode)
		case "<=":
			res.Passed = (actualCode <= expectedCode)
		case ">":
			res.Passed = (actualCode > expectedCode)
		case "<":
			res.Passed = (actualCode < expectedCode)
		default:
			res.Error = fmt.Sprintf("unsupported operator %q for status code", op)
		}
		return res
	}

	// 2. Duration assertions: duration, durationMs, response.time
	if strings.Contains(leftLower, "duration") || strings.Contains(leftLower, "latency") || strings.Contains(leftLower, "time") {
		res.Actual = fmt.Sprintf("%dms", resp.DurationMs)
		expectedDur, err := strconv.ParseInt(cleanRight, 10, 64)
		if err != nil {
			res.Error = fmt.Sprintf("invalid duration expected value: %s", cleanRight)
			return res
		}

		switch op {
		case "==":
			res.Passed = (resp.DurationMs == expectedDur)
		case "!=":
			res.Passed = (resp.DurationMs != expectedDur)
		case ">=":
			res.Passed = (resp.DurationMs >= expectedDur)
		case "<=":
			res.Passed = (resp.DurationMs <= expectedDur)
		case ">":
			res.Passed = (resp.DurationMs > expectedDur)
		case "<":
			res.Passed = (resp.DurationMs < expectedDur)
		default:
			res.Error = fmt.Sprintf("unsupported operator %q for duration", op)
		}
		return res
	}

	// 3. Trace assertions: trace.error, trace.hasErrors, trace.steps, trace.transactions
	if strings.HasPrefix(leftLower, "trace") {
		if strings.Contains(leftLower, "error") {
			hasErr := traceHasErrors(resp.TraceData)
			res.Actual = strconv.FormatBool(hasErr)
			expectedBool, _ := strconv.ParseBool(cleanRight)
			if op == "==" {
				res.Passed = (hasErr == expectedBool)
			} else if op == "!=" {
				res.Passed = (hasErr != expectedBool)
			}
			return res
		}

		if strings.Contains(leftLower, "step") || strings.Contains(leftLower, "policy") {
			steps := extractTraceSteps(resp.TraceData)
			res.Actual = strings.Join(steps, ", ")
			contains := sliceContainsCaseInsensitive(steps, cleanRight)
			if op == "contains" {
				res.Passed = contains
			} else if op == "not contains" {
				res.Passed = !contains
			} else if op == "==" {
				res.Passed = strings.EqualFold(res.Actual, cleanRight)
			}
			return res
		}

		// Generic trace inspection (e.g. flow variable or raw string)
		traceStr := ""
		if resp.TraceData != nil {
			b, _ := json.Marshal(resp.TraceData)
			traceStr = string(b)
		}
		res.Actual = fmt.Sprintf("%d bytes trace data", len(traceStr))
		contains := strings.Contains(strings.ToLower(traceStr), strings.ToLower(cleanRight))
		if op == "contains" {
			res.Passed = contains
		} else if op == "not contains" {
			res.Passed = !contains
		} else {
			res.Passed = contains
		}
		return res
	}

	// 4. Header assertions: header.content-type, headers['content-type'], headers.x-api-key
	if strings.HasPrefix(leftLower, "header") {
		headerName := extractHeaderName(left)
		actualVal := getHeaderCaseInsensitive(resp.Headers, headerName)
		res.Actual = actualVal

		switch op {
		case "==":
			res.Passed = strings.EqualFold(actualVal, cleanRight)
		case "!=":
			res.Passed = !strings.EqualFold(actualVal, cleanRight)
		case "contains":
			res.Passed = strings.Contains(strings.ToLower(actualVal), strings.ToLower(cleanRight))
		case "not contains":
			res.Passed = !strings.Contains(strings.ToLower(actualVal), strings.ToLower(cleanRight))
		default:
			res.Error = fmt.Sprintf("unsupported operator %q for headers", op)
		}
		return res
	}

	// 5. Body assertions: body, response.body, body.<json_field>
	if strings.HasPrefix(leftLower, "body") || strings.HasPrefix(leftLower, "response.body") {
		// Check for nested json field: e.g. body.model or response.body.status
		field := extractBodyField(left)
		if field != "" {
			actualFieldVal := extractJSONField(resp.Body, field)
			res.Actual = actualFieldVal
			if op == "==" {
				res.Passed = strings.EqualFold(actualFieldVal, cleanRight)
			} else if op == "!=" {
				res.Passed = !strings.EqualFold(actualFieldVal, cleanRight)
			} else if op == "contains" {
				res.Passed = strings.Contains(strings.ToLower(actualFieldVal), strings.ToLower(cleanRight))
			} else if op == "not contains" {
				res.Passed = !strings.Contains(strings.ToLower(actualFieldVal), strings.ToLower(cleanRight))
			}
			return res
		}

		res.Actual = truncateStr(resp.Body, 120)
		contains := strings.Contains(strings.ToLower(resp.Body), strings.ToLower(cleanRight))
		switch op {
		case "contains":
			res.Passed = contains
		case "not contains":
			res.Passed = !contains
		case "==":
			res.Passed = (strings.TrimSpace(resp.Body) == cleanRight)
		case "!=":
			res.Passed = (strings.TrimSpace(resp.Body) != cleanRight)
		default:
			res.Error = fmt.Sprintf("unsupported operator %q for body", op)
		}
		return res
	}

	// Default fallback: check if response body or trace contains expected string
	bodyContains := strings.Contains(strings.ToLower(resp.Body), strings.ToLower(cleanRight))
	res.Actual = truncateStr(resp.Body, 80)
	if op == "not contains" {
		res.Passed = !bodyContains
	} else {
		res.Passed = bodyContains
	}

	return res
}

func traceHasErrors(traceData map[string]interface{}) bool {
	if traceData == nil {
		return false
	}

	// Check top-level error
	if errVal, ok := traceData["error"]; ok && errVal != nil {
		if b, ok := errVal.(bool); ok && b {
			return true
		}
	}

	// Check transactions
	if txs, ok := traceData["transactions"].([]interface{}); ok {
		for _, txItem := range txs {
			if txMap, ok := txItem.(map[string]interface{}); ok {
				if errVal, ok := txMap["error"].(bool); ok && errVal {
					return true
				}
				// Check execution steps / points
				if pts, ok := txMap["point"].([]interface{}); ok {
					for _, ptItem := range pts {
						if ptMap, ok := ptItem.(map[string]interface{}); ok {
							if errVal, ok := ptMap["error"].(bool); ok && errVal {
								return true
							}
						}
					}
				}
			}
		}
	}

	return false
}

func extractTraceSteps(traceData map[string]interface{}) []string {
	var steps []string
	if traceData == nil {
		return steps
	}

	if txs, ok := traceData["transactions"].([]interface{}); ok {
		for _, txItem := range txs {
			if txMap, ok := txItem.(map[string]interface{}); ok {
				if pts, ok := txMap["point"].([]interface{}); ok {
					for _, ptItem := range pts {
						if ptMap, ok := ptItem.(map[string]interface{}); ok {
							if id, ok := ptMap["id"].(string); ok && id != "" {
								steps = append(steps, id)
							}
						}
					}
				}
			}
		}
	}

	return steps
}

func extractHeaderName(expr string) string {
	// Handles: header.content-type, header['content-type'], headers["x-api-key"]
	expr = strings.TrimPrefix(expr, "headers")
	expr = strings.TrimPrefix(expr, "header")
	expr = strings.Trim(expr, "[]'\" .")
	return expr
}

func getHeaderCaseInsensitive(headers map[string]string, name string) string {
	for k, v := range headers {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

func extractBodyField(expr string) string {
	expr = strings.TrimPrefix(expr, "response.")
	expr = strings.TrimPrefix(expr, "body.")
	if expr != "body" && expr != "" {
		return expr
	}
	return ""
}

func extractJSONField(body string, field string) string {
	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return ""
	}

	parts := strings.Split(field, ".")
	var current interface{} = parsed
	for _, part := range parts {
		if m, ok := current.(map[string]interface{}); ok {
			current = m[part]
		} else {
			return ""
		}
	}

	if current == nil {
		return ""
	}
	return fmt.Sprintf("%v", current)
}

func sliceContainsCaseInsensitive(slice []string, val string) bool {
	for _, item := range slice {
		if strings.EqualFold(item, val) || strings.Contains(strings.ToLower(item), strings.ToLower(val)) {
			return true
		}
	}
	return false
}

func truncateStr(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
