package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	EmulatorClient    *EmulatorClient
	BundleManager     *BundleManager
	DeploymentManager *DeploymentManager
	ProxyTester       *ProxyTester
	AnalyticsManager  *AnalyticsManager
	TestHistory       *TestHistoryManager
	PublicDir         string
	RootDir           string

	mu              sync.RWMutex
	deployMu        sync.Mutex
	isDeploying     bool
	deployStatusMsg string
	deployError     string
}

func (s *Server) setDeployState(deploying bool, msg string, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.isDeploying = deploying
	s.deployStatusMsg = msg
	s.deployError = errMsg
}

func (s *Server) getDeployState() (bool, string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.isDeploying, s.deployStatusMsg, s.deployError
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func main() {
	port := getEnv("PORT", "8082")
	mgmtURL := getEnv("EMULATOR_MGMT_URL", "http://127.0.0.1:8080")
	runtimeURL := getEnv("EMULATOR_RUNTIME_URL", "http://127.0.0.1:8998")
	dataDir := getEnv("DATA_DIR", "data")
	publicDir := getEnv("PUBLIC_DIR", "public")

	// Determine root directory from executable or working directory
	rootDir, err := os.Getwd()
	if err != nil {
		rootDir = "."
	}

	emulatorClient := NewEmulatorClient(mgmtURL, runtimeURL)
	bundleManager := NewBundleManager(dataDir, rootDir)
	deploymentManager := NewDeploymentManager(dataDir)
	proxyTester := NewProxyTester(emulatorClient)
	analyticsManager := NewAnalyticsManager()
	testHistory := NewTestHistoryManager(300)

	s := &Server{
		EmulatorClient:    emulatorClient,
		BundleManager:     bundleManager,
		DeploymentManager: deploymentManager,
		ProxyTester:       proxyTester,
		AnalyticsManager:  analyticsManager,
		TestHistory:       testHistory,
		PublicDir:         publicDir,
		RootDir:           rootDir,
		isDeploying:       true,
		deployStatusMsg:   "Initializing service and waiting for Apigee emulator...",
	}

	// Automatically deploy all bundles on service startup
	go s.startAutoDeploy()

	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// API Routes under /tester/api/ (and backward-compatible /manage/api/)
	registerAPI := func(prefix string) {
		mux.HandleFunc(prefix+"/status", s.handleStatus)
		mux.HandleFunc(prefix+"/bundles", s.handleBundles)
		mux.HandleFunc(prefix+"/deployments", s.handleDeployments)
		mux.HandleFunc(prefix+"/tests", s.handleTests)
		mux.HandleFunc(prefix+"/tests/run", s.handleTestsRun)
		mux.HandleFunc(prefix+"/tests/history", s.handleTestsHistory)
		mux.HandleFunc(prefix+"/tests/history/", s.handleTestHistoryDetail)
		mux.HandleFunc(prefix+"/deploy", s.handleDeploy)
		mux.HandleFunc(prefix+"/test", s.handleTest)
		mux.HandleFunc(prefix+"/reset", s.handleReset)
		mux.HandleFunc(prefix+"/trace/start", s.handleTraceStart)
		mux.HandleFunc(prefix+"/trace/transactions", s.handleTraceTransactions)
		mux.HandleFunc(prefix+"/analytics", s.handleAnalytics)
		mux.HandleFunc(prefix+"/analytics/seed", s.handleAnalyticsSeed)
	}
	registerAPI("/tester/api")
	registerAPI("/manage/api")

	// Static files for /tester/
	fileServer := http.FileServer(http.Dir(publicDir))
	staticHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		fileServer.ServeHTTP(w, r)
	})

	mux.Handle("/tester/", http.StripPrefix("/tester/", staticHandler))
	mux.HandleFunc("/tester", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tester/", http.StatusMovedPermanently)
	})

	// Backward compatibility: redirect /manage/ and /manage to /tester/
	mux.HandleFunc("/manage", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tester/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/manage/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/tester/", http.StatusMovedPermanently)
	})

	// Also redirect root / to /tester/
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/tester/", http.StatusFound)
			return
		}
		// Check if requesting trace.html or viewer.html directly
		if r.URL.Path == "/trace.html" || r.URL.Path == "/viewer.html" {
			http.ServeFile(w, r, filepath.Join(rootDir, filepath.Base(r.URL.Path)))
			return
		}
		http.NotFound(w, r)
	})

	addr := ":" + port
	log.Printf("=========================================================")
	log.Printf("  Apigee Emulator Tester Service listening on %s", addr)
	log.Printf("  Web UI: http://localhost:%s/tester/", port)
	log.Printf("  Emulator Mgmt URL:    %s", mgmtURL)
	log.Printf("  Emulator Runtime URL: %s", runtimeURL)
	log.Printf("  Data Directory:       %s", dataDir)
	log.Printf("=========================================================")

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func jsonResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	status, _ := s.EmulatorClient.CheckHealth()
	bundles, _ := s.BundleManager.ListBundles()

	// Correlate deployed state with available bundles
	deployedNames := make(map[string]bool)
	for _, p := range status.ActiveProxies {
		deployedNames[p.Name] = true
	}
	for i := range bundles {
		if deployedNames[bundles[i].ProxyName] {
			bundles[i].IsDeployed = true
		}
	}
	status.AvailableBundles = bundles

	// Populate deployment status
	isDeploying, msg, errMsg := s.getDeployState()
	status.IsDeploying = isDeploying
	status.DeployMessage = msg
	if errMsg != "" && status.Error == "" {
		status.Error = errMsg
	}

	jsonResponse(w, http.StatusOK, status)
}

