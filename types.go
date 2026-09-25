package main

import "time"

// EmulatorStatus represents the health and status of the Apigee emulator.
type EmulatorStatus struct {
	Online          bool               `json:"online"`
	MgmtURL         string             `json:"mgmtUrl"`
	RuntimeURL      string             `json:"runtimeUrl"`
	CassandraReady  bool               `json:"cassandraReady"`
	ActiveProxies   []DeployedProxy    `json:"activeProxies"`
	TotalProxies    int                `json:"totalProxies"`
	AvailableBundles []BundleInfo      `json:"availableBundles"`
	CheckedAt        time.Time       `json:"checkedAt"`
	Error            string          `json:"error,omitempty"`
	IsDeploying      bool            `json:"isDeploying"`
	DeployMessage    string          `json:"deployMessage,omitempty"`
	Products         []map[string]interface{} `json:"products,omitempty"`
	Users            []map[string]interface{} `json:"users,omitempty"`
	Apps             []map[string]interface{} `json:"apps,omitempty"`
}

// DeployedProxy represents an active proxy deployed in the emulator.
type DeployedProxy struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Revision    string `json:"revision"`
	BasePath    string `json:"basePath"`
	URL         string `json:"url"`
}

// BundleInfo describes a proxy bundle packaged in data/bundles.
type BundleInfo struct {
	FileName     string    `json:"fileName"`
	ProxyName    string    `json:"proxyName"`
	DisplayName  string    `json:"displayName,omitempty"`
	BasePaths    []string  `json:"basePaths"`
	SizeBytes    int64     `json:"sizeBytes"`
	ModifiedAt   time.Time `json:"modifiedAt"`
	IsDeployed   bool      `json:"isDeployed"`
	TargetRoutes []string  `json:"targetRoutes,omitempty"`
	Policies     []string  `json:"policies,omitempty"`
}

// DeploymentConfig represents a deployment yaml configuration.
type DeploymentConfig struct {
	Name      string        `json:"name"`
	FilePath  string        `json:"filePath"`
	Templates []string      `json:"templates"`
	Products  []interface{} `json:"products"`
	Users     []interface{} `json:"users"`
	Tests     []TestCase    `json:"tests"`
}

// TestCase represents a pre-configured API test.
type TestCase struct {
	Name             string            `json:"name"`
	Description      string            `json:"description,omitempty"`
	Proxy            string            `json:"proxy"`
	ProxyDisplayName string            `json:"proxyDisplayName,omitempty"`
	Verb             string            `json:"verb"`
	Path             string            `json:"path"`
	Headers          map[string]string `json:"headers"`
	Payload          string            `json:"payload"`
	Body             string            `json:"body,omitempty"`
	Request          string            `json:"request,omitempty"`
	Assertions       []string          `json:"assertions,omitempty"`
	Deployment       string            `json:"deployment,omitempty"`
}

// DeployRequest represents payload sent to /tester/api/deploy.
type DeployRequest struct {
	Bundles []string `json:"bundles"`
	All     bool     `json:"all"`
	Reset   bool     `json:"reset"`
}

// DeployResponse represents the result of a deployment action.
type DeployResponse struct {
	Success       bool            `json:"success"`
	Message       string          `json:"message"`
	Revision      string          `json:"revision,omitempty"`
	Deployed      []DeployedProxy `json:"deployed"`
	TotalDeployed int             `json:"totalDeployed"`
	DeployedCount int             `json:"deployedCount"`
	DurationMs    int64           `json:"durationMs"`
	Error         string          `json:"error,omitempty"`
}

// AssertionResult represents the evaluation of a single assertion.
type AssertionResult struct {
	Assertion string `json:"assertion"`
	Passed    bool   `json:"passed"`
	Actual    string `json:"actual"`
	Expected  string `json:"expected"`
	Error     string `json:"error,omitempty"`
}

// TestRunResult records a test execution and assertion results in memory.
type TestRunResult struct {
	ID             string                 `json:"id"`
	TestName       string                 `json:"testName"`
	Proxy          string                 `json:"proxy"`
	Deployment     string                 `json:"deployment,omitempty"`
	Timestamp      time.Time              `json:"timestamp"`
	Passed         bool                   `json:"passed"`
	StatusCode     int                    `json:"statusCode"`
	StatusText     string                 `json:"statusText"`
	DurationMs     int64                  `json:"durationMs"`
	Request        TestRequest            `json:"request"`
	Response       *TestResponse          `json:"response"`
	Assertions     []AssertionResult      `json:"assertions"`
	TraceSessionID string                 `json:"traceSessionId,omitempty"`
	TraceData      map[string]interface{} `json:"traceData,omitempty"`
	Error          string                 `json:"error,omitempty"`
}

