package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2/google"
)

const (
	// DefaultGoogleCloudScope is the standard Google Cloud platform OAuth scope.
	DefaultGoogleCloudScope = "https://www.googleapis.com/auth/cloud-platform"

	// MetadataServerHostDNS is the standard DNS hostname for the Compute/Cloud Run metadata server.
	MetadataServerHostDNS = "http://metadata.google.internal"

	// MetadataServerHostIP is the link-local IP address fallback for the metadata server.
	MetadataServerHostIP = "http://169.254.169.254"

	// MetadataTokenPath is the relative path to the instance service account token endpoint.
	MetadataTokenPath = "/computeMetadata/v1/instance/service-accounts/default/token"
)

// GoogleTokenProvider defines an interface for obtaining Google Cloud access tokens.
type GoogleTokenProvider interface {
	GetAccessToken(ctx context.Context) (string, error)
}

// metadataTokenResponse models the JSON returned by the Google Cloud metadata server.
type metadataTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

// CloudRunTokenProvider retrieves and caches Google Cloud access tokens using the
// Cloud Run deployment's service account (via the Compute metadata server),
// Application Default Credentials (ADC), or local environment fallbacks.
type CloudRunTokenProvider struct {
	mu          sync.RWMutex
	cachedToken string
	expiry      time.Time
	scope       string
	httpClient  *http.Client
	metadataURL string // Overrides metadata server URL when non-empty (for tests or custom proxy)
}

// CloudRunTokenOption allows configuring a CloudRunTokenProvider.
type CloudRunTokenOption func(*CloudRunTokenProvider)

// WithScope sets a custom OAuth scope (default is DefaultGoogleCloudScope).
func WithScope(scope string) CloudRunTokenOption {
	return func(p *CloudRunTokenProvider) {
		if strings.TrimSpace(scope) != "" {
			p.scope = strings.TrimSpace(scope)
		}
	}
}

// WithMetadataURL sets a custom metadata server URL (useful for unit testing).
func WithMetadataURL(metadataURL string) CloudRunTokenOption {
	return func(p *CloudRunTokenProvider) {
		p.metadataURL = metadataURL
	}
}

// WithHTTPClient sets a custom HTTP client for metadata server requests.
func WithHTTPClient(client *http.Client) CloudRunTokenOption {
	return func(p *CloudRunTokenProvider) {
		if client != nil {
			p.httpClient = client
		}
	}
}

// NewCloudRunTokenProvider creates a new CloudRunTokenProvider instance.
func NewCloudRunTokenProvider(opts ...CloudRunTokenOption) *CloudRunTokenProvider {
	p := &CloudRunTokenProvider{
		scope: DefaultGoogleCloudScope,
		httpClient: &http.Client{
			Timeout: 3 * time.Second, // Fast timeout for metadata server checks
		},
	}
	for _, opt := range opts {
		opt(p)
	}
	return p
}

// GetAccessToken returns a valid Google access token with the configured scope.
// It uses an in-memory cache and refreshes the token before it expires.
func (p *CloudRunTokenProvider) GetAccessToken(ctx context.Context) (string, error) {
	// 1. Fast read from cache
	p.mu.RLock()
	if p.cachedToken != "" && time.Now().Before(p.expiry.Add(-1*time.Minute)) {
		tok := p.cachedToken
		p.mu.RUnlock()
		return tok, nil
	}
	p.mu.RUnlock()

	// 2. Acquire lock to refresh token
	p.mu.Lock()
	defer p.mu.Unlock()

	// Double check cache after acquiring write lock
	if p.cachedToken != "" && time.Now().Before(p.expiry.Add(-1*time.Minute)) {
		return p.cachedToken, nil
	}

	tok, exp, err := p.fetchToken(ctx)
	if err != nil {
		return "", err
	}

	p.cachedToken = tok
	p.expiry = exp
	return tok, nil
}

