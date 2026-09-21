package main

import (
	"encoding/json"
	"sync"
	"testing"
)

func TestDeployStateConcurrency(t *testing.T) {
	s := &Server{}
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(idx int) {
			defer wg.Done()
			s.setDeployState(idx%2 == 0, "status message", "")
		}(i)

		go func() {
			defer wg.Done()
			_, _, _ = s.getDeployState()
		}()
	}

	wg.Wait()
}

func TestEmulatorStatusJSON(t *testing.T) {
	status := EmulatorStatus{
		Online:        true,
		IsDeploying:   true,
		DeployMessage: "Deploying all proxy bundles...",
	}

	data, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Failed to marshal EmulatorStatus: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	if isDeploying, ok := parsed["isDeploying"].(bool); !ok || !isDeploying {
		t.Errorf("Expected isDeploying to be true, got %v", parsed["isDeploying"])
	}

	if msg, ok := parsed["deployMessage"].(string); !ok || msg != "Deploying all proxy bundles..." {
		t.Errorf("Expected deployMessage to match, got %v", parsed["deployMessage"])
	}
}

func TestDeployResponseJSON(t *testing.T) {
	resp := DeployResponse{
		Success:       true,
		Message:       "Deployed successfully",
		TotalDeployed: 3,
		DeployedCount: 3,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal DeployResponse: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	if total, ok := parsed["totalDeployed"].(float64); !ok || int(total) != 3 {
		t.Errorf("Expected totalDeployed 3, got %v", parsed["totalDeployed"])
	}
	if count, ok := parsed["deployedCount"].(float64); !ok || int(count) != 3 {
		t.Errorf("Expected deployedCount 3, got %v", parsed["deployedCount"])
	}
}