// TestsRunRequest specifies parameters for running a test suite.
type TestsRunRequest struct {
	Proxy       string `json:"proxy,omitempty"`
	TestName    string `json:"testName,omitempty"`
	RecordTrace bool   `json:"recordTrace"`
}

// TestsRunResponse summarizes the execution of multiple tests.
type TestsRunResponse struct {
	Total      int             `json:"total"`
	Passed     int             `json:"passed"`
	Failed     int             `json:"failed"`
	DurationMs int64           `json:"durationMs"`
	Results    []TestRunResult `json:"results"`
}

// TestRequest represents a test call executed from the Postman-style UI.
type TestRequest struct {
	Proxy       string            `json:"proxy"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Headers     map[string]string `json:"headers"`
	Body        string            `json:"body"`
	RecordTrace bool              `json:"recordTrace"`
	TestName    string            `json:"testName,omitempty"`
	Assertions  []string          `json:"assertions,omitempty"`
}

// TestResponse represents the outcome of a test invocation including optional trace.
type TestResponse struct {
	StatusCode      int                    `json:"statusCode"`
	StatusText      string                 `json:"statusText"`
	DurationMs      int64                  `json:"durationMs"`
	TargetLatencyMs *int64                 `json:"targetLatencyMs,omitempty"`
	Headers         map[string]string      `json:"headers"`
	Body            string                 `json:"body"`
	TraceSessionID  string                 `json:"traceSessionId,omitempty"`
	TraceData       map[string]interface{} `json:"traceData,omitempty"`
	Assertions      []AssertionResult      `json:"assertions,omitempty"`
	Passed          bool                   `json:"passed"`
	TestRunID       string                 `json:"testRunId,omitempty"`
	Error           string                 `json:"error,omitempty"`
	Request         *TestRequest           `json:"request,omitempty"`
}

// AnalyticsSaveResponse represents the response from saving analytics.
type AnalyticsSaveResponse struct {
	Success bool                   `json:"success"`
	ID      string                 `json:"id,omitempty"`
	Record  map[string]interface{} `json:"record,omitempty"`
	Error   string                 `json:"error,omitempty"`
}

// AnalyticsQueryResponse represents the response containing retrieved analytics records.
type AnalyticsQueryResponse struct {
	Records   []map[string]interface{} `json:"records"`
	Count     int                      `json:"count"`
	ProjectID string                   `json:"projectId,omitempty"`
	Database  string                   `json:"database,omitempty"`
	Error     string                   `json:"error,omitempty"`
}

// ValidationCheck represents a health and integrity validation item.
type ValidationCheck struct {
	Category string `json:"category"` // "Connectivity", "Proxies", "Products", "Apps", "Credentials", "Tests"
	Title    string `json:"title"`
	Status   string `json:"status"` // "PASS", "WARN", "FAIL"
	Message  string `json:"message"`
}

// EmulatorStateResponse represents comprehensive state and inspection data of the emulator.
type EmulatorStateResponse struct {
	Online             bool                     `json:"online"`
	MgmtURL            string                   `json:"mgmtUrl"`
	RuntimeURL         string                   `json:"runtimeUrl"`
	DeploymentTree     interface{}              `json:"deploymentTree"`
	ActiveProxies      []DeployedProxy          `json:"activeProxies"`
	PackagedBundles    []BundleInfo             `json:"packagedBundles"`
	Products           []map[string]interface{} `json:"products"`
	Users              []map[string]interface{} `json:"users"`
	Apps               []map[string]interface{} `json:"apps"`
	Maps               []map[string]interface{} `json:"maps"`
	DataCollectors     []map[string]interface{} `json:"dataCollectors"`
	TestDataLoaded     bool                     `json:"testDataLoaded"`
	LastTestDataUpload string                   `json:"lastTestDataUpload,omitempty"`
	LastTestDataStatus string                   `json:"lastTestDataStatus,omitempty"`
	ValidationChecks   []ValidationCheck        `json:"validationChecks"`
	TotalActiveProxies int                      `json:"totalActiveProxies"`
	TotalProducts      int                      `json:"totalProducts"`
	TotalUsers         int                      `json:"totalUsers"`
	TotalApps          int                      `json:"totalApps"`
}

// ProxyYamlResponse represents the response containing a proxy's YAML definition.
type ProxyYamlResponse struct {
	Success     bool   `json:"success"`
	Proxy       string `json:"proxy"`
	DisplayName string `json:"displayName,omitempty"`
	YAML        string `json:"yaml,omitempty"`
	Source      string `json:"source,omitempty"`
	Error       string `json:"error,omitempty"`
}
