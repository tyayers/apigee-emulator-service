package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
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
	for _, rawAssertion := range assertions {
		lines := strings.Split(rawAssertion, "\n")
		for _, line := range lines {
			parts := splitAssertions(line)
			for _, part := range parts {
				a := cleanAssertionString(part)
				if a == "" {
					continue
				}
				res := EvaluateAssertion(a, resp)
				results = append(results, res)
			}
		}
	}
	return results
}

// EvaluateAssertion evaluates a single assertion expression against a test response.
func EvaluateAssertion(assertion string, resp *TestResponse) AssertionResult {
	cleaned := cleanAssertionString(assertion)
	res := AssertionResult{
		Assertion: cleaned,
		Passed:    false,
	}

	if resp == nil {
		res.Actual = "No response"
		res.Expected = cleaned
		res.Error = "response was nil"
		return res
	}

	lower := strings.ToLower(cleaned)
	var op, left, right string

	// 1. Unary / Suffix operators (exists, not exists)
	if strings.HasSuffix(lower, " not exists") || strings.HasSuffix(lower, " not exist") {
		op = "not exists"
		sufLen := len(" not exists")
		if strings.HasSuffix(lower, " not exist") {
			sufLen = len(" not exist")
		}
		left = strings.TrimSpace(cleaned[:len(cleaned)-sufLen])
		right = ""
	} else if strings.HasSuffix(lower, " exists") || strings.HasSuffix(lower, " exist") {
		op = "exists"
		sufLen := len(" exists")
		if strings.HasSuffix(lower, " exist") {
			sufLen = len(" exist")
		}
		left = strings.TrimSpace(cleaned[:len(cleaned)-sufLen])
		right = ""
	}

	// 2. Binary word operators
	if op == "" {
		wordOps := []string{
			"not contains",
			"contains",
			"startswith",
			"endswith",
			"matches",
		}
		for _, wOp := range wordOps {
			pattern := " " + wOp + " "
			idx := strings.Index(lower, pattern)
			if idx != -1 {
				op = wOp
				left = strings.TrimSpace(cleaned[:idx])
				right = strings.TrimSpace(cleaned[idx+len(pattern):])
				break
			}
		}
	}

	// 3. Binary symbol operators
	if op == "" {
		symbolOps := []string{"!=", "==", ">=", "<=", ">", "<"}
		for _, sOp := range symbolOps {
			idx := strings.Index(lower, sOp)
			if idx != -1 {
				op = sOp
				left = strings.TrimSpace(cleaned[:idx])
				right = strings.TrimSpace(cleaned[idx+len(sOp):])
				break
			}
		}
	}

	// 4. Fallback default
	if op == "" {
		if _, err := strconv.Atoi(cleaned); err == nil {
			op = "=="
			left = "status.code"
			right = cleaned
		} else {
			op = "=="
			left = cleaned
			right = "true"
		}
	}

	// Clean right operand
	cleanRight := strings.TrimSpace(right)
	if op == "matches" {
		if strings.HasPrefix(cleanRight, "/") && strings.HasSuffix(cleanRight, "/") && len(cleanRight) >= 2 {
			cleanRight = cleanRight[1 : len(cleanRight)-1]
		} else {
			cleanRight = strings.Trim(cleanRight, `"'`)
		}
	} else {
		cleanRight = strings.Trim(cleanRight, `"'`)
	}

	if op == "exists" {
		res.Expected = "exists"
	} else if op == "not exists" {
		res.Expected = "not exists"
	} else {
		res.Expected = cleanRight
	}

	// Resolve target actual value
	actual, targetFound := resolveAssertionTarget(left, resp)
	res.Actual = truncateStr(actual, 120)

	// Evaluate operator
	switch op {
	case "exists":
		res.Passed = targetFound && strings.TrimSpace(actual) != ""
		if !res.Passed {
			res.Actual = "not found / empty"
		}

	case "not exists":
		res.Passed = !targetFound || strings.TrimSpace(actual) == ""
		if res.Passed {
			res.Actual = "not exists"
		}

	case "startswith":
		res.Passed = strings.HasPrefix(actual, cleanRight) || strings.HasPrefix(strings.ToLower(actual), strings.ToLower(cleanRight))

	case "endswith":
		res.Passed = strings.HasSuffix(actual, cleanRight) || strings.HasSuffix(strings.ToLower(actual), strings.ToLower(cleanRight))

	case "matches":
		re, err := regexp.Compile(cleanRight)
		if err != nil {
			res.Error = fmt.Sprintf("invalid regex pattern: %s (%v)", cleanRight, err)
			return res
		}
		res.Passed = re.MatchString(actual)

	case "contains":
		if strings.HasPrefix(strings.ToLower(left), "trace.step") {
			steps := extractTraceSteps(resp.TraceData)
			res.Passed = sliceContainsCaseInsensitive(steps, cleanRight)
		} else {
			res.Passed = strings.Contains(strings.ToLower(actual), strings.ToLower(cleanRight))
		}

	case "not contains":
		if strings.HasPrefix(strings.ToLower(left), "trace.step") {
			steps := extractTraceSteps(resp.TraceData)
			res.Passed = !sliceContainsCaseInsensitive(steps, cleanRight)
		} else {
			res.Passed = !strings.Contains(strings.ToLower(actual), strings.ToLower(cleanRight))
		}

	case "==":
		n1, err1 := strconv.ParseFloat(actual, 64)
		n2, err2 := strconv.ParseFloat(cleanRight, 64)
		if err1 == nil && err2 == nil {
			res.Passed = (n1 == n2)
			return res
		}

		b1, errB1 := strconv.ParseBool(actual)
		b2, errB2 := strconv.ParseBool(cleanRight)
		if errB1 == nil && errB2 == nil {
			res.Passed = (b1 == b2)
			return res
		}

		res.Passed = strings.EqualFold(actual, cleanRight) || (strings.TrimSpace(actual) == cleanRight)

	case "!=":
		n1, err1 := strconv.ParseFloat(actual, 64)
		n2, err2 := strconv.ParseFloat(cleanRight, 64)
		if err1 == nil && err2 == nil {
			res.Passed = (n1 != n2)
			return res
		}

		b1, errB1 := strconv.ParseBool(actual)
		b2, errB2 := strconv.ParseBool(cleanRight)
		if errB1 == nil && errB2 == nil {
			res.Passed = (b1 != b2)
			return res
		}

		res.Passed = !strings.EqualFold(actual, cleanRight) && (strings.TrimSpace(actual) != cleanRight)

	case ">=", "<=", ">", "<":
		n1, err1 := strconv.ParseFloat(actual, 64)
		n2, err2 := strconv.ParseFloat(cleanRight, 64)
		if err1 != nil || err2 != nil {
			res.Error = fmt.Sprintf("cannot compare non-numeric values %q and %q with %s", actual, cleanRight, op)
			return res
		}
		switch op {
		case ">=":
			res.Passed = (n1 >= n2)
		case "<=":
			res.Passed = (n1 <= n2)
		case ">":
			res.Passed = (n1 > n2)
		case "<":
			res.Passed = (n1 < n2)
		}

	default:
		res.Error = fmt.Sprintf("unsupported operator %q", op)
	}

	return res
}

