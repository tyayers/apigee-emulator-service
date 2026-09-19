package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// AnalyticsManager handles saving and retrieving analytics data from the
// Firestore REST API (using the default database in the apigee_analytics collection)
// without any Firestore or Firebase SDKs.
type AnalyticsManager struct {
	projectID  string
	databaseID string
	collection string
	httpClient *http.Client

	// Token cache
	tokenMu   sync.Mutex
	token     string
	expiresAt time.Time
}

// NewAnalyticsManager creates an AnalyticsManager instance.
func NewAnalyticsManager() *AnalyticsManager {
	am := &AnalyticsManager{
		databaseID: "(default)",
		collection: "apigee_analytics",
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
	am.projectID = am.detectProjectID()
	log.Printf("[Analytics] Initialized with Project ID: '%s', Database: '%s', Collection: '%s'",
		am.projectID, am.databaseID, am.collection)
	return am
}

// detectProjectID detects the GCP Project ID from env, metadata server, or gcloud CLI.
func (am *AnalyticsManager) detectProjectID() string {
	if p := os.Getenv("GCP_PROJECT"); p != "" {
		return p
	}
	if p := os.Getenv("GOOGLE_CLOUD_PROJECT"); p != "" {
		return p
	}
	if p := os.Getenv("PROJECT_ID"); p != "" {
		return p
	}

	// Try GCP metadata server (Cloud Run, GCE, GKE)
	client := &http.Client{Timeout: 600 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, "http://metadata.google.internal/computeMetadata/v1/project/project-id", nil)
	if err == nil {
		req.Header.Set("Metadata-Flavor", "Google")
		if resp, err := client.Do(req); err == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			if pid := strings.TrimSpace(string(b)); pid != "" {
				return pid
			}
		}
	}

	// Fallback to gcloud CLI
	if out, err := exec.Command("gcloud", "config", "get-value", "project").Output(); err == nil {
		pid := strings.TrimSpace(string(out))
		if pid != "" && !strings.Contains(pid, " ") && !strings.Contains(pid, "\n") {
			return pid
		}
	}

	return "aigateway-lab8"
}

