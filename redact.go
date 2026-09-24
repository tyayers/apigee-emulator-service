package main

import (
	"encoding/json"
	"net/url"
	"os"
	"sort"
	"strings"
)

// RedactKVMValue redacts the last 80-90% of a secret string,
// leaving the first ~4 characters visible and replacing the rest with "***".
func RedactKVMValue(val string) string {
	val = strings.TrimSpace(val)
	if len(val) < 6 {
		return val
	}
	visibleLen := 4
	if len(val) < 8 {
		visibleLen = 2
	}
	if visibleLen >= len(val) {
		return val
	}
	return val[:visibleLen] + "***"
}

// ExtractKVMSecretValues traverses maps.json data and extracts all string values
// from KVM entries, filtering out empty, short, or common non-secret values (like URLs).
func ExtractKVMSecretValues(mapsData interface{}) []string {
	var secrets []string
	seen := make(map[string]bool)

	addSecret := func(s string) {
		s = strings.TrimSpace(s)
		if len(s) < 6 {
			return
		}
		// Skip unresolved environment variable templates
		if strings.HasPrefix(s, "env.") || strings.HasPrefix(s, "${") {
			return
		}
		// Skip URLs and MIME types
		if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") ||
			strings.HasPrefix(s, "application/") || strings.HasPrefix(s, "text/") {
			return
		}
		if !seen[s] {
			seen[s] = true
			secrets = append(secrets, s)
		}
	}

	var extractFromEntries func(entries interface{})
	extractFromEntries = func(entries interface{}) {
		if entries == nil {
			return
		}
		switch e := entries.(type) {
		case map[string]interface{}:
			for _, v := range e {
				switch val := v.(type) {
				case string:
					addSecret(val)
				case map[string]interface{}, []interface{}:
					extractFromEntries(val)
				}
			}
		case []interface{}:
			for _, item := range e {
				switch it := item.(type) {
				case map[string]interface{}:
					if val, ok := it["value"].(string); ok {
						addSecret(val)
					}
					for k, v := range it {
						if k == "name" || k == "scope" || k == "env" || k == "environment" {
							continue
						}
						if str, ok := v.(string); ok {
							addSecret(str)
						}
					}
				case string:
					addSecret(it)
				}
			}
		case string:
			addSecret(e)
		}
	}

	switch m := mapsData.(type) {
	case []map[string]interface{}:
		for _, mapObj := range m {
			if entries, ok := mapObj["entries"]; ok {
				extractFromEntries(entries)
			}
		}
	case []interface{}:
		for _, item := range m {
			if mapObj, ok := item.(map[string]interface{}); ok {
				if entries, ok := mapObj["entries"]; ok {
					extractFromEntries(entries)
				}
			}
		}
	case map[string]interface{}:
		if entries, ok := m["entries"]; ok {
			extractFromEntries(entries)
		}
	}

	// Sort longer secrets first so substring replacement won't be shadowed by shorter substrings
	sort.Slice(secrets, func(i, j int) bool {
		return len(secrets[i]) > len(secrets[j])
	})

	return secrets
}

// RedactValue recursively traverses an arbitrary Go data structure (maps, slices, strings)
// and replaces all occurrences of secret (and its URL-encoded forms) with redacted.
func RedactValue(v interface{}, secret, redacted string) interface{} {
	switch val := v.(type) {
	case string:
		if strings.Contains(val, secret) {
			val = strings.ReplaceAll(val, secret, redacted)
		}
		queryEsc := url.QueryEscape(secret)
		if queryEsc != secret && strings.Contains(val, queryEsc) {
			val = strings.ReplaceAll(val, queryEsc, url.QueryEscape(redacted))
		}
		pathEsc := url.PathEscape(secret)
		if pathEsc != secret && pathEsc != queryEsc && strings.Contains(val, pathEsc) {
			val = strings.ReplaceAll(val, pathEsc, url.PathEscape(redacted))
		}
		return val
	case map[string]interface{}:
		for k, item := range val {
			val[k] = RedactValue(item, secret, redacted)
		}
		return val
	case []interface{}:
		for i, item := range val {
			val[i] = RedactValue(item, secret, redacted)
		}
		return val
	default:
		return v
	}
}

// RedactTraceData redacts all known KVM secret values in the trace data.
func RedactTraceData(traceData map[string]interface{}, secretValues []string) map[string]interface{} {
	if traceData == nil || len(secretValues) == 0 {
		return traceData
	}
	for _, secret := range secretValues {
		secret = strings.TrimSpace(secret)
		if len(secret) < 6 {
			continue
		}
		redacted := RedactKVMValue(secret)
		if redacted == secret {
			continue
		}
		if res, ok := RedactValue(traceData, secret, redacted).(map[string]interface{}); ok {
			traceData = res
		}
	}
	return traceData
}

// LoadKVMSecretsFromFiles attempts to read maps.json from given or default candidate paths,
// resolves any env.{...} references using current environment variables, and returns
// the extracted secret values.
func LoadKVMSecretsFromFiles(customPaths ...string) []string {
	var candidates []string
	if len(customPaths) > 0 {
		candidates = append(candidates, customPaths...)
	}
	candidates = append(candidates,
		"data/maps/maps.json",
		"data/maps.json",
		"maps/maps.json",
		"maps.json",
		"/app/data/maps/maps.json",
		"/app/maps.json",
		"../data/maps/maps.json",
	)

	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var parsed interface{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			continue
		}
		resolved, _ := resolveKVMValue(parsed)
		secrets := ExtractKVMSecretValues(resolved)
		if len(secrets) > 0 {
			return secrets
		}
	}
	return nil
}