func (s *Server) handleBundles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bundles, err := s.BundleManager.ListBundles()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Enrich with active deployment info
	tree, err := s.EmulatorClient.GetDeploymentTree()
	if err == nil {
		deployedMap := make(map[string]bool)
		for _, p := range tree {
			deployedMap[p.Name] = true
		}
		for i := range bundles {
			if deployedMap[bundles[i].ProxyName] {
				bundles[i].IsDeployed = true
			}
		}
	}

	jsonResponse(w, http.StatusOK, bundles)
}

func (s *Server) handleDeployments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	deps, err := s.DeploymentManager.ListDeployments()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, deps)
}

func (s *Server) handleTests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	tests, err := s.DeploymentManager.LoadAllTests()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, tests)
}

func (s *Server) executeDeploy(req DeployRequest) (*DeployResponse, error) {
	s.deployMu.Lock()
	defer s.deployMu.Unlock()

	s.setDeployState(true, "Preparing deployment...", "")
	defer func() {
		s.setDeployState(false, "", "")
	}()

	startTime := time.Now()

	// 1. Reset if requested (default true)
	if req.Reset {
		s.setDeployState(true, "Resetting emulator state...", "")
		if err := s.EmulatorClient.Reset(); err != nil {
			log.Printf("Warning during emulator reset: %v", err)
		}
	}

	// 2. Build environment bundle
	s.setDeployState(true, "Building environment bundle from proxy bundles...", "")
	bundleZipBytes, proxyNames, err := s.BundleManager.BuildEnvironmentBundle(req.Bundles)
	if err != nil {
		s.setDeployState(false, "", err.Error())
		return nil, fmt.Errorf("failed to build environment bundle: %w", err)
	}

	// 3. Build & upload test data bundle
	s.setDeployState(true, "Building and uploading test data...", "")
	testDataBytes, err := s.BundleManager.BuildTestDataBundle(proxyNames)
	if err != nil {
		log.Printf("Warning building testdata: %v", err)
	} else {
		if err := s.EmulatorClient.SetupTestData(testDataBytes); err != nil {
			log.Printf("Warning uploading testdata: %v", err)
		}
	}

	// 4. Deploy proxy bundle to emulator
	s.setDeployState(true, fmt.Sprintf("Deploying %d proxy bundles to Apigee emulator...", len(proxyNames)), "")
	revision, err := s.EmulatorClient.DeployBundle("test", bundleZipBytes)
	if err != nil {
		s.setDeployState(false, "", err.Error())
		return nil, fmt.Errorf("deploy to emulator failed: %w", err)
	}

	// 5. Fetch updated active proxies
	activeTree, _ := s.EmulatorClient.GetDeploymentTree()
	duration := time.Since(startTime).Milliseconds()

	return &DeployResponse{
		Success:       true,
		Message:       fmt.Sprintf("Successfully deployed %d proxies to Apigee Emulator", len(proxyNames)),
		Revision:      revision,
		Deployed:      activeTree,
		TotalDeployed: len(activeTree),
		DeployedCount: len(activeTree),
		DurationMs:    duration,
	}, nil
}