// fetchToken queries the Cloud Run metadata server, ADC, or local fallbacks to retrieve a new token.
func (p *CloudRunTokenProvider) fetchToken(ctx context.Context) (string, time.Time, error) {
	// A. Check if a custom or configured metadata URL is set
	if p.metadataURL != "" {
		tok, exp, err := p.fetchFromMetadataEndpoint(ctx, p.metadataURL)
		if err == nil && tok != "" {
			return tok, exp, nil
		}
	}

	// B. Query Google Cloud Metadata Server (Cloud Run deployment service account)
	// Try DNS hostname first, then link-local IP fallback
	metadataEndpoints := []string{
		fmt.Sprintf("%s%s?scopes=%s", MetadataServerHostDNS, MetadataTokenPath, url.QueryEscape(p.scope)),
		fmt.Sprintf("%s%s?scopes=%s", MetadataServerHostIP, MetadataTokenPath, url.QueryEscape(p.scope)),
	}

	for _, endpoint := range metadataEndpoints {
		tok, exp, err := p.fetchFromMetadataEndpoint(ctx, endpoint)
		if err == nil && tok != "" {
			return tok, exp, nil
		}
	}

	// C. Check explicit environment variables (GOOGLE_ACCESS_TOKEN or GCP_ACCESS_TOKEN)
	if envTok := strings.TrimSpace(os.Getenv("GOOGLE_ACCESS_TOKEN")); envTok != "" {
		return envTok, time.Now().Add(50 * time.Minute), nil
	}
	if envTok := strings.TrimSpace(os.Getenv("GCP_ACCESS_TOKEN")); envTok != "" {
		return envTok, time.Now().Add(50 * time.Minute), nil
	}

	// D. Try Google Application Default Credentials (ADC) via oauth2/google
	if ts, err := google.DefaultTokenSource(ctx, p.scope); err == nil {
		if tok, err := ts.Token(); err == nil && tok != nil && tok.AccessToken != "" {
			exp := tok.Expiry
			if exp.IsZero() {
				exp = time.Now().Add(50 * time.Minute)
			}
			return tok.AccessToken, exp, nil
		}
	}

	// E. Local developer fallback: gcloud auth print-access-token
	if gcloudPath, err := exec.LookPath("gcloud"); err == nil && gcloudPath != "" {
		cmdCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()
		cmd := exec.CommandContext(cmdCtx, "gcloud", "auth", "print-access-token")
		if out, err := cmd.Output(); err == nil {
			tok := strings.TrimSpace(string(out))
			if tok != "" {
				return tok, time.Now().Add(30 * time.Minute), nil
			}
		}
	}

	return "", time.Time{}, fmt.Errorf("unable to acquire Google access token from Cloud Run metadata server, ADC, or local credentials")
}

// fetchFromMetadataEndpoint performs an authenticated GET to a Google Cloud metadata server endpoint.
func (p *CloudRunTokenProvider) fetchFromMetadataEndpoint(ctx context.Context, endpoint string) (string, time.Time, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Metadata-Flavor", "Google")

	client := p.httpClient
	if client == nil {
		client = http.DefaultClient
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, fmt.Errorf("metadata server returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to read metadata server response: %w", err)
	}

	var mResp metadataTokenResponse
	if err := json.Unmarshal(body, &mResp); err != nil {
		return "", time.Time{}, fmt.Errorf("failed to decode metadata token JSON: %w", err)
	}

	if mResp.AccessToken == "" {
		return "", time.Time{}, fmt.Errorf("metadata server returned empty access token")
	}

	exp := time.Now().Add(50 * time.Minute)
	if mResp.ExpiresIn > 0 {
		exp = time.Now().Add(time.Duration(mResp.ExpiresIn) * time.Second)
	}

	return mResp.AccessToken, exp, nil
}

// hasAuthorizationBearerToken checks whether the provided headers map contains
// an Authorization header with an existing, non-placeholder Bearer token, or
// another explicit authorization scheme (such as Basic or Digest).
func hasAuthorizationBearerToken(headers map[string]string) bool {
	if headers == nil {
		return false
	}

	for k, v := range headers {
		if strings.EqualFold(k, "Authorization") {
			trimmed := strings.TrimSpace(v)
			if trimmed == "" {
				return false
			}

			lower := strings.ToLower(trimmed)
			if strings.HasPrefix(lower, "bearer ") {
				token := strings.TrimSpace(trimmed[7:])
				if token == "" ||
					strings.EqualFold(token, "<token>") ||
					strings.EqualFold(token, "$token") ||
					strings.EqualFold(token, "auto") ||
					strings.EqualFold(token, "your_token") ||
					strings.EqualFold(token, "<access_token>") ||
					strings.EqualFold(token, "<google_token>") {
					return false
				}
				return true
			}

			if strings.EqualFold(lower, "bearer") {
				return false
			}

			// If another non-empty authorization scheme is provided (e.g. Basic ...),
			// preserve it and do not overwrite.
			return true
		}
	}

	return false
}

// injectGoogleAccessToken sets the Authorization header to 'Bearer <token>',
// ensuring any casing variations of an empty/placeholder Authorization header are replaced.
func injectGoogleAccessToken(headers map[string]string, token string) map[string]string {
	if headers == nil {
		headers = make(map[string]string)
	}

	// Remove any existing case-insensitive authorization keys
	for k := range headers {
		if strings.EqualFold(k, "Authorization") {
			delete(headers, k)
		}
	}

	headers["Authorization"] = "Bearer " + token
	return headers
}