func cleanAssertionString(assertion string) string {
	trimmed := strings.TrimSpace(assertion)
	inQuote := false
	var quoteChar rune
	for i, r := range trimmed {
		if !inQuote && (r == '"' || r == '\'') {
			inQuote = true
			quoteChar = r
		} else if inQuote && r == quoteChar {
			inQuote = false
		} else if !inQuote {
			if r == '#' {
				return strings.TrimSpace(trimmed[:i])
			}
			if r == '/' && i+1 < len(trimmed) && trimmed[i+1] == '/' {
				return strings.TrimSpace(trimmed[:i])
			}
		}
	}
	return trimmed
}

func splitAssertions(s string) []string {
	var parts []string
	var current strings.Builder
	inQuote := false
	var quoteChar rune
	for _, r := range s {
		if !inQuote && (r == '"' || r == '\'') {
			inQuote = true
			quoteChar = r
			current.WriteRune(r)
		} else if inQuote && r == quoteChar {
			inQuote = false
			current.WriteRune(r)
		} else if !inQuote && r == ',' {
			p := strings.TrimSpace(current.String())
			if p != "" {
				parts = append(parts, p)
			}
			current.Reset()
		} else {
			current.WriteRune(r)
		}
	}
	if p := strings.TrimSpace(current.String()); p != "" {
		parts = append(parts, p)
	}
	return parts
}

