package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gocql/gocql"
)

// SyncCassandraDeveloperAppKeys connects to Cassandra (if running on 127.0.0.1:9042)
// and ensures that developer app credentials (such as consumerKey: test-app-key-123)
// configured in developerapps.json are registered in kms_hybrid_hybrid.app_credential.
// This is required because Apigee Emulator's /v1/emulator/setup/tests generates random keys
// instead of respecting consumerKey from developerapps.json.
func SyncCassandraDeveloperAppKeys(dataDir, distDir string) error {
	cluster := gocql.NewCluster("127.0.0.1")
	cluster.Port = 9042
	cluster.Timeout = 3 * time.Second
	cluster.ConnectTimeout = 3 * time.Second
	cluster.Consistency = gocql.One
	cluster.DisableInitialHostLookup = true

	session, err := cluster.CreateSession()
	if err != nil {
		if dockerErr := syncViaDockerCqlsh(dataDir, distDir); dockerErr == nil {
			return nil
		}
		return fmt.Errorf("cassandra on 127.0.0.1:9042 not reachable: %w", err)
	}
	defer session.Close()

	// 1. Fetch products map: product_name -> UUID
	prodMap := make(map[string]gocql.UUID)
	iterProds := session.Query("SELECT id, name FROM kms_hybrid_hybrid.api_product").Iter()
	var pID gocql.UUID
	var pName string
	for iterProds.Scan(&pID, &pName) {
		prodMap[pName] = pID
	}
	if err := iterProds.Close(); err != nil {
		return fmt.Errorf("failed querying api_product: %w", err)
	}

	if len(prodMap) == 0 {
		return fmt.Errorf("no api_products found in cassandra")
	}

	// 2. Fetch apps map: app_name -> UUID
	appMap := make(map[string]gocql.UUID)
	iterApps := session.Query("SELECT id, name FROM kms_hybrid_hybrid.app").Iter()
	var aID gocql.UUID
	var aName string
	for iterApps.Scan(&aID, &aName) {
		appMap[aName] = aID
	}
	if err := iterApps.Close(); err != nil {
		return fmt.Errorf("failed querying app: %w", err)
	}

	// 3. Find developerapps.json
	var devAppsFile string
	candidates := []string{
		filepath.Join(distDir, "developerapps.json"),
		filepath.Join(dataDir, "developerapps", "developerapps.json"),
		filepath.Join(dataDir, "developerapps.json"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			devAppsFile = c
			break
		}
	}
	if devAppsFile == "" {
		return fmt.Errorf("developerapps.json not found")
	}

	content, err := os.ReadFile(devAppsFile)
	if err != nil {
		return err
	}

	var apps []map[string]interface{}
	if err := json.Unmarshal(content, &apps); err != nil {
		return err
	}

	// Build api_prdt map for app_credential: product_uuid -> 'APPROVED'
	apiPrdtMap := make(map[gocql.UUID]string)
	for _, pUUID := range prodMap {
		apiPrdtMap[pUUID] = "APPROVED"
	}

	syncedCount := 0
	for _, app := range apps {
		appName, _ := app["name"].(string)
		appUUID, ok := appMap[appName]
		if !ok {
			for _, id := range appMap {
				appUUID = id
				ok = true
				break
			}
		}
		if !ok {
			continue
		}

		creds, _ := app["credentials"].([]interface{})
		for _, credRaw := range creds {
			cred, ok := credRaw.(map[string]interface{})
			if !ok {
				continue
			}
			ckey, _ := cred["consumerKey"].(string)
			csec, _ := cred["consumerSecret"].(string)
			if ckey == "" {
				continue
			}
			if csec == "" {
				csec = "secret"
			}

			// Insert into app_credential
			q1 := "INSERT INTO kms_hybrid_hybrid.app_credential (tid, id, app_id, c_at, iss_at, sts, c_sec, api_prdt) VALUES ('hybrid', ?, ?, toTimestamp(now()), toTimestamp(now()), 'APPROVED', ?, ?)"
			if err := session.Query(q1, ckey, appUUID, csec, apiPrdtMap).Exec(); err != nil {
				log.Printf("Warning: failed inserting app_credential for %s: %v", ckey, err)
				continue
			}

			// Insert into app_credential_idx
			q2 := "INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES (?, ?)"
			key1 := fmt.Sprintf("app_id=%s&tid=hybrid", appUUID.String())
			rid := fmt.Sprintf("id=%s:tid=hybrid", ckey)
			_ = session.Query(q2, key1, rid).Exec()

			key2 := "tid=hybrid"
			_ = session.Query(q2, key2, rid).Exec()

			syncedCount++
		}
	}

	log.Printf("Successfully synced %d developer app credential(s) into Cassandra", syncedCount)
	return nil
}

