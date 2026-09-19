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
	dcPath := filepath.Join(bm.RootDir, "datacollectors.json")
	if data, err := os.ReadFile(dcPath); err == nil {
		_ = writeZipFile(zw, "src/main/apigee/environments/test/datacollectors.json", data)
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
	productsPath := filepath.Join(bm.RootDir, "products.json")
	productsData, err := os.ReadFile(productsPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read products.json: %w", err)
	}

	var products []map[string]interface{}
	if err := json.Unmarshal(productsData, &products); err != nil {
		return nil, fmt.Errorf("failed to parse products.json: %w", err)
	}

	// Ensure each deployed proxy is authorized in products
	models := []string{
		"gemini-3.8-flash", "claude-sonnet-5",
	}

	for _, prod := range products {
		delete(prod, "proxies")
		delete(prod, "apiResources")

		opGroup, _ := prod["operationGroup"].(map[string]interface{})
		if opGroup == nil {
			opGroup = map[string]interface{}{
				"operationConfigType": "proxy",
				"operationConfigs":    []interface{}{},
			}
			prod["operationGroup"] = opGroup
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

		for _, p := range proxyNames {
			if !existingOps[p] {
				opConfigs = append(opConfigs, map[string]interface{}{
					"apiSource": p,
					"operations": []map[string]interface{}{
						{"resource": "/"},
					},
					"quota": map[string]interface{}{},
				})
				opConfigs = append(opConfigs, map[string]interface{}{
					"apiSource": p,
					"operations": []map[string]interface{}{
						{"resource": "/*"},
					},
					"quota": map[string]interface{}{},
				})
			}
		}
		opGroup["operationConfigs"] = opConfigs

		// LLM operations
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
				if !existingLLMs[p] {
					for _, m := range models {
						llmConfigs = append(llmConfigs, map[string]interface{}{
							"apiSource": p,
							"llmOperations": []map[string]interface{}{
								{
									"resource": "/",
									"model":    m,
								},
							},
							"llmTokenQuota": map[string]interface{}{
								"limit":    "50000",
								"interval": "1",
								"timeUnit": "minute",
							},
						})
					}
				}
			}
		}
		llmGroup["operationConfigs"] = llmConfigs
	}

	updatedProducts, _ := json.MarshalIndent(products, "", "  ")
	if err := writeZipFile(zw, "products.json", updatedProducts); err != nil {
		return nil, err
	}

	// Add developerapps.json, developers.json, maps.json, datacollectors.json
	otherFiles := []string{"developerapps.json", "developers.json", "maps.json", "datacollectors.json"}
	for _, f := range otherFiles {
		p := filepath.Join(bm.RootDir, f)
		data, err := os.ReadFile(p)
		if err == nil {
			if err := writeZipFile(zw, f, data); err != nil {
				return nil, err
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