func resolveAssertionTarget(left string, resp *TestResponse) (string, bool) {
	if resp == nil {
		return "", false
	}

	leftTrimmed := strings.TrimSpace(left)
	leftLower := strings.ToLower(leftTrimmed)

	// 1. Status assertions
	if leftLower == "status" || leftLower == "response.status" || leftLower == "status.code" || leftLower == "response.status.code" {
		return strconv.Itoa(resp.StatusCode), true
	}

	// 2. Duration / Latency assertions
	if leftLower == "duration" || leftLower == "durationms" || leftLower == "response.time" || leftLower == "response.duration" || leftLower == "total.latency" || leftLower == "totallatency" {
		return strconv.FormatInt(resp.DurationMs, 10), true
	}
	if leftLower == "targetlatency" || leftLower == "target.latency" || leftLower == "targetlatencyms" || leftLower == "target_latency" {
		if resp.TargetLatencyMs != nil {
			return strconv.FormatInt(*resp.TargetLatencyMs, 10), true
		}
		return "0", true
	}
	if leftLower == "proxylatency" || leftLower == "proxy.latency" || leftLower == "proxylatencyms" || leftLower == "proxy_latency" {
		proxyLat := resp.DurationMs
		if resp.TargetLatencyMs != nil {
			proxyLat = resp.DurationMs - *resp.TargetLatencyMs
			if proxyLat < 0 {
				proxyLat = 0
			}
		}
		return strconv.FormatInt(proxyLat, 10), true
	}

	// 3. Flow/Trace Variables (var.ext1, variable.ext1, variables.ext1, flow.ext1)
	if strings.HasPrefix(leftLower, "var.") || strings.HasPrefix(leftLower, "variable.") || strings.HasPrefix(leftLower, "variables.") || strings.HasPrefix(leftLower, "flow.") {
		traceVars := extractVariablesFromTrace(resp.TraceData)
		if val, ok := lookupVariable(leftTrimmed, traceVars); ok {
			return val, true
		}
		varName := leftTrimmed[strings.Index(leftTrimmed, ".")+1:]
		if resp.Request != nil {
			if h := getHeaderCaseInsensitive(resp.Request.Headers, varName); h != "" {
				return h, true
			}
			if p := extractPathParamOrQuery(resp.Request.Path, varName); p != "" {
				return p, true
			}
		}
		if h := getHeaderCaseInsensitive(resp.Headers, varName); h != "" {
			return h, true
		}
		return "", false
	}

	// 4. Request Path (request.path, request.path.id, path.id)
	if strings.HasPrefix(leftLower, "request.path") || strings.HasPrefix(leftLower, "path") {
		pathStr := ""
		if resp.Request != nil {
			pathStr = resp.Request.Path
		} else if resp.TraceData != nil {
			tVars := extractVariablesFromTrace(resp.TraceData)
			pathStr = tVars["request.path"]
			if pathStr == "" {
				pathStr = tVars["proxy.pathsuffix"]
			}
		}
		if leftLower == "request.path" || leftLower == "path" {
			return pathStr, pathStr != ""
		}
		field := leftTrimmed[strings.LastIndex(leftTrimmed, ".")+1:]
		val := extractPathParamOrQuery(pathStr, field)
		return val, val != ""
	}

	// 5. Request Headers (request.headers.Authorization, request.header.x-api-key)
	if strings.HasPrefix(leftLower, "request.headers") || strings.HasPrefix(leftLower, "request.header") {
		headerName := extractHeaderName(leftTrimmed)
		if resp.Request != nil {
			val := getHeaderCaseInsensitive(resp.Request.Headers, headerName)
			return val, val != ""
		} else if resp.TraceData != nil {
			tVars := extractVariablesFromTrace(resp.TraceData)
			val := tVars["request.header."+strings.ToLower(headerName)]
			return val, val != ""
		}
		return "", false
	}

	// 6. Response Headers (response.headers.Content-Type, header.content-type, headers.x-api-key)
	if strings.HasPrefix(leftLower, "response.headers") || strings.HasPrefix(leftLower, "response.header") ||
		strings.HasPrefix(leftLower, "headers") || strings.HasPrefix(leftLower, "header") {
		headerName := extractHeaderName(leftTrimmed)
		val := getHeaderCaseInsensitive(resp.Headers, headerName)
		if val != "" {
			return val, true
		}
		if resp.TraceData != nil {
			tVars := extractVariablesFromTrace(resp.TraceData)
			val := tVars["response.header."+strings.ToLower(headerName)]
			return val, val != ""
		}
		return "", false
	}

	// 7. Request Body (request.body.user.name, request.body.id, request.body)
	if strings.HasPrefix(leftLower, "request.body") {
		bodyStr := ""
		if resp.Request != nil {
			bodyStr = resp.Request.Body
		} else if resp.TraceData != nil {
			tVars := extractVariablesFromTrace(resp.TraceData)
			bodyStr = tVars["request.content"]
		}
		if leftLower == "request.body" {
			return bodyStr, bodyStr != ""
		}
		field := extractBodyField(leftTrimmed)
		val := extractJSONField(bodyStr, field)
		return val, val != ""
	}

	// 8. Response Body (response.body.user.name, response.body.id, response.body, body.user.name, body)
	if strings.HasPrefix(leftLower, "response.body") || strings.HasPrefix(leftLower, "body") {
		if leftLower == "response.body" || leftLower == "body" {
			return resp.Body, resp.Body != ""
		}
		field := extractBodyField(leftTrimmed)
		val := extractJSONField(resp.Body, field)
		return val, val != ""
	}

	// 9. Trace Assertions (trace.error, trace.steps, etc.)
	if strings.HasPrefix(leftLower, "trace.") {
		if strings.Contains(leftLower, "error") {
			hasErr := traceHasErrors(resp.TraceData)
			return strconv.FormatBool(hasErr), true
		}
		if strings.Contains(leftLower, "step") || strings.Contains(leftLower, "policy") {
			steps := extractTraceSteps(resp.TraceData)
			return strings.Join(steps, ", "), len(steps) > 0
		}
		b, _ := json.Marshal(resp.TraceData)
		return string(b), len(b) > 0
	}

	// 10. Fallback: check trace variables, body field, or raw body
	traceVars := extractVariablesFromTrace(resp.TraceData)
	if val, ok := lookupVariable(leftTrimmed, traceVars); ok {
		return val, true
	}
	if val := extractJSONField(resp.Body, leftTrimmed); val != "" {
		return val, true
	}
	return resp.Body, resp.Body != ""
}