func (s *Server) startAutoDeploy() {
	log.Printf("[AutoDeploy] Initializing startup auto-deployment of all proxy bundles...")
	s.setDeployState(true, "Waiting for Apigee emulator to be ready...", "")

	// Wait for emulator to become healthy (up to 120 seconds, polling every 2 seconds)
	ready := false
	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		status, err := s.EmulatorClient.CheckHealth()
		if err == nil && status.Online {
			ready = true
			break
		}
		time.Sleep(2 * time.Second)
	}

	if !ready {
		log.Printf("[AutoDeploy] Warning: Apigee emulator did not become ready within timeout. Auto-deploy aborted.")
		s.setDeployState(false, "", "Emulator did not become ready within timeout")
		return
	}

	log.Printf("[AutoDeploy] Apigee emulator is online. Deploying all bundles...")
	resp, err := s.executeDeploy(DeployRequest{All: true, Reset: true})
	if err != nil {
		log.Printf("[AutoDeploy] Auto-deployment failed: %v", err)
		s.setDeployState(false, "", err.Error())
		return
	}

	log.Printf("[AutoDeploy] Successfully auto-deployed %d proxies (revision %s) in %dms", resp.TotalDeployed, resp.Revision, resp.DurationMs)
}

func (s *Server) handleDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// default to deploying all if empty body
		req.All = true
		req.Reset = true
	}

	resp, err := s.executeDeploy(req)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, DeployResponse{
			Success: false,
			Error:   err.Error(),
		})
		return
	}

	jsonResponse(w, http.StatusOK, resp)
}

func (s *Server) handleTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req TestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON request: %v", err), http.StatusBadRequest)
		return
	}

	resp, err := s.ProxyTester.Execute(req)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Evaluate assertions if provided
	if len(req.Assertions) > 0 {
		resp.Assertions = EvaluateAssertions(req.Assertions, resp)
		allPassed := true
		for _, a := range resp.Assertions {
			if !a.Passed {
				allPassed = false
				break
			}
		}
		resp.Passed = allPassed
	} else {
		resp.Passed = (resp.StatusCode < 400 && resp.Error == "")
	}

	// Record in TestHistoryManager
	runID := fmt.Sprintf("run_%d", time.Now().UnixNano())
	resp.TestRunID = runID

	proxyName := req.Proxy
	if proxyName == "" {
		proxyName = "General"
	}

	testName := req.TestName
	if testName == "" {
		testName = fmt.Sprintf("%s %s", req.Method, req.Path)
	}

	runResult := TestRunResult{
		ID:             runID,
		TestName:       testName,
		Proxy:          proxyName,
		Timestamp:      time.Now(),
		Passed:         resp.Passed,
		StatusCode:     resp.StatusCode,
		StatusText:     resp.StatusText,
		DurationMs:     resp.DurationMs,
		Request:        req,
		Response:       resp,
		Assertions:     resp.Assertions,
		TraceSessionID: resp.TraceSessionID,
		TraceData:      resp.TraceData,
		Error:          resp.Error,
	}

	s.TestHistory.Record(runResult)

	jsonResponse(w, http.StatusOK, resp)
}

