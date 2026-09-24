package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
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

	mu                 sync.RWMutex
	deployMu           sync.Mutex
	isDeploying        bool
	deployStatusMsg    string
	deployError        string
	lastTestDataTime   time.Time
	lastTestDataStatus string
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

func (s *Server) recordTestDataStatus(status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastTestDataTime = time.Now()
	s.lastTestDataStatus = status
}

func (s *Server) getTestDataStatus() (time.Time, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastTestDataTime, s.lastTestDataStatus
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
	emulatorClient.KVMSecretProvider = bundleManager.GetKVMSecretValues
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
		mux.HandleFunc(prefix+"/products", s.handleProducts)
		mux.HandleFunc(prefix+"/users", s.handleUsers)
		mux.HandleFunc(prefix+"/apps", s.handleApps)
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
		mux.HandleFunc(prefix+"/emulator/state", s.handleEmulatorState)
		mux.HandleFunc(prefix+"/emulator/setup-testdata", s.handleSetupTestData)
		mux.HandleFunc(prefix+"/proxies/yaml", s.handleProxyYaml)
		mux.HandleFunc(prefix+"/proxy/yaml", s.handleProxyYaml)
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

	// Populate deployed products, users, and apps
	if prods, err := s.BundleManager.GetProducts(); err == nil {
		status.Products = prods
	}
	if users, err := s.BundleManager.GetUsers(); err == nil {
		status.Users = users
	}
	if apps, err := s.BundleManager.GetApps(); err == nil {
		status.Apps = apps
	}

	// Populate deployment status
	isDeploying, msg, errMsg := s.getDeployState()
	status.IsDeploying = isDeploying
	status.DeployMessage = msg
	if errMsg != "" && status.Error == "" {
		status.Error = errMsg
	}

	jsonResponse(w, http.StatusOK, status)
}

func (s *Server) handleProducts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	prods, err := s.BundleManager.GetProducts()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, prods)
}

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	users, err := s.BundleManager.GetUsers()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, users)
}

func (s *Server) handleApps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	apps, err := s.BundleManager.GetApps()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, apps)
}

func (s *Server) handleProxyYaml(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = strings.TrimSpace(r.URL.Query().Get("proxy"))
	}
	if name == "" {
		jsonResponse(w, http.StatusBadRequest, ProxyYamlResponse{
			Success: false,
			Error:   "Query parameter 'name' or 'proxy' is required",
		})
		return
	}

	yamlContent, source, err := s.findProxyYaml(name)
	if err != nil {
		jsonResponse(w, http.StatusNotFound, ProxyYamlResponse{
			Success: false,
			Proxy:   name,
			Error:   err.Error(),
		})
		return
	}

	jsonResponse(w, http.StatusOK, ProxyYamlResponse{
		Success: true,
		Proxy:   name,
		YAML:    yamlContent,
		Source:  source,
	})
}

