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
					if s, ok := tMap["proxy"].(string); ok {
						tc.Proxy = s
					}
					if s, ok := tMap["verb"].(string); ok {
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

	// 1. From data/tests.json if present
	testsJSONPath := filepath.Join(dm.DataDir, "tests.json")
	if data, err := os.ReadFile(testsJSONPath); err == nil {
		var list []TestCase
		if err := json.Unmarshal(data, &list); err == nil {
			allTests = append(allTests, list...)
		}
	}

	// 2. From deployments
	deps, err := dm.ListDeployments()
	if err == nil {
		for _, dep := range deps {
			for _, t := range dep.Tests {
				// avoid duplicates
				exists := false
				for _, ex := range allTests {
					if ex.Name == t.Name {
						exists = true
						break
					}
				}
				if !exists {
					allTests = append(allTests, t)
				}
			}
		}
	}

	// 3. Fallback default test cases if empty
	if len(allTests) == 0 {
		allTests = []TestCase{
			{
				Name:    "testproxy-get",
				Proxy:   "TestProxy",
				Verb:    "GET",
				Path:    "/testproxy",
				Headers: map[string]string{"x-api-key": "test-api-key-12345"},
				Payload: "",
			},
			{
				Name:  "chat-completions-gemini-3.8-flash",
				Proxy: "REST-AI-Completions",
				Verb:  "POST",
				Path:  "/v1/chat/completions",
				Headers: map[string]string{
					"x-api-key":    "starter-app-key-123",
					"Content-Type": "application/json",
				},
				Payload: `{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Hello from Apigee Emulator Manager!"}]}`,
			},
			{
				Name:  "chat-completions-streaming",
				Proxy: "REST-AI-Completions",
				Verb:  "POST",
				Path:  "/v1/chat/completions",
				Headers: map[string]string{
					"x-api-key":    "starter-app-key-123",
					"Content-Type": "application/json",
				},
				Payload: `{"model":"gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"Count from 1 to 5."}]}`,
			},
		}
	}

	return allTests, nil
}