func extractVariablesFromTrace(traceData map[string]interface{}) map[string]string {
	vars := make(map[string]string)
	if traceData == nil {
		return vars
	}

	// Direct variables map if provided
	if vMap, ok := traceData["variables"].(map[string]interface{}); ok {
		for k, v := range vMap {
			vars[k] = fmt.Sprintf("%v", v)
		}
	} else if vMap, ok := traceData["variables"].(map[string]string); ok {
		for k, v := range vMap {
			vars[k] = v
		}
	}

	var walk func(obj interface{})
	walk = func(obj interface{}) {
		if obj == nil {
			return
		}
		switch val := obj.(type) {
		case []interface{}:
			for _, item := range val {
				walk(item)
			}
		case map[string]interface{}:
			// 1. variableAccessList / VariableAccessMap / variables list
			for _, listKey := range []string{"variableAccessList", "VariableAccessMap", "variables"} {
				if list, ok := val[listKey].([]interface{}); ok {
					for _, v := range list {
						if vm, ok := v.(map[string]interface{}); ok {
							name := fmt.Sprintf("%v", vm["name"])
							if vVal, exists := vm["value"]; exists && name != "" && name != "<nil>" {
								vars[name] = fmt.Sprintf("%v", vVal)
							}
						}
					}
				}
			}

			// 2. accessList (Get / Set / access)
			if list, ok := val["accessList"].([]interface{}); ok {
				for _, item := range list {
					if im, ok := item.(map[string]interface{}); ok {
						for _, action := range []string{"Get", "Set", "access"} {
							if am, ok := im[action].(map[string]interface{}); ok {
								name := fmt.Sprintf("%v", am["name"])
								if vVal, exists := am["value"]; exists && name != "" && name != "<nil>" {
									vars[name] = fmt.Sprintf("%v", vVal)
								}
							}
						}
					}
				}
			}

			// 3. property / properties.property
			if props, ok := val["property"].([]interface{}); ok {
				for _, p := range props {
					if pm, ok := p.(map[string]interface{}); ok {
						name := fmt.Sprintf("%v", pm["name"])
						if vVal, exists := pm["value"]; exists && name != "" && name != "<nil>" {
							vars[name] = fmt.Sprintf("%v", vVal)
						}
					}
				}
			}
			if pObj, ok := val["properties"].(map[string]interface{}); ok {
				if props, ok := pObj["property"].([]interface{}); ok {
					for _, p := range props {
						if pm, ok := p.(map[string]interface{}); ok {
							name := fmt.Sprintf("%v", pm["name"])
							if vVal, exists := pm["value"]; exists && name != "" && name != "<nil>" {
								vars[name] = fmt.Sprintf("%v", vVal)
							}
						}
					}
				}
			}

			// Direct primitive properties
			for k, v := range val {
				switch vt := v.(type) {
				case string:
					vars[k] = vt
				case float64:
					if vt == float64(int64(vt)) {
						vars[k] = strconv.FormatInt(int64(vt), 10)
					} else {
						vars[k] = fmt.Sprintf("%v", vt)
					}
				case int:
					vars[k] = strconv.Itoa(vt)
				case int64:
					vars[k] = strconv.FormatInt(vt, 10)
				case bool:
					vars[k] = strconv.FormatBool(vt)
				case map[string]interface{}, []interface{}:
					walk(vt)
				}
			}
		}
	}

	walk(traceData)
	return vars
}