func (s *Server) findProxyYaml(name string) (string, string, error) {
	// 1. Direct candidate paths - PRIORITIZE generated/compiled proxy YAML
	proxyCandidates := []struct {
		path  string
		label string
	}{
		{filepath.Join(s.BundleManager.DataDir, "proxies", name+".yaml"), filepath.Join("data", "proxies", name+".yaml")},
		{filepath.Join(s.BundleManager.DataDir, "proxies", name+".yml"), filepath.Join("data", "proxies", name+".yml")},
		{filepath.Join(s.RootDir, "data", "proxies", name+".yaml"), filepath.Join("data", "proxies", name+".yaml")},
		{filepath.Join(s.RootDir, "data", "proxies", name+".yml"), filepath.Join("data", "proxies", name+".yml")},
		{filepath.Join(s.RootDir, "dist", "proxies", name+".yaml"), filepath.Join("dist", "proxies", name+".yaml")},
		{filepath.Join(s.RootDir, "dist", "proxies", name+".yml"), filepath.Join("dist", "proxies", name+".yml")},
		{filepath.Join(s.RootDir, "proxies", name+".yaml"), filepath.Join("proxies", name+".yaml")},
		{filepath.Join(s.RootDir, name+".yaml"), name + ".yaml"},
		{filepath.Join(s.RootDir, name+".yml"), name + ".yml"},
	}

	for _, c := range proxyCandidates {
		if data, err := os.ReadFile(c.path); err == nil && len(data) > 0 {
			return string(data), c.label, nil
		}
	}

	// 2. If bundle zip exists and aft is available, dynamically generate proxy YAML
	bundleCandidates := []string{
		filepath.Join(s.RootDir, "data", "bundles", name+".zip"),
		filepath.Join(s.BundleManager.DataDir, "bundles", name+".zip"),
		filepath.Join(s.RootDir, "dist", name+".zip"),
	}
	for _, bundleZip := range bundleCandidates {
		if _, err := os.Stat(bundleZip); err == nil {
			if _, aftErr := exec.LookPath("aft"); aftErr == nil {
				targetYaml := filepath.Join(s.BundleManager.DataDir, "proxies", name+".yaml")
				_ = os.MkdirAll(filepath.Dir(targetYaml), 0755)
				cmd := exec.Command("aft", "-i", bundleZip, "-f", "proxy", "-n", name, "-o", targetYaml, "--no-animation")
				if cmd.Run() == nil {
					if data, err := os.ReadFile(targetYaml); err == nil && len(data) > 0 {
						return string(data), filepath.Join("data", "proxies", name+".yaml"), nil
					}
				}
			}
			break
		}
	}

	// 3. Fallback to templates ONLY if no proxy YAML could be found or generated
	templateCandidates := []struct {
		path  string
		label string
	}{
		{filepath.Join(s.BundleManager.DataDir, "templates", name+".yaml"), filepath.Join("data", "templates", name+".yaml")},
		{filepath.Join(s.BundleManager.DataDir, "templates", name+".yml"), filepath.Join("data", "templates", name+".yml")},
		{filepath.Join(s.RootDir, "data", "templates", name+".yaml"), filepath.Join("data", "templates", name+".yaml")},
		{filepath.Join(s.RootDir, "data", "templates", name+".yml"), filepath.Join("data", "templates", name+".yml")},
	}

	for _, c := range templateCandidates {
		if data, err := os.ReadFile(c.path); err == nil && len(data) > 0 {
			return string(data), c.label, nil
		}
	}

	// 4. Case-insensitive search across directories
	dirsToScan := []string{
		filepath.Join(s.BundleManager.DataDir, "proxies"),
		filepath.Join(s.RootDir, "data", "proxies"),
		filepath.Join(s.RootDir, "dist", "proxies"),
		filepath.Join(s.BundleManager.DataDir, "templates"),
		filepath.Join(s.RootDir, "data", "templates"),
		s.BundleManager.DataDir,
		s.RootDir,
	}

	for _, d := range dirsToScan {
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			ext := filepath.Ext(e.Name())
			if ext == ".yaml" || ext == ".yml" {
				base := strings.TrimSuffix(e.Name(), ext)
				if strings.EqualFold(base, name) {
					p := filepath.Join(d, e.Name())
					if data, err := os.ReadFile(p); err == nil && len(data) > 0 {
						rel, _ := filepath.Rel(s.RootDir, p)
						if rel == "" {
							rel = e.Name()
						}
						return SubstituteDeploymentEnvPlaceholders(string(data)), rel, nil
					}
				}
			}
		}
	}

	// 3. Search embedded proxies in data/deployments/*.yaml
	depDir := filepath.Join(s.BundleManager.DataDir, "deployments")
	if depEntries, err := os.ReadDir(depDir); err == nil {
		for _, de := range depEntries {
			if de.IsDir() || (!strings.HasSuffix(de.Name(), ".yaml") && !strings.HasSuffix(de.Name(), ".yml")) {
				continue
			}
			depPath := filepath.Join(depDir, de.Name())
			depData, err := os.ReadFile(depPath)
			if err != nil {
				continue
			}
			depSubstituted := SubstituteDeploymentEnvPlaceholders(string(depData))
			var depMap map[string]interface{}
			if err := yaml.Unmarshal([]byte(depSubstituted), &depMap); err != nil {
				continue
			}
			if proxiesList, ok := depMap["proxies"].([]interface{}); ok {
				for _, pItem := range proxiesList {
					if pMap, ok := pItem.(map[string]interface{}); ok {
						if pName, ok := pMap["name"].(string); ok && strings.EqualFold(pName, name) {
							if yBytes, err := yaml.Marshal(pMap); err == nil {
								return SubstituteDeploymentEnvPlaceholders(string(yBytes)), fmt.Sprintf("%s (embedded proxy)", de.Name()), nil
							}
						}
					}
				}
			}
		}
	}

	// 4. Fallback: inspect zip bundle from data/bundles/<name>.zip
	zipPath := filepath.Join(s.BundleManager.DataDir, "bundles", name+".zip")
	if _, err := os.Stat(zipPath); err == nil {
		bInfo, err := s.BundleManager.InspectBundle(zipPath)
		if err == nil && bInfo != nil {
			var sb strings.Builder
			sb.WriteString("# yaml-language-server: $schema=https://raw.githubusercontent.com/apigee/apigee-templater/main/schema/gateway.schema.1.0.json\n")
			sb.WriteString(fmt.Sprintf("name: %s\n", bInfo.ProxyName))
			sb.WriteString(fmt.Sprintf("displayName: %s\n", bInfo.ProxyName))
			sb.WriteString("type: proxy\n")
			sb.WriteString("gateway: apigee\n")
			sb.WriteString("schemaVersion: 1.0.0\n")
			sb.WriteString("description: Proxy bundle inspected from " + bInfo.FileName + "\n")
			sb.WriteString("endpoints:\n")
			for i, bp := range bInfo.BasePaths {
				epName := "default"
				if i > 0 {
					epName = fmt.Sprintf("endpoint-%d", i+1)
				}
				sb.WriteString(fmt.Sprintf("  - name: %s\n", epName))
				sb.WriteString(fmt.Sprintf("    basePath: %s\n", bp))
				if len(bInfo.TargetRoutes) > 0 {
					sb.WriteString("    routes:\n")
					for _, tr := range bInfo.TargetRoutes {
						sb.WriteString(fmt.Sprintf("      - name: route-%s\n", strings.ToLower(tr)))
						sb.WriteString(fmt.Sprintf("        target: %s\n", tr))
					}
				}
			}
			if len(bInfo.TargetRoutes) > 0 {
				sb.WriteString("targets:\n")
				for _, tr := range bInfo.TargetRoutes {
					sb.WriteString(fmt.Sprintf("  - name: %s\n", tr))
					sb.WriteString(fmt.Sprintf("    url: https://%s.service.internal\n", strings.ToLower(tr)))
				}
			}
			if len(bInfo.Policies) > 0 {
				sb.WriteString("policies:\n")
				for _, pol := range bInfo.Policies {
					sb.WriteString(fmt.Sprintf("  - name: %s\n", pol))
				}
			}
			return sb.String(), fmt.Sprintf("%s (bundle inspection)", bInfo.FileName), nil
		}
	}

	return "", "", fmt.Errorf("proxy YAML definition not found for %q", name)
}


