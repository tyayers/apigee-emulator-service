package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// EmulatorClient encapsulates communication with Apigee emulator.
type EmulatorClient struct {
	MgmtURL    string
	RuntimeURL string
	HTTPClient *http.Client
}

// NewEmulatorClient creates a new EmulatorClient instance.
func NewEmulatorClient(mgmtURL, runtimeURL string) *EmulatorClient {
	return &EmulatorClient{
		MgmtURL:    strings.TrimRight(mgmtURL, "/"),
		RuntimeURL: strings.TrimRight(runtimeURL, "/"),
		HTTPClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// CheckHealth queries the emulator management API to verify connectivity.
func (c *EmulatorClient) CheckHealth() (*EmulatorStatus, error) {
	status := &EmulatorStatus{
		Online:     false,
		MgmtURL:    c.MgmtURL,
		RuntimeURL: c.RuntimeURL,
		CheckedAt:  time.Now(),
	}

	tree, err := c.GetDeploymentTree()
	if err != nil {
		status.Error = err.Error()
		return status, err
	}

	status.Online = true
	status.CassandraReady = true
	status.ActiveProxies = tree
	status.TotalProxies = len(tree)
	return status, nil
}

// Reset calls POST /v1/emulator/reset to clear deployed proxies and state.
func (c *EmulatorClient) Reset() error {
	req, err := http.NewRequest(http.MethodPost, c.MgmtURL+"/v1/emulator/reset", nil)
	if err != nil {
		return fmt.Errorf("failed to create reset request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("reset request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("reset returned status %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

// SetupTestData uploads testdata.zip to POST /v1/emulator/setup/tests.
func (c *EmulatorClient) SetupTestData(zipBytes []byte) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("file", "testdata.zip")
	if err != nil {
		return fmt.Errorf("failed to create multipart form file: %w", err)
	}

	if _, err := io.Copy(part, bytes.NewReader(zipBytes)); err != nil {
		return fmt.Errorf("failed to copy test data to multipart writer: %w", err)
	}

	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to close multipart writer: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, c.MgmtURL+"/v1/emulator/setup/tests", &body)
	if err != nil {
		return fmt.Errorf("failed to create setup/tests request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("setup/tests request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("setup/tests returned status %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// DeployBundle uploads bundle.zip to POST /v1/emulator/deploy?environment=test.
func (c *EmulatorClient) DeployBundle(environment string, zipBytes []byte) (string, error) {
	if environment == "" {
		environment = "test"
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("file", "bundle.zip")
	if err != nil {
		return "", fmt.Errorf("failed to create multipart form file: %w", err)
	}

	if _, err := io.Copy(part, bytes.NewReader(zipBytes)); err != nil {
		return "", fmt.Errorf("failed to copy bundle to multipart writer: %w", err)
	}

	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("failed to close multipart writer: %w", err)
	}

	targetURL := fmt.Sprintf("%s/v1/emulator/deploy?environment=%s", c.MgmtURL, environment)
	req, err := http.NewRequest(http.MethodPost, targetURL, &body)
	if err != nil {
		return "", fmt.Errorf("failed to create deploy request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("deploy request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("deploy returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(respBody, &parsed); err == nil {
		if rev, ok := parsed["revision"].(string); ok {
			return rev, nil
		}
	}
	return string(respBody), nil
}

// GetDeploymentTree queries GET /v1/emulator/tree and extracts deployed proxies.
func (c *EmulatorClient) GetDeploymentTree() ([]DeployedProxy, error) {
	req, err := http.NewRequest(http.MethodGet, c.MgmtURL+"/v1/emulator/tree", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create tree request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to emulator at %s: %w", c.MgmtURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("tree returned status %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read tree body: %w", err)
	}

	var results []DeployedProxy

	// 1. Try decoding as array: [{"application":"TestProxy","name":"default","basePath":"testproxy",...}]
	var list []map[string]interface{}
	if err := json.Unmarshal(body, &list); err == nil {
		for _, item := range list {
			appName, _ := item["application"].(string)
			if appName == "" {
				appName, _ = item["name"].(string)
			}
			bp, _ := item["basePath"].(string)
			if bp == "" {
				bp, _ = item["basepath"].(string)
			}
			if bp != "" && !strings.HasPrefix(bp, "/") {
				bp = "/" + bp
			}
			rev, _ := item["revision"].(string)
			if rev == "" {
				rev = "1"
			}
			url := ""
			if bp != "" {
				url = fmt.Sprintf("%s%s", c.RuntimeURL, bp)
			}
			if appName != "" {
				results = append(results, DeployedProxy{
					Name:     appName,
					Revision: rev,
					BasePath: bp,
					URL:      url,
				})
			}
		}
		return results, nil
	}

	// 2. Try decoding as map/object
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err == nil {
		orgs, _ := raw["organizations"].(map[string]interface{})
		for _, envsObj := range orgs {
			envsMap, _ := envsObj.(map[string]interface{})
			for _, envObj := range envsMap {
				envData, _ := envObj.(map[string]interface{})
				proxiesObj, ok := envData["proxies"]
				if !ok {
					proxiesObj = envData["apiproxies"]
				}

				if proxiesMap, ok := proxiesObj.(map[string]interface{}); ok {
					for pName, pVal := range proxiesMap {
						pData, _ := pVal.(map[string]interface{})
						rev := "1"
						basePath := ""
						if revisions, ok := pData["revisions"].(map[string]interface{}); ok {
							for rName, rVal := range revisions {
								rev = rName
								if rData, ok := rVal.(map[string]interface{}); ok {
									if b, ok := rData["basepath"].(string); ok {
										basePath = b
									}
									if b, ok := rData["basePath"].(string); ok {
										basePath = b
									}
								}
								break
							}
						}

						if basePath != "" && !strings.HasPrefix(basePath, "/") {
							basePath = "/" + basePath
						}
						url := ""
						if basePath != "" {
							url = fmt.Sprintf("%s%s", c.RuntimeURL, basePath)
						}

						results = append(results, DeployedProxy{
							Name:     pName,
							Revision: rev,
							BasePath: basePath,
							URL:      url,
						})
					}
				}
			}
		}
	}

	return results, nil
}

// StartTraceSession initiates a trace recording session for a proxy.
func (c *EmulatorClient) StartTraceSession(proxyName string) (string, error) {
	url := fmt.Sprintf("%s/v1/emulator/trace?proxyName=%s", c.MgmtURL, proxyName)
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create trace start request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("trace start failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("trace start returned %d: %s", resp.StatusCode, string(body))
	}

	var res map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", fmt.Errorf("failed to decode trace response: %w", err)
	}

	sessionID, _ := res["name"].(string)
	if sessionID == "" {
		sessionID, _ = res["sessionId"].(string)
	}
	return sessionID, nil
}

// GetTraceTransactions retrieves captured transactions for a session.
func (c *EmulatorClient) GetTraceTransactions(sessionID string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/v1/emulator/trace/transactions?sessionid=%s", c.MgmtURL, sessionID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create trace transactions request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get trace transactions: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("trace transactions returned %d: %s", resp.StatusCode, string(body))
	}

	// Transactions can be an array of transactions or an object with "transaction" key
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
		return parsed, nil
	}

	// Try as array
	var list []interface{}
	if err := json.Unmarshal(bodyBytes, &list); err == nil {
		return map[string]interface{}{
			"transactions": list,
		}, nil
	}

	return map[string]interface{}{
		"raw": string(bodyBytes),
	}, nil
}