func (s *Server) handleTestsRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var runReq TestsRunRequest
	_ = json.NewDecoder(r.Body).Decode(&runReq)

	allTests, err := s.DeploymentManager.LoadAllTests()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	startTime := time.Now()
	var results []TestRunResult
	passedCount := 0
	failedCount := 0

	for _, tc := range allTests {
		// Filter by proxy if requested
		if runReq.Proxy != "" && !strings.EqualFold(tc.Proxy, runReq.Proxy) {
			continue
		}
		// Filter by testName if requested
		if runReq.TestName != "" && !strings.EqualFold(tc.Name, runReq.TestName) {
			continue
		}

		verb := tc.Verb
		if verb == "" {
			if tc.Payload != "" {
				verb = "POST"
			} else {
				verb = "GET"
			}
		}

		path := tc.Path
		if path == "" {
			path = defaultPathForProxy(tc.Proxy)
		}

		testReq := TestRequest{
			Proxy:       tc.Proxy,
			Method:      verb,
			Path:        path,
			Headers:     tc.Headers,
			Body:        tc.Payload,
			RecordTrace: true, // Use trace result to evaluate
			TestName:    tc.Name,
			Assertions:  tc.Assertions,
		}

		resp, _ := s.ProxyTester.Execute(testReq)
		if resp == nil {
			resp = &TestResponse{
				StatusCode: 500,
				StatusText: "500 Internal Error",
				Error:      "Failed to execute test",
			}
		}

		// Evaluate assertions
		if len(tc.Assertions) > 0 {
			resp.Assertions = EvaluateAssertions(tc.Assertions, resp)
			allPassed := true
			for _, a := range resp.Assertions {
				if !a.Passed {
					allPassed = false
					break
				}
			}
			resp.Passed = allPassed
		} else {
			resp.Passed = (resp.StatusCode < 400 && resp.Error == "")
		}

		runID := fmt.Sprintf("run_%d", time.Now().UnixNano())
		resp.TestRunID = runID

		runResult := TestRunResult{
			ID:             runID,
			TestName:       tc.Name,
			Proxy:          tc.Proxy,
			Deployment:     tc.Deployment,
			Timestamp:      time.Now(),
			Passed:         resp.Passed,
			StatusCode:     resp.StatusCode,
			StatusText:     resp.StatusText,
			DurationMs:     resp.DurationMs,
			Request:        testReq,
			Response:       resp,
			Assertions:     resp.Assertions,
			TraceSessionID: resp.TraceSessionID,
			TraceData:      resp.TraceData,
			Error:          resp.Error,
		}

		s.TestHistory.Record(runResult)
		results = append(results, runResult)

		if resp.Passed {
			passedCount++
		} else {
			failedCount++
		}
	}

	response := TestsRunResponse{
		Total:      len(results),
		Passed:     passedCount,
		Failed:     failedCount,
		DurationMs: time.Since(startTime).Milliseconds(),
		Results:    results,
	}

	jsonResponse(w, http.StatusOK, response)
}