// getAccessToken retrieves a valid OAuth2 access token, caching it until near expiration.
func (am *AnalyticsManager) getAccessToken() (string, error) {
	am.tokenMu.Lock()
	defer am.tokenMu.Unlock()

	// Use cached token if valid for at least 2 more minutes
	if am.token != "" && time.Now().Before(am.expiresAt.Add(-2*time.Minute)) {
		return am.token, nil
	}

	// 1. Check explicit environment variables
	if envToken := os.Getenv("GCP_ACCESS_TOKEN"); envToken != "" {
		am.token = envToken
		am.expiresAt = time.Now().Add(45 * time.Minute)
		return am.token, nil
	}
	if envToken := os.Getenv("FIREBASE_TOKEN"); envToken != "" {
		am.token = envToken
		am.expiresAt = time.Now().Add(45 * time.Minute)
		return am.token, nil
	}

	// 2. Try GCP Compute metadata server
	client := &http.Client{Timeout: 800 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	if err == nil {
		req.Header.Set("Metadata-Flavor", "Google")
		if resp, err := client.Do(req); err == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			var tokenResp struct {
				AccessToken string `json:"access_token"`
				ExpiresIn   int    `json:"expires_in"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err == nil && tokenResp.AccessToken != "" {
				am.token = tokenResp.AccessToken
				exp := tokenResp.ExpiresIn
				if exp <= 0 {
					exp = 3600
				}
				am.expiresAt = time.Now().Add(time.Duration(exp) * time.Second)
				return am.token, nil
			}
		}
	}

	// 3. Fallback to gcloud auth print-access-token
	out, err := exec.Command("gcloud", "auth", "print-access-token").Output()
	if err == nil {
		tok := strings.TrimSpace(string(out))
		if tok != "" {
			am.token = tok
			am.expiresAt = time.Now().Add(45 * time.Minute)
			return am.token, nil
		}
	}

	return "", fmt.Errorf("unable to obtain GCP OAuth2 access token for Firestore REST API")
}

// toFirestoreValue converts a standard Go interface value to a Firestore REST API Value.
func toFirestoreValue(v interface{}) map[string]interface{} {
	if v == nil {
		return map[string]interface{}{"nullValue": nil}
	}

	switch val := v.(type) {
	case bool:
		return map[string]interface{}{"booleanValue": val}
	case int:
		return map[string]interface{}{"integerValue": fmt.Sprintf("%d", val)}
	case int32:
		return map[string]interface{}{"integerValue": fmt.Sprintf("%d", val)}
	case int64:
		return map[string]interface{}{"integerValue": fmt.Sprintf("%d", val)}
	case float64:
		// Distinguish whole numbers from actual floating point
		if val == float64(int64(val)) {
			return map[string]interface{}{"integerValue": fmt.Sprintf("%d", int64(val))}
		}
		return map[string]interface{}{"doubleValue": val}
	case string:
		// If string parses as RFC3339 timestamp, store as timestampValue
		if t, err := time.Parse(time.RFC3339Nano, val); err == nil {
			return map[string]interface{}{"timestampValue": t.Format(time.RFC3339Nano)}
		}
		if t, err := time.Parse(time.RFC3339, val); err == nil {
			return map[string]interface{}{"timestampValue": t.Format(time.RFC3339Nano)}
		}
		return map[string]interface{}{"stringValue": val}
	case map[string]interface{}:
		fields := make(map[string]interface{})
		for k, subVal := range val {
			fields[k] = toFirestoreValue(subVal)
		}
		return map[string]interface{}{
			"mapValue": map[string]interface{}{
				"fields": fields,
			},
		}
	case []interface{}:
		values := make([]interface{}, 0, len(val))
		for _, item := range val {
			values = append(values, toFirestoreValue(item))
		}
		return map[string]interface{}{
			"arrayValue": map[string]interface{}{
				"values": values,
			},
		}
	default:
		return map[string]interface{}{"stringValue": fmt.Sprintf("%v", val)}
	}
}

// fromFirestoreValue converts a Firestore REST API Value back into standard JSON types.
func fromFirestoreValue(v map[string]interface{}) interface{} {
	if _, ok := v["nullValue"]; ok {
		return nil
	}
	if bv, ok := v["booleanValue"].(bool); ok {
		return bv
	}
	if iv, ok := v["integerValue"]; ok {
		var n int64
		switch val := iv.(type) {
		case string:
			fmt.Sscanf(val, "%d", &n)
			return n
		case float64:
			return int64(val)
		case int64:
			return val
		case int:
			return int64(val)
		}
	}
	if dv, ok := v["doubleValue"].(float64); ok {
		return dv
	}
	if sv, ok := v["stringValue"].(string); ok {
		return sv
	}
	if tv, ok := v["timestampValue"].(string); ok {
		return tv
	}
	if mv, ok := v["mapValue"].(map[string]interface{}); ok {
		res := make(map[string]interface{})
		if fields, ok := mv["fields"].(map[string]interface{}); ok {
			for k, fv := range fields {
				if fvMap, ok := fv.(map[string]interface{}); ok {
					res[k] = fromFirestoreValue(fvMap)
				}
			}
		}
		return res
	}
	if av, ok := v["arrayValue"].(map[string]interface{}); ok {
		var list []interface{}
		if values, ok := av["values"].([]interface{}); ok {
			for _, val := range values {
				if valMap, ok := val.(map[string]interface{}); ok {
					list = append(list, fromFirestoreValue(valMap))
				}
			}
		}
		return list
	}
	return nil
}

// parseFirestoreDocument parses a Firestore Document JSON object into a clean map.
func parseFirestoreDocument(doc map[string]interface{}) map[string]interface{} {
	res := make(map[string]interface{})
	if name, ok := doc["name"].(string); ok {
		parts := strings.Split(name, "/")
		res["id"] = parts[len(parts)-1]
		res["documentName"] = name
	}
	if ct, ok := doc["createTime"].(string); ok {
		res["createTime"] = ct
	}
	if ut, ok := doc["updateTime"].(string); ok {
		res["updateTime"] = ut
	}

	if fields, ok := doc["fields"].(map[string]interface{}); ok {
		for k, v := range fields {
			if vMap, ok := v.(map[string]interface{}); ok {
				res[k] = fromFirestoreValue(vMap)
			}
		}
	}

	// Ensure top-level timestamp exists
	if _, ok := res["timestamp"]; !ok {
		if ct, ok := res["createTime"].(string); ok {
			res["timestamp"] = ct
		}
	}

	return res
}

// SaveRecord saves an analytics record to Firestore via the public REST API.
func (am *AnalyticsManager) SaveRecord(rawBody io.Reader) (map[string]interface{}, error) {
	var input map[string]interface{}
	if err := json.NewDecoder(rawBody).Decode(&input); err != nil {
		return nil, fmt.Errorf("invalid json request payload: %w", err)
	}

	// Ensure timestamp exists
	if _, ok := input["timestamp"]; !ok || input["timestamp"] == "" {
		input["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	}

	// Convert input map to Firestore fields format
	fields := make(map[string]interface{})
	for k, v := range input {
		fields[k] = toFirestoreValue(v)
	}

	firestorePayload := map[string]interface{}{
		"fields": fields,
	}
	payloadBytes, err := json.Marshal(firestorePayload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal firestore payload: %w", err)
	}

	token, err := am.getAccessToken()
	if err != nil {
		return nil, fmt.Errorf("authentication error: %w", err)
	}

	projectID := am.detectProjectID()
	url := fmt.Sprintf("https://firestore.googleapis.com/v1/projects/%s/databases/%s/documents/%s",
		projectID, am.databaseID, am.collection)

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create http request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := am.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request to firestore failed: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read firestore response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("firestore error (status %d): %s", resp.StatusCode, string(respBytes))
	}

	var createdDoc map[string]interface{}
	if err := json.Unmarshal(respBytes, &createdDoc); err != nil {
		return nil, fmt.Errorf("failed to parse firestore response: %w", err)
	}

	parsed := parseFirestoreDocument(createdDoc)
	return parsed, nil
}

// GetLastRecords retrieves the latest records (up to limit, max 500) from the apigee_analytics collection.
func (am *AnalyticsManager) GetLastRecords(limit int) ([]map[string]interface{}, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}

	token, err := am.getAccessToken()
	if err != nil {
		return nil, fmt.Errorf("authentication error: %w", err)
	}

	projectID := am.detectProjectID()

	// Approach 1: Try runQuery with structuredQuery ordering by timestamp descending
	runQueryURL := fmt.Sprintf("https://firestore.googleapis.com/v1/projects/%s/databases/%s/documents:runQuery",
		projectID, am.databaseID)

	queryPayload := map[string]interface{}{
		"structuredQuery": map[string]interface{}{
			"from": []map[string]interface{}{
				{"collectionId": am.collection},
			},
			"orderBy": []map[string]interface{}{
				{
					"field":     map[string]interface{}{"fieldPath": "timestamp"},
					"direction": "DESCENDING",
				},
			},
			"limit": limit,
		},
	}
	queryBytes, _ := json.Marshal(queryPayload)

	req, err := http.NewRequest(http.MethodPost, runQueryURL, bytes.NewReader(queryBytes))
	if err == nil {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")

		resp, err := am.httpClient.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			var queryResults []map[string]interface{}
			if err := json.NewDecoder(resp.Body).Decode(&queryResults); err == nil {
				var records []map[string]interface{}
				for _, item := range queryResults {
					if docObj, ok := item["document"].(map[string]interface{}); ok {
						records = append(records, parseFirestoreDocument(docObj))
					}
				}
				log.Printf("[Analytics] runQuery retrieved %d records", len(records))
				return records, nil
			}
		} else if resp != nil {
			resp.Body.Close()
		}
	}

	// Approach 2: Fallback to list documents if runQuery fails (e.g. index build or missing field)
	listURL := fmt.Sprintf("https://firestore.googleapis.com/v1/projects/%s/databases/%s/documents/%s?pageSize=%d",
		projectID, am.databaseID, am.collection, limit)

	listReq, err := http.NewRequest(http.MethodGet, listURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create list request: %w", err)
	}
	listReq.Header.Set("Authorization", "Bearer "+token)

	listResp, err := am.httpClient.Do(listReq)
	if err != nil {
		return nil, fmt.Errorf("firestore list request failed: %w", err)
	}
	defer listResp.Body.Close()

	listBytes, _ := io.ReadAll(listResp.Body)
	if listResp.StatusCode < 200 || listResp.StatusCode >= 300 {
		return nil, fmt.Errorf("firestore list error (status %d): %s", listResp.StatusCode, string(listBytes))
	}

	var listData struct {
		Documents []map[string]interface{} `json:"documents"`
	}
	if err := json.Unmarshal(listBytes, &listData); err != nil {
		return nil, fmt.Errorf("failed to parse list response: %w", err)
	}

	var records []map[string]interface{}
	for _, doc := range listData.Documents {
		records = append(records, parseFirestoreDocument(doc))
	}

	// Sort records descending by timestamp or createTime
	sort.Slice(records, func(i, j int) bool {
		t1, _ := records[i]["timestamp"].(string)
		t2, _ := records[j]["timestamp"].(string)
		return t1 > t2
	})

	if len(records) > limit {
		records = records[:limit]
	}

	log.Printf("[Analytics] listDocuments retrieved %d records", len(records))
	return records, nil
}

// SeedDemoRecords populates sample realistic AI analytics records for testing and demonstration.
func (am *AnalyticsManager) SeedDemoRecords() (int, error) {
	now := time.Now().UTC()
	demoModels := []struct {
		model    string
		provider string
		path     string
		route    string
	}{
		{"claude-sonnet-5", "anthropic", "/v1/chat/completions", "googlecloud"},
		{"gemini-1.5-pro", "google", "/v1/models/gemini-1.5-pro:generateContent", "vertex-ai"},
		{"gpt-4o", "openai", "/v1/chat/completions", "azure-openai"},
		{"claude-3-5-sonnet", "anthropic", "/v1/chat/completions", "anthropic-direct"},
		{"gemini-1.5-flash", "google", "/v1/models/gemini-1.5-flash:generateContent", "vertex-ai"},
	}

	statuses := []int{200, 200, 200, 200, 200, 200, 200, 429, 200, 500}
	count := 0

	for i := 0; i < 15; i++ {
		m := demoModels[i%len(demoModels)]
		sc := statuses[i%len(statuses)]
		stText := "OK"
		isErr := false
		if sc == 429 {
			stText = "Too Many Requests"
			isErr = true
		} else if sc == 500 {
			stText = "Internal Server Error"
			isErr = true
		}

		promptTok := 150 + (i * 37) % 800
		compTok := 50 + (i * 23) % 400
		totalTok := promptTok + compTok
		dur := 65 + (i * 43) % 450
		targetLat := dur - 15
		if targetLat < 10 {
			targetLat = 10
		}

		offset := time.Duration(i*12) * time.Minute
		ts := now.Add(-offset).Format(time.RFC3339Nano)

		record := map[string]interface{}{
			"timestamp":       ts,
			"proxy":           "TestProxy",
			"method":          "POST",
			"path":            m.path,
			"statusCode":      sc,
			"statusText":      stText,
			"durationMs":      dur,
			"targetLatencyMs": targetLat,
			"targetUrl":       "https://mocktarget.apigee.net",
			"targetName":      "default",
			"clientIp":        fmt.Sprintf("192.168.1.%d", 10+i),
			"environment":     "test",
			"traceSessionId":  fmt.Sprintf("demo-session-%04d", 1000+i),
			"isError":         isErr,
			"policiesExecuted": 6,
			"ai": map[string]interface{}{
				"ai.model":            m.model,
				"ai.provider":         m.provider,
				"ai.targetRoute":      m.route,
				"ai.promptTokenCount": promptTok,
				"ai.candidatesTokenCount": compTok,
				"ai.totalTokenCount":  totalTok,
				"model":               m.model,
				"provider":            m.provider,
				"targetRoute":         m.route,
				"promptTokens":        promptTok,
				"completionTokens":    compTok,
				"totalTokens":         totalTok,
			},
			"general": map[string]interface{}{
				"proxyName":     "TestProxy",
				"httpMethod":    "POST",
				"requestPath":   m.path,
				"statusCode":    sc,
				"durationMs":    dur,
				"clientAddress": fmt.Sprintf("192.168.1.%d", 10+i),
			},
		}

		b, _ := json.Marshal(record)
		if _, err := am.SaveRecord(bytes.NewReader(b)); err == nil {
			count++
		}
	}

	return count, nil
}
