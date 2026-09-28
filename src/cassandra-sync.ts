import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

export function syncCassandraDeveloperAppKeys(dataDir: string, distDir?: string): boolean {
  try {
    // 1. Check if docker is available and apigee container is running
    const checkCmd = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf-8" });
    if (checkCmd.status !== 0 || !checkCmd.stdout?.includes("apigee")) {
      console.log("[CassandraSync] Docker container 'apigee' not running, skipping Cassandra sync");
      return false;
    }

    const runCql = (query: string): string => {
      const cmd = spawnSync(
        "docker",
        ["exec", "apigee", "/opt/apigee/apache-cassandra-4.0.19/bin/cqlsh", "-e", query],
        { encoding: "utf-8", timeout: 10000 },
      );
      if (cmd.status !== 0) {
        throw new Error(cmd.stderr || cmd.stdout || "cqlsh execution failed");
      }
      return cmd.stdout || "";
    };

    // 2. Fetch products and apps from Cassandra
    const prodsRaw = runCql("SELECT id, name FROM kms_hybrid_hybrid.api_product;");
    const appsRaw = runCql("SELECT id, name FROM kms_hybrid_hybrid.app;");

    const prodMap: { [name: string]: string } = {};
    for (const line of prodsRaw.split("\n")) {
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length === 2 && parts[0].length === 36) {
        prodMap[parts[1]] = parts[0];
      }
    }

    const appMap: { [name: string]: string } = {};
    for (const line of appsRaw.split("\n")) {
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length === 2 && parts[0].length === 36) {
        appMap[parts[1]] = parts[0];
      }
    }

    // 3. Find developerapps.json
    const candidates = [
      distDir ? path.join(distDir, "developerapps.json") : "",
      path.join(dataDir, "developerapps", "developerapps.json"),
      path.join(dataDir, "developerapps.json"),
      path.join(process.cwd(), "data", "developerapps", "developerapps.json"),
      path.join(process.cwd(), "data", "developerapps.json"),
    ].filter(Boolean);

    let devAppsFile = "";
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        devAppsFile = c;
        break;
      }
    }

    if (!devAppsFile) {
      console.log("[CassandraSync] developerapps.json not found, skipping credential sync");
      return false;
    }

    const content = fs.readFileSync(devAppsFile, "utf-8");
    const apps = JSON.parse(content);
    if (!Array.isArray(apps)) return false;

    const prodEntries: string[] = [];
    for (const pid of Object.values(prodMap)) {
      prodEntries.push(`${pid}: 'APPROVED'`);
    }
    const prodMapStr = "{" + prodEntries.join(", ") + "}";

    let syncedCount = 0;
    for (const app of apps) {
      const appName = app.name;
      let appID = appMap[appName];
      if (!appID) {
        appID = Object.values(appMap)[0];
      }
      if (!appID) continue;

      const creds = app.credentials || [];
      for (const cred of creds) {
        const ckey = cred.consumerKey;
        const csec = cred.consumerSecret || "secret";
        if (!ckey) continue;

        const q1 = `INSERT INTO kms_hybrid_hybrid.app_credential (tid, id, app_id, c_at, iss_at, sts, c_sec, api_prdt) VALUES ('hybrid', '${ckey}', ${appID}, toTimestamp(now()), toTimestamp(now()), 'APPROVED', '${csec}', ${prodMapStr});`;
        const q2 = `INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('app_id=${appID}&tid=hybrid', 'id=${ckey}:tid=hybrid');`;
        const q3 = `INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('tid=hybrid', 'id=${ckey}:tid=hybrid');`;

        try {
          runCql(q1);
          runCql(q2);
          runCql(q3);
          syncedCount++;
        } catch (e) {
          console.warn(`[CassandraSync] Error inserting credential for ${ckey}:`, e);
        }
      }
    }

    console.log(`[CassandraSync] Successfully synced ${syncedCount} developer app credential(s) into Cassandra`);
    return true;
  } catch (err) {
    console.warn("[CassandraSync] Notice during Cassandra sync:", err);
    return false;
  }
}
