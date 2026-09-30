import { EmulatorClient } from "./emulator.ts";
import {
  googleAuthService,
  hasAuthorizationBearerToken,
  injectGoogleAccessToken,
  containsGoogleTokenPlaceholder,
  hasGoogleTokenPlaceholder,
  replacePlaceholdersInString,
} from "./google-auth.ts";
import { TestRequest, TestResponse } from "./types.ts";

export class ProxyTester {
  private emulator: EmulatorClient;

  constructor(emulator: EmulatorClient) {
    this.emulator = emulator;
  }

  public async execute(req: TestRequest): Promise<TestResponse> {
    const method = (req.method || (req.body ? "POST" : "GET")).toUpperCase().trim();
    let path = (req.path || "").trim();
    if (!path.startsWith("/")) path = "/" + path;

    let traceSessionId = "";

    // 1. Optionally start trace session
    if (req.recordTrace && req.proxy) {
      try {
        traceSessionId = await this.emulator.startTraceSession(req.proxy);
      } catch (err) {
        console.warn(`[ProxyTester] Notice: failed to start trace session for ${req.proxy}:`, err);
      }
    }

    // 2. Prepare headers
    let effectiveHeaders: { [key: string]: string } = {};
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        if (!k.trim()) continue;
        effectiveHeaders[k.trim()] = String(v);
      }
    }

    // Default User-Agent
    const hasUA = Object.keys(effectiveHeaders).some(
      (k) => k.toLowerCase() === "user-agent",
    );
    if (!hasUA) {
      effectiveHeaders["User-Agent"] = "Apigee-Emulator-Manager/1.0";
    }

    // Synchronize API key headers across both standard and AI key formats
    const apiKey =
      effectiveHeaders["x-api-key"] ||
      effectiveHeaders["X-API-Key"] ||
      effectiveHeaders["X-Api-Key"] ||
      "";
    const aiKey =
      effectiveHeaders["x-ai-key"] ||
      effectiveHeaders["X-AI-Key"] ||
      effectiveHeaders["X-Ai-Key"] ||
      "";

    if (apiKey && !aiKey) {
      effectiveHeaders["x-ai-key"] = apiKey;
    } else if (aiKey && !apiKey) {
      effectiveHeaders["x-api-key"] = aiKey;
    }

    // Context detection
    const proxyLower = (req.proxy || "").toLowerCase();
    const pathLower = path.toLowerCase();
    const isInteractions =
      proxyLower.includes("interactions") || pathLower.includes("/interactions");
    const isMcp =
      proxyLower.includes("mcp") ||
      proxyLower.includes("customerservice") ||
      pathLower.includes("/customerservice");
    const hasGoogApiKey = Boolean(
      effectiveHeaders["x-goog-api-key"] ||
      effectiveHeaders["X-Goog-Api-Key"] ||
      effectiveHeaders["X-GOOG-API-KEY"]
    );

    // Check if test definition or request headers/body/path contain Google token placeholders
    const hasGooglePlaceholder =
      hasGoogleTokenPlaceholder(effectiveHeaders) ||
      containsGoogleTokenPlaceholder(path) ||
      (typeof req.body === "string" && containsGoogleTokenPlaceholder(req.body));

    // Determine if we should provide a Google Access Token
    let shouldProvideGoogleToken = false;
    if (req.injectGoogleToken === true) {
      shouldProvideGoogleToken = true;
    } else if (req.injectGoogleToken === false) {
      shouldProvideGoogleToken = false;
    } else if (hasGooglePlaceholder) {
      shouldProvideGoogleToken = true;
    } else if (hasGoogApiKey || isInteractions || isMcp) {
      // Do not inject Google bearer token when using Google API Key or calling non-Vertex AI endpoints
      shouldProvideGoogleToken = false;
    } else if (!hasAuthorizationBearerToken(effectiveHeaders)) {
      // Default fallback for Vertex AI proxies if no authorization is explicitly provided
      shouldProvideGoogleToken = true;
    }

    // Fetch token if needed
    let googleToken = "";
    if (shouldProvideGoogleToken) {
      try {
        googleToken =
          (await googleAuthService.getAccessToken()) ||
          process.env.EMULATOR_FALLBACK_TOKEN ||
          "";
      } catch (err) {
        console.warn(`[ProxyTester] Notice: could not acquire Google access token:`, err);
        googleToken = process.env.EMULATOR_FALLBACK_TOKEN || "";
      }
    }

    const geminiKey = process.env.GEMINI_API_KEY || process.env.GeminiApiKey || "";
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "cloud32x";

    const placeholderContext = {
      googleToken,
      geminiApiKey: geminiKey,
      projectId,
    };

    // Replace placeholders in path, body, and headers
    path = replacePlaceholdersInString(path, placeholderContext);
    if (req.body && typeof req.body === "string") {
      req.body = replacePlaceholdersInString(req.body, placeholderContext);
    }

    for (const [k, v] of Object.entries(effectiveHeaders)) {
      effectiveHeaders[k] = replacePlaceholdersInString(v, placeholderContext);
    }

    // If Google token should be provided and no authorization header was set, inject it
    if (shouldProvideGoogleToken && googleToken && !hasAuthorizationBearerToken(effectiveHeaders)) {
      effectiveHeaders = injectGoogleAccessToken(effectiveHeaders, googleToken);
    }

    // Only inject Gemini API Key for Interactions or if x-goog-api-key was explicitly present
    const hasExplicitGoogApiKeyHeader = Object.keys(effectiveHeaders).some(
      (k) => k.toLowerCase() === "x-goog-api-key"
    );
    if (geminiKey && (isInteractions || hasExplicitGoogApiKeyHeader)) {
      if (!effectiveHeaders["x-goog-api-key"] && !effectiveHeaders["X-Goog-Api-Key"]) {
        effectiveHeaders["x-goog-api-key"] = geminiKey;
      }
    }

    // Synchronize req.headers with effective dispatched headers
    req.headers = { ...effectiveHeaders };

    const targetUrl = `${this.emulator.runtimeUrl}${path}`;

    // 3. Send HTTP request
    let startTime = Date.now();
    try {
      const fetchOpts: RequestInit = {
        method,
        headers: effectiveHeaders,
      };

      if (req.body && method !== "GET" && method !== "HEAD") {
        fetchOpts.body = req.body;
      }

      let res = await fetch(targetUrl, fetchOpts);
      let durationMs = Date.now() - startTime;
      let body = await res.text();

      // Retry mechanism 1: If 401 occurs due to InvalidApiKey, try active consumer key from emulator
      if (res.status === 401 && (apiKey || aiKey)) {
        try {
          const activeKeys = await this.emulator.getActiveConsumerKeys();
          if (activeKeys.length > 0) {
            const activeKey = activeKeys[0];
            const currentKey = apiKey || aiKey;
            if (activeKey !== currentKey) {
              effectiveHeaders["x-api-key"] = activeKey;
              effectiveHeaders["x-ai-key"] = activeKey;
              req.headers["x-api-key"] = activeKey;
              req.headers["x-ai-key"] = activeKey;

              const retryOpts: RequestInit = {
                method,
                headers: effectiveHeaders,
              };
              if (req.body && method !== "GET" && method !== "HEAD") {
                retryOpts.body = req.body;
              }
              const retryStart = Date.now();
              const retryRes = await fetch(targetUrl, retryOpts);
              if (retryRes.status !== 401) {
                res = retryRes;
                durationMs = Date.now() - retryStart;
                body = await res.text();
              }
            }
          }
        } catch {
          // ignore retry failure
        }
      }

      // Retry mechanism 2: If 401 occurs due to expired/invalid Google access token, refresh ADC token & retry once
      if (res.status === 401 && body.includes("UNAUTHENTICATED") && shouldProvideGoogleToken) {
        try {
          googleAuthService.invalidateToken();
          const freshToken = await googleAuthService.getAccessToken();
          if (freshToken) {
            effectiveHeaders = injectGoogleAccessToken(effectiveHeaders, freshToken);
            req.headers = { ...effectiveHeaders };
            const retryOpts: RequestInit = {
              method,
              headers: effectiveHeaders,
            };
            if (req.body && method !== "GET" && method !== "HEAD") {
              retryOpts.body = req.body;
            }
            const retryStart = Date.now();
            const retryRes = await fetch(targetUrl, retryOpts);
            if (retryRes.status === 200 || retryRes.status < res.status) {
              res = retryRes;
              durationMs = Date.now() - retryStart;
              body = await res.text();
            }
          }
        } catch {
          // ignore retry failure
        }
      }

      const respHeaders: { [key: string]: string } = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });

      let targetLatencyMs: number | undefined;
      for (const [k, v] of Object.entries(respHeaders)) {
        if (k.toLowerCase() === "x-apigee-target-latency") {
          const lat = parseInt(v.trim(), 10);
          if (!isNaN(lat)) {
            targetLatencyMs = lat;
            break;
          }
        }
      }

      let traceData: any = undefined;
      if (traceSessionId) {
        // Buffer wait for emulator to record trace
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          traceData = await this.emulator.getTraceTransactions(traceSessionId);
          if (targetLatencyMs === undefined && traceData) {
            targetLatencyMs = this.extractTargetLatencyFromTrace(traceData);
          }
        } catch (err) {
          console.warn(`[ProxyTester] Notice: failed to fetch trace transactions for session ${traceSessionId}:`, err);
        }
      }

      return {
        statusCode: res.status,
        statusText: `${res.status} ${res.statusText || ""}`.trim(),
        durationMs,
        targetLatencyMs,
        headers: respHeaders,
        body,
        traceSessionId,
        traceData,
        request: req,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return {
        statusCode: 502,
        statusText: "502 Bad Gateway",
        durationMs,
        headers: {},
        body: `Connection Error: ${err.message || String(err)}`,
        traceSessionId,
        error: err.message || String(err),
        request: req,
      };
    }
  }

  private extractTargetLatencyFromTrace(data: any): number | undefined {
    let targetLat: number | undefined;
    let targetSentStart = 0;
    let targetRecvEnd = 0;

    const walk = (v: any) => {
      if (targetLat !== undefined || v === null || v === undefined) return;
      if (typeof v === "object") {
        if (typeof v.name === "string") {
          const name = v.name.toLowerCase();
          if (name === "x-apigee-target-latency") {
            const parsed = parseInt(String(v.value || "").trim(), 10);
            if (!isNaN(parsed)) {
              targetLat = parsed;
              return;
            }
          } else if (name === "target.sent.start.timestamp") {
            const parsed = parseInt(String(v.value || "").trim(), 10);
            if (!isNaN(parsed)) targetSentStart = parsed;
          } else if (name === "target.received.end.timestamp") {
            const parsed = parseInt(String(v.value || "").trim(), 10);
            if (!isNaN(parsed)) targetRecvEnd = parsed;
          }
        }
        for (const child of Object.values(v)) {
          walk(child);
          if (targetLat !== undefined) return;
        }
      }
    };

    walk(data);
    if (targetLat !== undefined) return targetLat;
    if (targetRecvEnd > 0 && targetSentStart > 0 && targetRecvEnd >= targetSentStart) {
      return targetRecvEnd - targetSentStart;
    }
    return undefined;
  }
}
