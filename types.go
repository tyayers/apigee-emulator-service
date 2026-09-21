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
}

// DeployedProxy represents an active proxy deployed in the emulator.
type DeployedProxy struct {
	Name     string `json:"name"`
	Revision string `json:"revision"`
	BasePath string `json:"basePath"`
	URL      string `json:"url"`
}

// BundleInfo describes a proxy bundle packaged in data/bundles.
type BundleInfo struct {
	FileName     string    `json:"fileName"`
	ProxyName    string    `json:"proxyName"`
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
	Name       string            `json:"name"`
	Proxy      string            `json:"proxy"`
	Verb       string            `json:"verb"`
	Path       string            `json:"path"`
	Headers    map[string]string `json:"headers"`
	Payload    string            `json:"payload"`
	Assertions []string          `json:"assertions,omitempty"`
	Deployment string            `json:"deployment,omitempty"`
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

// TestRequest represents a test call executed from the Postman-style UI.
type TestRequest struct {
	Proxy       string            `json:"proxy"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Headers     map[string]string `json:"headers"`
	Body        string            `json:"body"`
	RecordTrace bool              `json:"recordTrace"`
}

// TestResponse represents the outcome of a test invocation including optional trace.
type TestResponse struct {
	StatusCode     int                    `json:"statusCode"`
	StatusText     string                 `json:"statusText"`
	DurationMs     int64                  `json:"durationMs"`
	Headers        map[string]string      `json:"headers"`
	Body           string                 `json:"body"`
	TraceSessionID string                 `json:"traceSessionId,omitempty"`
	TraceData      map[string]interface{} `json:"traceData,omitempty"`
	Error          string                 `json:"error,omitempty"`
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