func (s *Server) handleEmulatorState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	health, _ := s.EmulatorClient.CheckHealth()
	online := health != nil && health.Online

	treeRaw, _ := s.EmulatorClient.GetRawDeploymentTree()
	deployedProxies, _ := s.EmulatorClient.GetDeploymentTree()
	bundles, _ := s.BundleManager.ListBundles()
	products, _ := s.BundleManager.GetProducts()
	users, _ := s.BundleManager.GetUsers()
	apps, _ := s.BundleManager.GetApps()
	maps, _ := s.BundleManager.GetMaps()
	datacollectors, _ := s.BundleManager.GetDataCollectors()

	lastUploadTime, lastStatus := s.getTestDataStatus()
	lastUploadStr := ""
	if !lastUploadTime.IsZero() {
		lastUploadStr = lastUploadTime.Format(time.RFC3339)
	}

	var checks []ValidationCheck

	// Check 1: Emulator connectivity
	if online {
		checks = append(checks, ValidationCheck{
			Category: "Connectivity",
			Title:    "Emulator Management & Runtime API",
			Status:   "PASS",
			Message:  fmt.Sprintf("Connected to Emulator Management (%s) and Runtime (%s)", s.EmulatorClient.MgmtURL, s.EmulatorClient.RuntimeURL),
		})
	} else {
		checks = append(checks, ValidationCheck{
			Category: "Connectivity",
			Title:    "Emulator Management & Runtime API",
			Status:   "FAIL",
			Message:  fmt.Sprintf("Could not connect to emulator at %s", s.EmulatorClient.MgmtURL),
		})
	}

	// Check 2: Deployed proxies
	if len(deployedProxies) > 0 {
		var names []string
		for _, p := range deployedProxies {
			names = append(names, fmt.Sprintf("%s (%s)", p.Name, p.BasePath))
		}
		checks = append(checks, ValidationCheck{
			Category: "Proxies",
			Title:    "Deployed Active Proxies",
			Status:   "PASS",
			Message:  fmt.Sprintf("%d active proxies deployed in emulator: %s", len(deployedProxies), strings.Join(names, ", ")),
		})
	} else {
		checks = append(checks, ValidationCheck{
			Category: "Proxies",
			Title:    "Deployed Active Proxies",
			Status:   "WARN",
			Message:  "No proxies are currently deployed in the emulator. Click 'Deploy All Bundles' to deploy.",
		})
	}

	// Check 3: Products configuration
	if len(products) > 0 {
		hasLLM := false
		var prodNames []string
		for _, p := range products {
			name, _ := p["name"].(string)
			prodNames = append(prodNames, name)
			if llm, ok := p["llmOperationGroup"].(map[string]interface{}); ok {
				if cfgs, ok := llm["operationConfigs"].([]interface{}); ok && len(cfgs) > 0 {
					hasLLM = true
				}
			}
		}
		msg := fmt.Sprintf("%d API product(s) configured: %s", len(products), strings.Join(prodNames, ", "))
		if hasLLM {
			msg += " (includes AI/LLM operation configurations)"
		}
		checks = append(checks, ValidationCheck{
			Category: "Products",
			Title:    "API Products Loaded",
			Status:   "PASS",
			Message:  msg,
		})
	} else {
		checks = append(checks, ValidationCheck{
			Category: "Products",
			Title:    "API Products Loaded",
			Status:   "FAIL",
			Message:  "No products found in data/products/products.json.",
		})
	}

	// Check 4: Developer Apps & Credentials
	totalCreds := 0
	appKeys := make(map[string]bool)
	for _, app := range apps {
		if creds, ok := app["credentials"].([]interface{}); ok {
			for _, c := range creds {
				if cMap, ok := c.(map[string]interface{}); ok {
					if key, ok := cMap["consumerKey"].(string); ok && key != "" {
						appKeys[key] = true
						totalCreds++
					}
				}
			}
		}
	}
	if len(apps) > 0 && totalCreds > 0 {
		var keyList []string
		for k := range appKeys {
			keyList = append(keyList, k)
		}
		checks = append(checks, ValidationCheck{
			Category: "Apps",
			Title:    "Developer Apps & Consumer Keys",
			Status:   "PASS",
			Message:  fmt.Sprintf("%d app(s) registered with %d active consumer key(s): %s", len(apps), totalCreds, strings.Join(keyList, ", ")),
		})
	} else {
		checks = append(checks, ValidationCheck{
			Category: "Apps",
			Title:    "Developer Apps & Consumer Keys",
			Status:   "FAIL",
			Message:  "No developer apps or credentials found in data/developerapps/developerapps.json.",
		})
	}

	// Check 5: Test Suite API Key Verification
	var tests []TestCase
	if s.DeploymentManager != nil {
		tests, _ = s.DeploymentManager.LoadAllTests()
	}
	missingKeys := make(map[string]bool)
	usedKeys := make(map[string]bool)
	for _, t := range tests {
		for k, v := range t.Headers {
			if strings.EqualFold(k, "x-api-key") || strings.EqualFold(k, "apikey") || strings.EqualFold(k, "x-ai-key") {
				usedKeys[v] = true
				if !appKeys[v] {
					missingKeys[v] = true
				}
			}
		}
	}
	if len(missingKeys) == 0 && len(usedKeys) > 0 {
		var verifiedList []string
		for k := range usedKeys {
			verifiedList = append(verifiedList, k)
		}
		checks = append(checks, ValidationCheck{
			Category: "Tests",
			Title:    "Test Suite Key Authorization",
			Status:   "PASS",
			Message:  fmt.Sprintf("All test API keys (%s) match authorized developer app credentials in the emulator.", strings.Join(verifiedList, ", ")),
		})
	} else if len(missingKeys) > 0 {
		var unauth []string
		for k := range missingKeys {
			unauth = append(unauth, k)
		}
		checks = append(checks, ValidationCheck{
			Category: "Tests",
			Title:    "Test Suite Key Authorization",
			Status:   "WARN",
			Message:  fmt.Sprintf("Some tests use API key(s) not registered in developer apps: %s", strings.Join(unauth, ", ")),
		})
	}

	// Check 6: Emulator Datastore Upload Status
	if lastStatus != "" {
		statusType := "PASS"
		if strings.Contains(strings.ToLower(lastStatus), "fail") || strings.Contains(strings.ToLower(lastStatus), "error") {
			statusType = "FAIL"
		}
		uploadInfo := ""
		if lastUploadStr != "" {
			uploadInfo = " (Last upload: " + lastUploadStr + ")"
		}
		checks = append(checks, ValidationCheck{
			Category: "Datastore",
			Title:    "Emulator Datastore (Cassandra) Test Data",
			Status:   statusType,
			Message:  fmt.Sprintf("Status: %s%s", lastStatus, uploadInfo),
		})
	} else {
		checks = append(checks, ValidationCheck{
			Category: "Datastore",
			Title:    "Emulator Datastore (Cassandra) Test Data",
			Status:   "WARN",
			Message:  "Test data has not yet been pushed in this session. Click 'Deploy All Bundles' or 'Re-upload Test Data' to populate.",
		})
	}

	resp := EmulatorStateResponse{
		Online:             online,
		MgmtURL:            s.EmulatorClient.MgmtURL,
		RuntimeURL:         s.EmulatorClient.RuntimeURL,
		DeploymentTree:     treeRaw,
		ActiveProxies:      deployedProxies,
		PackagedBundles:    bundles,
		Products:           products,
		Users:              users,
		Apps:               apps,
		Maps:               maps,
		DataCollectors:     datacollectors,
		TestDataLoaded:     lastStatus != "" && !strings.Contains(strings.ToLower(lastStatus), "fail"),
		LastTestDataUpload: lastUploadStr,
		LastTestDataStatus: lastStatus,
		ValidationChecks:   checks,
		TotalActiveProxies: len(deployedProxies),
		TotalProducts:      len(products),
		TotalUsers:         len(users),
		TotalApps:          len(apps),
	}

	jsonResponse(w, http.StatusOK, resp)
}

