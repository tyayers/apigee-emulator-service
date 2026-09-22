package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// XML structures for parsing apiproxy definitions
type ProxyEndpointXML struct {
	XMLName      xml.Name        `xml:"ProxyEndpoint"`
	Name         string          `xml:"name,attr"`
	HTTPProxyConnection HTTPProxyConnectionXML `xml:"HTTPProxyConnection"`
	RouteRules   []RouteRuleXML  `xml:"RouteRule"`
}

type HTTPProxyConnectionXML struct {
	BasePath string `xml:"BasePath"`
}

type RouteRuleXML struct {
	Name           string `xml:"name,attr"`
	TargetEndpoint string `xml:"TargetEndpoint"`
}

// BundleManager handles discovery and packaging of proxy bundles and test data.
type BundleManager struct {
	DataDir string
	RootDir string
}

// NewBundleManager creates a new BundleManager instance.
func NewBundleManager(dataDir, rootDir string) *BundleManager {
	return &BundleManager{
		DataDir: dataDir,
		RootDir: rootDir,
	}
}

// FindDataFile locates a data file by checking subdirectories of DataDir first, then DataDir, then RootDir.
func (bm *BundleManager) FindDataFile(category, filename string) string {
	candidates := []string{
		filepath.Join(bm.DataDir, category, filename),
		filepath.Join(bm.DataDir, filename),
		filepath.Join(bm.RootDir, "data", category, filename),
		filepath.Join(bm.RootDir, "data", filename),
		filepath.Join(bm.RootDir, filename),
	}
	if category == "developers" {
		candidates = append([]string{
			filepath.Join(bm.DataDir, "users", filename),
			filepath.Join(bm.RootDir, "data", "users", filename),
		}, candidates...)
	} else if category == "developerapps" {
		candidates = append([]string{
			filepath.Join(bm.DataDir, "apps", filename),
			filepath.Join(bm.RootDir, "data", "apps", filename),
		}, candidates...)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}

// GetProducts loads products from data/products/products.json or fallbacks.
func (bm *BundleManager) GetProducts() ([]map[string]interface{}, error) {
	p := bm.FindDataFile("products", "products.json")
	if p == "" {
		return []map[string]interface{}{}, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var prods []map[string]interface{}
	if err := json.Unmarshal(data, &prods); err != nil {
		return nil, err
	}
	return prods, nil
}

// GetUsers loads users/developers from data/developers/developers.json or fallbacks.
func (bm *BundleManager) GetUsers() ([]map[string]interface{}, error) {
	p := bm.FindDataFile("developers", "developers.json")
	if p == "" {
		return []map[string]interface{}{}, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var users []map[string]interface{}
	if err := json.Unmarshal(data, &users); err != nil {
		return nil, err
	}
	return users, nil
}

// GetApps loads developer apps from data/developerapps/developerapps.json or fallbacks.
func (bm *BundleManager) GetApps() ([]map[string]interface{}, error) {
	p := bm.FindDataFile("developerapps", "developerapps.json")
	if p == "" {
		return []map[string]interface{}{}, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var apps []map[string]interface{}
	if err := json.Unmarshal(data, &apps); err != nil {
		return nil, err
	}
	return apps, nil
}

// GetMaps loads key-value maps from data/maps/maps.json or fallbacks.
func (bm *BundleManager) GetMaps() ([]map[string]interface{}, error) {
	p := bm.FindDataFile("maps", "maps.json")
	if p == "" {
		return []map[string]interface{}{}, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var maps []map[string]interface{}
	if err := json.Unmarshal(data, &maps); err != nil {
		return nil, err
	}
	return maps, nil
}

// GetDataCollectors loads data collectors from data/datacollectors/datacollectors.json or fallbacks.
func (bm *BundleManager) GetDataCollectors() ([]map[string]interface{}, error) {
	p := bm.FindDataFile("datacollectors", "datacollectors.json")
	if p == "" {
		return []map[string]interface{}{}, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var collectors []map[string]interface{}
	if err := json.Unmarshal(data, &collectors); err != nil {
		return nil, err
	}
	return collectors, nil
}

// ListBundles scans data/bundles and parses bundle metadata.
func (bm *BundleManager) ListBundles() ([]BundleInfo, error) {
	bundlesDir := filepath.Join(bm.DataDir, "bundles")
	entries, err := os.ReadDir(bundlesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []BundleInfo{}, nil
		}
		return nil, fmt.Errorf("failed to read bundles dir: %w", err)
	}

	var results []BundleInfo
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".zip") {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		zipPath := filepath.Join(bundlesDir, entry.Name())
		bundleInfo, err := bm.InspectBundle(zipPath)
		if err != nil {
			// Fallback with basic info
			proxyName := strings.TrimSuffix(entry.Name(), ".zip")
			results = append(results, BundleInfo{
				FileName:   entry.Name(),
				ProxyName:  proxyName,
				BasePaths:  []string{"/" + strings.ToLower(proxyName)},
				SizeBytes:  info.Size(),
				ModifiedAt: info.ModTime(),
			})
			continue
		}

		bundleInfo.FileName = entry.Name()
		bundleInfo.SizeBytes = info.Size()
		bundleInfo.ModifiedAt = info.ModTime()
		results = append(results, *bundleInfo)
	}
	return results, nil
}

// InspectBundle reads a bundle zip file and extracts ProxyName, BasePaths, Policies, and Targets.
func (bm *BundleManager) InspectBundle(zipPath string) (*BundleInfo, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open zip %s: %w", zipPath, err)
	}
	defer r.Close()

	proxyName := strings.TrimSuffix(filepath.Base(zipPath), ".zip")
	var basePaths []string
	var policies []string
	var targets []string

	for _, f := range r.File {
		cleanName := filepath.ToSlash(f.Name)

		// Check Proxy Endpoint XML
		if strings.Contains(cleanName, "apiproxy/proxies/") && strings.HasSuffix(cleanName, ".xml") {
			rc, err := f.Open()
			if err == nil {
				data, _ := io.ReadAll(rc)
				rc.Close()

				var pxml ProxyEndpointXML
				if err := xml.Unmarshal(data, &pxml); err == nil {
					if pxml.HTTPProxyConnection.BasePath != "" {
						basePaths = append(basePaths, pxml.HTTPProxyConnection.BasePath)
					}
				} else {
					// Fallback regex / substring for BasePath
					s := string(data)
					if idx := strings.Index(s, "<BasePath>"); idx != -1 {
						end := strings.Index(s[idx:], "</BasePath>")
						if end != -1 {
							bp := strings.TrimSpace(s[idx+len("<BasePath>") : idx+end])
							basePaths = append(basePaths, bp)
						}
					}
				}
			}
		}

		// Check Policies
		if strings.Contains(cleanName, "apiproxy/policies/") && strings.HasSuffix(cleanName, ".xml") {
			pName := strings.TrimSuffix(filepath.Base(cleanName), ".xml")
			policies = append(policies, pName)
		}

		// Check Targets
		if strings.Contains(cleanName, "apiproxy/targets/") && strings.HasSuffix(cleanName, ".xml") {
			tName := strings.TrimSuffix(filepath.Base(cleanName), ".xml")
			targets = append(targets, tName)
		}
	}

	if len(basePaths) == 0 {
		basePaths = append(basePaths, "/"+strings.ToLower(proxyName))
	}

	return &BundleInfo{
		ProxyName:    proxyName,
		BasePaths:    basePaths,
		Policies:     policies,
		TargetRoutes: targets,
	}, nil
}

// BuildEnvironmentBundle packages selected proxy bundles into an Apigee environment bundle (src/main/apigee/...).
func (bm *BundleManager) BuildEnvironmentBundle(bundleFileNames []string) ([]byte, []string, error) {
	bundlesDir := filepath.Join(bm.DataDir, "bundles")

	var selectedPaths []string
	if len(bundleFileNames) == 0 {
		// Include all bundles in data/bundles
		entries, err := os.ReadDir(bundlesDir)
		if err != nil {
			return nil, nil, fmt.Errorf("read bundles dir: %w", err)
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".zip") {
				selectedPaths = append(selectedPaths, filepath.Join(bundlesDir, e.Name()))
			}
		}
	} else {
		for _, name := range bundleFileNames {
			p := filepath.Join(bundlesDir, name)
			if !strings.HasSuffix(p, ".zip") {
				p += ".zip"
			}
			if _, err := os.Stat(p); err == nil {
				selectedPaths = append(selectedPaths, p)
			}
		}
	}

	if len(selectedPaths) == 0 {
		return nil, nil, fmt.Errorf("no proxy bundles found to deploy")
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	var deployedProxyNames []string

	for _, zipPath := range selectedPaths {
		proxyName := strings.TrimSuffix(filepath.Base(zipPath), ".zip")
		deployedProxyNames = append(deployedProxyNames, proxyName)

		zr, err := zip.OpenReader(zipPath)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to open bundle %s: %w", zipPath, err)
		}

		// Read all target endpoint names in this bundle
		targets := make(map[string]bool)
		for _, f := range zr.File {
			cName := filepath.ToSlash(f.Name)
			if strings.Contains(cName, "apiproxy/targets/") && strings.HasSuffix(cName, ".xml") {
				t := strings.TrimSuffix(filepath.Base(cName), ".xml")
				targets[t] = true
			}
		}

		// Copy files into src/main/apigee/apiproxies/<ProxyName>/apiproxy/...
		for _, f := range zr.File {
			cleanName := filepath.ToSlash(f.Name)
			// Strip leading prefix if already packaged under apiproxy or root
			var relativePath string
			if strings.HasPrefix(cleanName, "apiproxy/") {
				relativePath = cleanName
			} else if strings.Contains(cleanName, "/apiproxy/") {
				idx := strings.Index(cleanName, "/apiproxy/")
				relativePath = cleanName[idx+1:]
			} else {
				relativePath = filepath.Join("apiproxy", cleanName)
			}

			destPath := fmt.Sprintf("src/main/apigee/apiproxies/%s/%s", proxyName, relativePath)

			rc, err := f.Open()
			if err != nil {
				zr.Close()
				return nil, nil, err
			}
			content, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				zr.Close()
				return nil, nil, err
			}

			// If proxy xml, sanitize RouteRule targets to prevent dangling target references
			if strings.Contains(cleanName, "apiproxy/proxies/") && strings.HasSuffix(cleanName, ".xml") {
				content = sanitizeRouteRules(content, targets)
			}

			// If policy xml, strip Authentication elements that require service accounts on emulator
			if strings.Contains(cleanName, "apiproxy/policies/") && strings.HasSuffix(cleanName, ".xml") {
				content = authRegex.ReplaceAll(content, []byte(""))
			}

			header := &zip.FileHeader{
				Name:     destPath,
				Method:   zip.Deflate,
				Modified: time.Now(),
			}
			w, err := zw.CreateHeader(header)
			if err != nil {
				zr.Close()
				return nil, nil, err
			}
			if _, err := w.Write(content); err != nil {
				zr.Close()
				return nil, nil, err
			}
		}
		zr.Close()
	}

	// Add src/main/apigee/environments/test/env.json
	envJSON := []byte(`{"name":"test"}`)
	if err := writeZipFile(zw, "src/main/apigee/environments/test/env.json", envJSON); err != nil {
		return nil, nil, err
	}

	// Add src/main/apigee/environments/test/deployments.json
	deployments := map[string]interface{}{
		"proxies": deployedProxyNames,
	}
	deploymentsBytes, _ := json.MarshalIndent(deployments, "", "  ")
	if err := writeZipFile(zw, "src/main/apigee/environments/test/deployments.json", deploymentsBytes); err != nil {
		return nil, nil, err
	}

	// Copy datacollectors.json if present
	dcPath := bm.FindDataFile("datacollectors", "datacollectors.json")
	if dcPath != "" {
		if data, err := os.ReadFile(dcPath); err == nil {
			_ = writeZipFile(zw, "src/main/apigee/environments/test/datacollectors.json", data)
		}
	}

	if err := zw.Close(); err != nil {
		return nil, nil, err
	}

	return buf.Bytes(), deployedProxyNames, nil
}

// BuildTestDataBundle dynamically updates products.json for deployed proxies and builds testdata.zip.
func (bm *BundleManager) BuildTestDataBundle(proxyNames []string) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	// Load products.json
	productsPath := bm.FindDataFile("products", "products.json")
	if productsPath == "" {
		return nil, fmt.Errorf("failed to locate products.json")
	}
	productsData, err := os.ReadFile(productsPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read products.json: %w", err)
	}

	var products []map[string]interface{}
	if err := json.Unmarshal(productsData, &products); err != nil {
		return nil, fmt.Errorf("failed to parse products.json: %w", err)
	}

	// Ensure each deployed proxy is authorized in products
	for _, prod := range products {
		delete(prod, "proxies")
		delete(prod, "apiResources")

		envs, _ := prod["environments"].([]interface{})
		hasTest := false
		for _, e := range envs {
			if eStr, ok := e.(string); ok && eStr == "test" {
				hasTest = true
				break
			}
		}
		if !hasTest {
			prod["environments"] = append(envs, "test")
		}

		opGroup, _ := prod["operationGroup"].(map[string]interface{})
		if opGroup == nil {
			opGroup = map[string]interface{}{
				"operationConfigType": "proxy",
				"operationConfigs":    []interface{}{},
			}
			prod["operationGroup"] = opGroup
		}
		// Identify LLM proxies first so they are not placed into standard operationGroup
		llmGroup, _ := prod["llmOperationGroup"].(map[string]interface{})
		if llmGroup == nil {
			llmGroup = map[string]interface{}{
				"operationConfigType": "proxy",
				"operationConfigs":    []interface{}{},
			}
			prod["llmOperationGroup"] = llmGroup
		}
		llmConfigs, _ := llmGroup["operationConfigs"].([]interface{})
		existingLLMs := make(map[string]bool)
		for _, cfg := range llmConfigs {
			if cfgMap, ok := cfg.(map[string]interface{}); ok {
				if src, ok := cfgMap["apiSource"].(string); ok {
					existingLLMs[src] = true
				}
			}
		}
		for _, p := range proxyNames {
			if strings.Contains(strings.ToLower(p), "ai") || strings.Contains(strings.ToLower(p), "completions") {
				existingLLMs[p] = true
			}
		}

		opConfigs, _ := opGroup["operationConfigs"].([]interface{})
		existingOps := make(map[string]bool)
		for _, cfg := range opConfigs {
			if cfgMap, ok := cfg.(map[string]interface{}); ok {
				if src, ok := cfgMap["apiSource"].(string); ok {
					existingOps[src] = true
				}
			}
		}

		// Filter out any LLM proxies mistakenly in operationGroup
		var filteredOps []interface{}
		for _, cfg := range opConfigs {
			if cfgMap, ok := cfg.(map[string]interface{}); ok {
				src, _ := cfgMap["apiSource"].(string)
				if !existingLLMs[src] {
					filteredOps = append(filteredOps, cfg)
				}
			}
		}
		var splitOps []interface{}
		for _, cfg := range filteredOps {
			if cfgMap, ok := cfg.(map[string]interface{}); ok {
				src, _ := cfgMap["apiSource"].(string)
				quota := cfgMap["quota"]
				if quota == nil {
					quota = map[string]interface{}{}
				}
				if rawOps, ok := cfgMap["operations"].([]interface{}); ok && len(rawOps) > 1 {
					for _, op := range rawOps {
						splitOps = append(splitOps, map[string]interface{}{
							"apiSource":  src,
							"operations": []interface{}{op},
							"quota":      quota,
						})
					}
				} else if rawOps, ok := cfgMap["operations"].([]map[string]interface{}); ok && len(rawOps) > 1 {
					for _, op := range rawOps {
						splitOps = append(splitOps, map[string]interface{}{
							"apiSource":  src,
							"operations": []interface{}{op},
							"quota":      quota,
						})
					}
				} else {
					splitOps = append(splitOps, cfg)
				}
			} else {
				splitOps = append(splitOps, cfg)
			}
		}
		opConfigs = splitOps

		for _, p := range proxyNames {
			if !existingLLMs[p] && !existingOps[p] {
				opConfigs = append(opConfigs,
					map[string]interface{}{
						"apiSource": p,
						"operations": []map[string]interface{}{
							{"resource": "/"},
						},
						"quota": map[string]interface{}{},
					},
					map[string]interface{}{
						"apiSource": p,
						"operations": []map[string]interface{}{
							{"resource": "/*"},
						},
						"quota": map[string]interface{}{},
					},
				)
			}
		}
		opGroup["operationConfigs"] = opConfigs

		// Configure LLM operations: Apigee requires exactly ONE entity per operationConfig
		targetLLMModels := []string{"gemini-3.8-flash", "google/gemini-3.8-flash", "gemini-3.7-flash", "claude-sonnet-5"}
		targetLLMResources := []string{"/", "/*", "/**", "/v1/chat/completions", "/v1/chat/completions/*"}

		var normalizedLLMConfigs []interface{}
		seenLLMOps := make(map[string]bool)

		for _, cfg := range llmConfigs {
			if cfgMap, ok := cfg.(map[string]interface{}); ok {
				src, _ := cfgMap["apiSource"].(string)
				quota := cfgMap["llmTokenQuota"]
				if quota == nil {
					quota = map[string]interface{}{
						"limit":    "50000",
						"interval": "1",
						"timeUnit": "minute",
					}
				}
				rawOps, _ := cfgMap["llmOperations"].([]interface{})
				for _, op := range rawOps {
					if opMap, ok := op.(map[string]interface{}); ok {
						m, _ := opMap["model"].(string)
						r, _ := opMap["resource"].(string)
						k := fmt.Sprintf("%s:%s:%s", src, m, r)
						if !seenLLMOps[k] {
							normalizedLLMConfigs = append(normalizedLLMConfigs, map[string]interface{}{
								"apiSource":     src,
								"llmOperations": []interface{}{opMap},
								"llmTokenQuota": quota,
							})
							seenLLMOps[k] = true
						}
					}
				}
			}
		}

		for _, p := range proxyNames {
			if existingLLMs[p] {
				for _, m := range targetLLMModels {
					for _, r := range targetLLMResources {
						k := fmt.Sprintf("%s:%s:%s", p, m, r)
						if !seenLLMOps[k] {
							normalizedLLMConfigs = append(normalizedLLMConfigs, map[string]interface{}{
								"apiSource": p,
								"llmOperations": []interface{}{
									map[string]interface{}{
										"resource": r,
										"methods":  []string{"POST"},
										"model":    m,
									},
								},
								"llmTokenQuota": map[string]interface{}{
									"limit":    "50000",
									"interval": "1",
									"timeUnit": "minute",
								},
							})
							seenLLMOps[k] = true
						}
					}
				}
			}
		}
		llmGroup["operationConfigs"] = normalizedLLMConfigs
	}

	// Ensure all products referenced in developerapps.json exist
	existingProds := make(map[string]bool)
	for _, prod := range products {
		if name, ok := prod["name"].(string); ok {
			existingProds[name] = true
		}
	}

	appsPath := bm.FindDataFile("developerapps", "developerapps.json")
	if appsPath != "" {
		if appsData, err := os.ReadFile(appsPath); err == nil {
			var apps []map[string]interface{}
			if err := json.Unmarshal(appsData, &apps); err == nil {
				for _, app := range apps {
					var reqProds []string
					if pList, ok := app["apiProducts"].([]interface{}); ok {
						for _, p := range pList {
							if pStr, ok := p.(string); ok {
								reqProds = append(reqProds, pStr)
							}
						}
					}
					if creds, ok := app["credentials"].([]interface{}); ok {
						for _, c := range creds {
							if cMap, ok := c.(map[string]interface{}); ok {
								if cpList, ok := cMap["apiProducts"].([]interface{}); ok {
									for _, cp := range cpList {
										if cpStr, ok := cp.(string); ok {
											reqProds = append(reqProds, cpStr)
										} else if cpMap, ok := cp.(map[string]interface{}); ok {
											if ap, ok := cpMap["apiproduct"].(string); ok {
												reqProds = append(reqProds, ap)
											}
										}
									}
								}
							}
						}
					}
					for _, rp := range reqProds {
						if rp != "" && !existingProds[rp] {
							var defaultOps []map[string]interface{}
							for _, p := range proxyNames {
								defaultOps = append(defaultOps, map[string]interface{}{
									"apiSource": p,
									"operations": []map[string]interface{}{
										{"resource": "/"},
									},
									"quota": map[string]interface{}{},
								})
							}
							products = append(products, map[string]interface{}{
								"name":         rp,
								"displayName":  rp,
								"approvalType": "auto",
								"environments": []string{"test"},
								"operationGroup": map[string]interface{}{
									"operationConfigType": "proxy",
									"operationConfigs":    defaultOps,
								},
							})
							existingProds[rp] = true
						}
					}
				}
			}
		}
	}

	updatedProducts, _ := json.MarshalIndent(products, "", "  ")
	if err := writeZipFile(zw, "products.json", updatedProducts); err != nil {
		return nil, err
	}

	// Add developerapps.json, developers.json, maps.json, datacollectors.json
	otherFiles := []struct {
		category string
		name     string
	}{
		{"developerapps", "developerapps.json"},
		{"developers", "developers.json"},
		{"maps", "maps.json"},
		{"datacollectors", "datacollectors.json"},
	}
	for _, f := range otherFiles {
		p := bm.FindDataFile(f.category, f.name)
		if p != "" {
			data, err := os.ReadFile(p)
			if err == nil {
				if f.name == "developerapps.json" {
					var appsList []map[string]interface{}
					if json.Unmarshal(data, &appsList) == nil {
						for _, app := range appsList {
							creds, _ := app["credentials"].([]interface{})
							hasKey := false
							for _, c := range creds {
								if cMap, ok := c.(map[string]interface{}); ok {
									if k, ok := cMap["consumerKey"].(string); ok && k == "test-api-key-12345" {
										hasKey = true
										break
									}
								}
							}
							if !hasKey {
								creds = append(creds, map[string]interface{}{
									"consumerKey":    "test-api-key-12345",
									"consumerSecret": "test-api-secret-12345",
									"status":         "approved",
									"apiProducts": []map[string]interface{}{
										{"apiproduct": "test-product", "status": "approved"},
									},
								})
								app["credentials"] = creds
							}
						}
						if modifiedData, err := json.MarshalIndent(appsList, "", "  "); err == nil {
							data = modifiedData
						}
					}
				}
				if err := writeZipFile(zw, f.name, data); err != nil {
					return nil, err
				}
			}
		}
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var (
	routeRuleRegex       = regexp.MustCompile(`(?s)<RouteRule\b[^>]*>.*?</RouteRule>`)
	targetEndpointRegex = regexp.MustCompile(`<TargetEndpoint>\s*([^<]+?)\s*</TargetEndpoint>`)
	authRegex           = regexp.MustCompile(`(?s)<Authentication\b[^>]*>.*?</Authentication>`)
)

// sanitizeRouteRules ensures TargetEndpoint inside RouteRule points to an existing target.
func sanitizeRouteRules(xmlData []byte, availableTargets map[string]bool) []byte {
	// Find preferred fallback target
	var preferredTarget string
	if availableTargets["googlecloud"] {
		preferredTarget = "googlecloud"
	} else if availableTargets["googlecloud-projects"] {
		preferredTarget = "googlecloud-projects"
	} else if availableTargets["googlecloud-oai"] {
		preferredTarget = "googlecloud-oai"
	} else {
		for t := range availableTargets {
			preferredTarget = t
			break
		}
	}

	result := routeRuleRegex.ReplaceAllFunc(xmlData, func(chunk []byte) []byte {
		match := targetEndpointRegex.FindSubmatch(chunk)
		if len(match) > 1 {
			targetName := string(match[1])
			if !availableTargets[targetName] {
				if preferredTarget != "" {
					return targetEndpointRegex.ReplaceAll(chunk, []byte("<TargetEndpoint>"+preferredTarget+"</TargetEndpoint>"))
				}
				// Remove TargetEndpoint to make it a no-target route
				return targetEndpointRegex.ReplaceAll(chunk, []byte(""))
			}
		}
		return chunk
	})

	return result
}

func writeZipFile(zw *zip.Writer, name string, content []byte) error {
	w, err := zw.CreateHeader(&zip.FileHeader{
		Name:     name,
		Method:   zip.Deflate,
		Modified: time.Now(),
	})
	if err != nil {
		return err
	}
	_, err = w.Write(content)
	return err
}
