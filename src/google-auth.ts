import { GoogleAuth } from "google-auth-library";
import { spawnSync } from "child_process";

export class GoogleAuthService {
  private auth: GoogleAuth;
  private cachedToken: string = "";
  private expiry: number = 0;
  private cachedProjectId: string = "";
  private readonly scope: string = "https://www.googleapis.com/auth/cloud-platform";

  constructor() {
    this.auth = new GoogleAuth({
      scopes: [this.scope],
    });
  }

  public invalidateToken(): void {
    this.cachedToken = "";
    this.expiry = 0;
  }

  public async getProjectId(): Promise<string> {
    if (this.cachedProjectId) {
      return this.cachedProjectId;
    }

    try {
      const id = await this.auth.getProjectId();
      if (id && id !== "undefined") {
        this.cachedProjectId = id;
        return id;
      }
    } catch {
      // fallback
    }

    const envId =
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "";
    if (envId) {
      this.cachedProjectId = envId;
      return envId;
    }

    return "";
  }

  public async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.expiry - 60_000) {
      return this.cachedToken;
    }

    // 1. Check explicit environment variables
    for (const envKey of [
      "GOOGLE_ACCESS_TOKEN",
      "GCP_ACCESS_TOKEN",
      "GOOGLE_OAUTH_ACCESS_TOKEN",
      "FIREBASE_TOKEN",
    ]) {
      const val = process.env[envKey]?.trim();
      if (val) {
        this.cachedToken = val;
        this.expiry = now + 45 * 60 * 1000;
        return val;
      }
    }

    // 2. Primary: Google Application Default Credentials (ADC) via google-auth-library
    try {
      const client = await this.auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
      if (token && typeof token === "string" && token.trim()) {
        this.cachedToken = token.trim();
        this.expiry = now + 50 * 60 * 1000;
        return this.cachedToken;
      }
    } catch (err: any) {
      // ADC error; proceed to fallbacks
    }

    // 3. Fallback: gcloud auth application-default print-access-token
    try {
      const gcloudAdc = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], {
        encoding: "utf-8",
        timeout: 4000,
      });
      if (gcloudAdc.status === 0 && gcloudAdc.stdout?.trim()) {
        const token = gcloudAdc.stdout.trim();
        this.cachedToken = token;
        this.expiry = now + 45 * 60 * 1000;
        return token;
      }
    } catch {
      // Continue
    }

    // 4. Fallback: Compute / Cloud Run Metadata Server
    const metadataEndpoints = [
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(this.scope)}`,
      `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(this.scope)}`,
    ];

    for (const endpoint of metadataEndpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        const res = await fetch(endpoint, {
          headers: { "Metadata-Flavor": "Google" },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as { access_token?: string; expires_in?: number };
          if (data.access_token) {
            this.cachedToken = data.access_token;
            const expiresIn = (data.expires_in || 3600) * 1000;
            this.expiry = now + expiresIn;
            return this.cachedToken;
          }
        }
      } catch {
        // Continue to fallback
      }
    }

    // 5. Fallback: gcloud auth print-access-token
    try {
      const gcloud = spawnSync("gcloud", ["auth", "print-access-token"], {
        encoding: "utf-8",
        timeout: 4000,
      });
      if (gcloud.status === 0 && gcloud.stdout?.trim()) {
        const token = gcloud.stdout.trim();
        this.cachedToken = token;
        this.expiry = now + 30 * 60 * 1000;
        return token;
      }
    } catch {
      // Continue without token
    }

    return "";
  }
}

export const googleAuthService = new GoogleAuthService();

export function hasAuthorizationBearerToken(headers: { [key: string]: string } = {}): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") {
      const trimmed = String(v || "").trim();
      if (!trimmed) return false;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("bearer ")) {
        const token = trimmed.slice(7).trim();
        if (
          !token ||
          token.toLowerCase() === "<token>" ||
          token.toLowerCase() === "$token" ||
          token.toLowerCase() === "auto" ||
          token.toLowerCase() === "your_token" ||
          token.toLowerCase() === "<access_token>" ||
          token.toLowerCase() === "<google_token>"
        ) {
          return false;
        }
        return true;
      }
      if (lower === "bearer") {
        return false;
      }
      // If another explicit scheme (e.g. Basic, Digest) is specified, keep it
      return true;
    }
  }
  return false;
}

export function injectGoogleAccessToken(
  headers: { [key: string]: string } = {},
  token: string,
): { [key: string]: string } {
  if (!token) return headers;
  const result: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "authorization") {
      result[k] = v;
    }
  }
  result["Authorization"] = `Bearer ${token}`;
  return result;
}