func (s *Server) handleTestsHistory(w http.ResponseWriter, r *http.Request) {
	proxy := r.URL.Query().Get("proxy")

	switch r.Method {
	case http.MethodGet:
		history := s.TestHistory.GetHistory(proxy)
		// For list view, summarize trace availability without dumping full trace payload
		list := make([]map[string]interface{}, len(history))
		for i, run := range history {
			hasTrace := (run.TraceData != nil || run.TraceSessionID != "")
			list[i] = map[string]interface{}{
				"id":             run.ID,
				"testName":       run.TestName,
				"proxy":          run.Proxy,
				"deployment":     run.Deployment,
				"timestamp":      run.Timestamp,
				"passed":         run.Passed,
				"statusCode":     run.StatusCode,
				"statusText":     run.StatusText,
				"durationMs":     run.DurationMs,
				"hasTrace":       hasTrace,
				"traceSessionId": run.TraceSessionID,
				"assertions":     run.Assertions,
				"request":        run.Request,
				"error":          run.Error,
			}
		}
		jsonResponse(w, http.StatusOK, list)

	case http.MethodDelete:
		s.TestHistory.Clear(proxy)
		jsonResponse(w, http.StatusOK, map[string]string{"message": "History cleared"})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleTestHistoryDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	path := r.URL.Path
	idx := strings.Index(path, "/tests/history/")
	if idx == -1 {
		http.NotFound(w, r)
		return
	}
	subPath := path[idx+len("/tests/history/"):]
	parts := strings.Split(strings.Trim(subPath, "/"), "/")

	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}

	runID := parts[0]
	run := s.TestHistory.GetRun(runID)
	if run == nil {
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "Test run not found"})
		return
	}

	// If .../tests/history/{id}/trace -> download trace json
	if len(parts) > 1 && parts[1] == "trace" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"trace_%s_%s.json\"", run.Proxy, run.ID))
		tracePayload := run.TraceData
		if tracePayload == nil {
			tracePayload = map[string]interface{}{
				"sessionId": run.TraceSessionID,
				"proxy":     run.Proxy,
				"message":   "No trace captured for this run",
			}
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(tracePayload)
		return
	}

	// If .../tests/history/{id}/result -> download test result json
	if len(parts) > 1 && parts[1] == "result" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"test_result_%s_%s.json\"", run.Proxy, run.ID))
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(run)
		return
	}

	// Otherwise return full test run detail
	jsonResponse(w, http.StatusOK, run)
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := s.EmulatorClient.Reset(); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]string{"message": "Emulator reset successfully"})
}

func (s *Server) handleTraceStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	proxyName := r.URL.Query().Get("proxy")
	if proxyName == "" {
		http.Error(w, "Query parameter 'proxy' is required", http.StatusBadRequest)
		return
	}

	sessionID, err := s.EmulatorClient.StartTraceSession(proxyName)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]string{
		"sessionId": sessionID,
		"proxyName": proxyName,
	})
}

func (s *Server) handleTraceTransactions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "Query parameter 'sessionId' is required", http.StatusBadRequest)
		return
	}

	txs, err := s.EmulatorClient.GetTraceTransactions(sessionID)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	jsonResponse(w, http.StatusOK, txs)
}

func (s *Server) handleAnalytics(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		record, err := s.AnalyticsManager.SaveRecord(r.Body)
		if err != nil {
			log.Printf("[Analytics] Error saving record: %v", err)
			jsonResponse(w, http.StatusInternalServerError, AnalyticsSaveResponse{
				Success: false,
				Error:   err.Error(),
			})
			return
		}
		docID, _ := record["id"].(string)
		jsonResponse(w, http.StatusOK, AnalyticsSaveResponse{
			Success: true,
			ID:      docID,
			Record:  record,
		})

	case http.MethodGet:
		limit := 500
		if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
			if parsedLimit, err := strconv.Atoi(limitStr); err == nil && parsedLimit > 0 {
				limit = parsedLimit
			}
		}

		records, err := s.AnalyticsManager.GetLastRecords(limit)
		if err != nil {
			log.Printf("[Analytics] Error retrieving records: %v", err)
			jsonResponse(w, http.StatusInternalServerError, AnalyticsQueryResponse{
				Records:   []map[string]interface{}{},
				Count:     0,
				ProjectID: s.AnalyticsManager.detectProjectID(),
				Database:  "(default)",
				Error:     err.Error(),
			})
			return
		}

		if records == nil {
			records = []map[string]interface{}{}
		}

		jsonResponse(w, http.StatusOK, AnalyticsQueryResponse{
			Records:   records,
			Count:     len(records),
			ProjectID: s.AnalyticsManager.detectProjectID(),
			Database:  "(default)",
		})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAnalyticsSeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	count, err := s.AnalyticsManager.SeedDemoRecords()
	if err != nil {
		log.Printf("[Analytics] Error seeding demo records: %v", err)
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   err.Error(),
		})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"count":   count,
		"message": fmt.Sprintf("Successfully seeded %d sample analytics records into Firestore", count),
	})
}