func (s *Server) handleSetupTestData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	s.deployMu.Lock()
	defer s.deployMu.Unlock()

	bundles, _ := s.BundleManager.ListBundles()
	var proxyNames []string
	for _, b := range bundles {
		proxyNames = append(proxyNames, b.ProxyName)
	}

	testDataBytes, err := s.BundleManager.BuildTestDataBundle(proxyNames)
	if err != nil {
		s.recordTestDataStatus(fmt.Sprintf("Build failed: %v", err))
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	if err := s.EmulatorClient.SetupTestData(testDataBytes); err != nil {
		s.recordTestDataStatus(fmt.Sprintf("Upload failed: %v", err))
		jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	s.recordTestDataStatus("Loaded successfully into Apigee emulator datastore")

	// Sync Cassandra developer app credentials (e.g. test-app-key-123)
	go func() {
		time.Sleep(500 * time.Millisecond)
		if err := SyncCassandraDeveloperAppKeys(s.BundleManager.DataDir, filepath.Join(s.BundleManager.RootDir, "dist")); err != nil {
			log.Printf("Cassandra credential sync notice: %v", err)
		}
	}()

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Test data bundle (products, developers, apps, credentials) re-uploaded and initialized in emulator",
	})
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
		s.recordTestDataStatus(fmt.Sprintf("Build failed: %v", err))
	} else {
		if err := s.EmulatorClient.SetupTestData(testDataBytes); err != nil {
			log.Printf("Warning uploading testdata: %v", err)
			s.recordTestDataStatus(fmt.Sprintf("Upload failed: %v", err))
		} else {
			s.recordTestDataStatus("Loaded successfully into Apigee emulator datastore")
			go func() {
				time.Sleep(500 * time.Millisecond)
				if err := SyncCassandraDeveloperAppKeys(s.BundleManager.DataDir, filepath.Join(s.BundleManager.RootDir, "dist")); err != nil {
					log.Printf("Cassandra credential sync notice: %v", err)
				}
			}()
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