// syncViaDockerCqlsh executes CQL queries via docker exec when Cassandra port 9042 is not directly accessible from the host.
func syncViaDockerCqlsh(dataDir, distDir string) error {
	// Check if docker is available and apigee container is running
	checkCmd := exec.Command("docker", "ps", "--format", "{{.Names}}")
	out, err := checkCmd.Output()
	if err != nil || !strings.Contains(string(out), "apigee") {
		return fmt.Errorf("docker apigee container not running")
	}

	runCql := func(query string) (string, error) {
		cmd := exec.Command("docker", "exec", "apigee", "/opt/apigee/apache-cassandra-4.0.19/bin/cqlsh", "-e", query)
		res, err := cmd.CombinedOutput()
		if err != nil {
			return string(res), fmt.Errorf("cql error: %v: %s", err, string(res))
		}
		return string(res), nil
	}

	prodsRaw, err := runCql("SELECT id, name FROM kms_hybrid_hybrid.api_product;")
	if err != nil {
		return err
	}
	appsRaw, err := runCql("SELECT id, name FROM kms_hybrid_hybrid.app;")
	if err != nil {
		return err
	}

	prodMap := make(map[string]string)
	for _, line := range strings.Split(prodsRaw, "\n") {
		parts := strings.Split(line, "|")
		if len(parts) == 2 {
			id := strings.TrimSpace(parts[0])
			name := strings.TrimSpace(parts[1])
			if len(id) == 36 {
				prodMap[name] = id
			}
		}
	}

	appMap := make(map[string]string)
	for _, line := range strings.Split(appsRaw, "\n") {
		parts := strings.Split(line, "|")
		if len(parts) == 2 {
			id := strings.TrimSpace(parts[0])
			name := strings.TrimSpace(parts[1])
			if len(id) == 36 {
				appMap[name] = id
			}
		}
	}

	candidates := []string{
		filepath.Join(distDir, "developerapps.json"),
		filepath.Join(dataDir, "developerapps", "developerapps.json"),
		filepath.Join(dataDir, "developerapps.json"),
	}
	var devAppsFile string
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			devAppsFile = c
			break
		}
	}
	if devAppsFile == "" {
		return fmt.Errorf("developerapps.json not found")
	}

	content, err := os.ReadFile(devAppsFile)
	if err != nil {
		return err
	}

	var apps []map[string]interface{}
	if err := json.Unmarshal(content, &apps); err != nil {
		return err
	}

	var prodEntries []string
	for _, pid := range prodMap {
		prodEntries = append(prodEntries, fmt.Sprintf("%s: 'APPROVED'", pid))
	}
	prodMapStr := "{" + strings.Join(prodEntries, ", ") + "}"

	syncedCount := 0
	for _, app := range apps {
		appName, _ := app["name"].(string)
		appID, ok := appMap[appName]
		if !ok {
			for _, id := range appMap {
				appID = id
				ok = true
				break
			}
		}
		if !ok {
			continue
		}

		creds, _ := app["credentials"].([]interface{})
		for _, credRaw := range creds {
			cred, ok := credRaw.(map[string]interface{})
			if !ok {
				continue
			}
			ckey, _ := cred["consumerKey"].(string)
			csec, _ := cred["consumerSecret"].(string)
			if ckey == "" {
				continue
			}
			if csec == "" {
				csec = "secret"
			}

			q1 := fmt.Sprintf("INSERT INTO kms_hybrid_hybrid.app_credential (tid, id, app_id, c_at, iss_at, sts, c_sec, api_prdt) VALUES ('hybrid', '%s', %s, toTimestamp(now()), toTimestamp(now()), 'APPROVED', '%s', %s);", ckey, appID, csec, prodMapStr)
			q2 := fmt.Sprintf("INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('app_id=%s&tid=hybrid', 'id=%s:tid=hybrid');", appID, ckey)
			q3 := fmt.Sprintf("INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('tid=hybrid', 'id=%s:tid=hybrid');", ckey)

			_, _ = runCql(q1)
			_, _ = runCql(q2)
			_, _ = runCql(q3)
			syncedCount++
		}
	}

	log.Printf("[Docker Cassandra] Successfully synced %d developer app credential(s) into Cassandra", syncedCount)
	return nil
}
