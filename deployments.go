package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// DeploymentManager reads deployment definitions and tests.
type DeploymentManager struct {
	DataDir string
}

// NewDeploymentManager creates a new DeploymentManager.
func NewDeploymentManager(dataDir string) *DeploymentManager {
	return &DeploymentManager{DataDir: dataDir}
}

// ListDeployments loads all *.yaml files from data/deployments/.
func (dm *DeploymentManager) ListDeployments() ([]DeploymentConfig, error) {
	depDir := filepath.Join(dm.DataDir, "deployments")
	entries, err := os.ReadDir(depDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []DeploymentConfig{}, nil
		}
		return nil, fmt.Errorf("read deployments dir: %w", err)
	}

	var results []DeploymentConfig
	for _, entry := range entries {
		if entry.IsDir() || (!strings.HasSuffix(entry.Name(), ".yaml") && !strings.HasSuffix(entry.Name(), ".yml")) {
			continue
		}

		fPath := filepath.Join(depDir, entry.Name())
		data, err := os.ReadFile(fPath)
		if err != nil {
			continue
		}

		var raw map[string]interface{}
		if err := yaml.Unmarshal(data, &raw); err != nil {
			continue
		}

		name := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		var templates []string
		if tList, ok := raw["templates"].([]interface{}); ok {
			for _, t := range tList {
				if s, ok := t.(string); ok {
					templates = append(templates, s)
				}
			}
		}

		var products []interface{}
		if pList, ok := raw["products"].([]interface{}); ok {
			products = pList
		}

		var users []interface{}
		if uList, ok := raw["users"].([]interface{}); ok {
			users = uList
		}

		var tests []TestCase
		if testList, ok := raw["tests"].([]interface{}); ok {
			for _, tItem := range testList {
				if tMap, ok := tItem.(map[string]interface{}); ok {
					tc := TestCase{
						Deployment: name,
					}
					if s, ok := tMap["name"].(string); ok {
						tc.Name = s
					}
					if s, ok := tMap["description"].(string); ok {
						tc.Description = s
					}
					if s, ok := tMap["proxy"].(string); ok {
						tc.Proxy = s
					}
					if s, ok := tMap["verb"].(string); ok {
						tc.Verb = s
					} else if s, ok := tMap["method"].(string); ok {
						tc.Verb = s
					}
					if s, ok := tMap["path"].(string); ok {
						tc.Path = s
					}
					if s, ok := tMap["payload"].(string); ok {
						tc.Payload = s
					}
					if hMap, ok := tMap["headers"].(map[string]interface{}); ok {
						tc.Headers = make(map[string]string)
						for k, v := range hMap {
							tc.Headers[k] = fmt.Sprintf("%v", v)
						}
					}
					if aList, ok := tMap["assertions"].([]interface{}); ok {
						for _, a := range aList {
							if s, ok := a.(string); ok && strings.TrimSpace(s) != "" {
								tc.Assertions = append(tc.Assertions, strings.TrimSpace(s))
							}
						}
					}
					if tc.Path == "" {
						tc.Path = defaultPathForProxy(tc.Proxy)
					}
					if tc.Verb == "" {
						if tc.Payload != "" {
							tc.Verb = "POST"
						} else {
							tc.Verb = "GET"
						}
					}
					tests = append(tests, tc)
				}
			}
		}

		results = append(results, DeploymentConfig{
			Name:      name,
			FilePath:  fPath,
			Templates: templates,
			Products:  products,
			Users:     users,
			Tests:     tests,
		})
	}

	return results, nil
}

// LoadAllTests aggregates tests from deployments and data/tests.json.
func (dm *DeploymentManager) LoadAllTests() ([]TestCase, error) {
	var allTests []TestCase

	isDuplicate := func(candidate TestCase) bool {
		for _, ex := range allTests {
			if strings.EqualFold(ex.Name, candidate.Name) {
				return true
			}
			if strings.EqualFold(ex.Proxy, candidate.Proxy) &&
				strings.EqualFold(ex.Verb, candidate.Verb) &&
				strings.EqualFold(ex.Path, candidate.Path) {
				return true
			}
		}
		return false
	}

	// 1. From deployments (primary source of truth)
	deps, err := dm.ListDeployments()
	if err == nil {
		for _, dep := range deps {
			for _, t := range dep.Tests {
				if !isDuplicate(t) {
					allTests = append(allTests, t)
				}
			}
		}
	}

	// 2. From data/tests.json if present
	testsJSONPath := filepath.Join(dm.DataDir, "tests.json")
	if data, err := os.ReadFile(testsJSONPath); err == nil {
		var list []TestCase
		if err := json.Unmarshal(data, &list); err == nil {
			for _, t := range list {
				if !isDuplicate(t) {
					allTests = append(allTests, t)
				}
			}
		}
	}

	// 3. Fallback default test cases if empty
	if len(allTests) == 0 {
		allTests = []TestCase{
			{
				Name:        "testproxy-test1",
				Description: "This tests if the /testproxy path actually returns a 200.",
				Proxy:       "TestProxy",
				Verb:        "GET",
				Path:        "/testproxy",
				Headers:     map[string]string{"x-api-key": "test-api-key-12345"},
				Payload:     "",
				Assertions:  []string{"status.code == 200"},
			},
		}
	}

	return allTests, nil
}

func defaultPathForProxy(proxy string) string {
	switch strings.TrimSpace(proxy) {
	case "REST-AI-Completions":
		return "/v1/chat/completions"
	case "REST-AI-Messages":
		return "/v1/messages"
	case "REST-AI-GenerateContent":
		return "/v1beta/models"
	case "REST-AI-Interactions":
		return "/v1/interactions"
	case "REST-AI-Embeddings":
		return "/v1/embeddings"
	case "REST-AI-Images":
		return "/v1/images/generations"
	case "TestProxy":
		return "/testproxy"
	default:
		if proxy != "" {
			return "/" + strings.ToLower(proxy)
		}
		return "/"
	}
}