func lookupVariable(name string, vars map[string]string) (string, bool) {
	if val, ok := vars[name]; ok {
		return val, true
	}
	cleanName := strings.TrimPrefix(name, "var.")
	cleanName = strings.TrimPrefix(cleanName, "variable.")
	cleanName = strings.TrimPrefix(cleanName, "variables.")
	cleanName = strings.TrimPrefix(cleanName, "flow.")

	if val, ok := vars[cleanName]; ok {
		return val, true
	}
	if val, ok := vars["var."+cleanName]; ok {
		return val, true
	}
	if val, ok := vars["flow."+cleanName]; ok {
		return val, true
	}

	for k, v := range vars {
		kClean := strings.TrimPrefix(k, "var.")
		kClean = strings.TrimPrefix(kClean, "flow.")
		if strings.EqualFold(k, name) || strings.EqualFold(kClean, cleanName) {
			return v, true
		}
	}

	return "", false
}

func extractPathParamOrQuery(pathStr string, field string) string {
	if pathStr == "" || field == "" {
		return ""
	}

	// 1. Check query parameter
	if u, err := url.Parse(pathStr); err == nil {
		if qVal := u.Query().Get(field); qVal != "" {
			return qVal
		}
	}
	if qIdx := strings.Index(pathStr, "?"); qIdx != -1 {
		qs := pathStr[qIdx+1:]
		for _, part := range strings.Split(qs, "&") {
			kv := strings.SplitN(part, "=", 2)
			if len(kv) == 2 && strings.EqualFold(kv[0], field) {
				return kv[1]
			}
		}
		pathStr = pathStr[:qIdx]
	}

	// 2. Check path segments: e.g. /users/123 or /id/123
	segments := strings.Split(strings.Trim(pathStr, "/"), "/")
	for i, seg := range segments {
		if strings.EqualFold(seg, field) && i+1 < len(segments) {
			return segments[i+1]
		}
	}

	// 3. If field is "id" and last segment is numeric, return it
	if strings.EqualFold(field, "id") && len(segments) > 0 {
		last := segments[len(segments)-1]
		if _, err := strconv.Atoi(last); err == nil {
			return last
		}
	}

	return ""
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
	expr = strings.TrimPrefix(expr, "request.")
	expr = strings.TrimPrefix(expr, "response.")
	expr = strings.TrimPrefix(expr, "headers.")
	expr = strings.TrimPrefix(expr, "header.")
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
	expr = strings.TrimPrefix(expr, "request.")
	expr = strings.TrimPrefix(expr, "body.")
	expr = strings.TrimPrefix(expr, "body")
	expr = strings.Trim(expr, "[]'\" .")
	return expr
}

func extractJSONField(body string, field string) string {
	if strings.TrimSpace(body) == "" || strings.TrimSpace(field) == "" {
		return ""
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return ""
	}

	parts := strings.Split(field, ".")
	var current interface{} = parsed
	for _, part := range parts {
		if current == nil {
			return ""
		}
		// Array bracket notation: choices[0]
		if idxStart := strings.Index(part, "["); idxStart != -1 && strings.HasSuffix(part, "]") {
			key := part[:idxStart]
			indexStr := part[idxStart+1 : len(part)-1]
			if key != "" {
				if m, ok := current.(map[string]interface{}); ok {
					current = m[key]
				} else {
					return ""
				}
			}
			if idx, err := strconv.Atoi(indexStr); err == nil {
				if arr, ok := current.([]interface{}); ok && idx >= 0 && idx < len(arr) {
					current = arr[idx]
				} else {
					return ""
				}
			} else {
				return ""
			}
			continue
		}

		// Numeric array part: choices.0
		if idx, err := strconv.Atoi(part); err == nil {
			if arr, ok := current.([]interface{}); ok && idx >= 0 && idx < len(arr) {
				current = arr[idx]
				continue
			}
		}

		if m, ok := current.(map[string]interface{}); ok {
			current = m[part]
		} else {
			return ""
		}
	}

	if current == nil {
		return ""
	}

	switch v := current.(type) {
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return fmt.Sprintf("%v", v)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case bool:
		return strconv.FormatBool(v)
	default:
		return fmt.Sprintf("%v", v)
	}
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
