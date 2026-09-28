import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import cassandra from "cassandra-driver";

interface CassandraExecutor {
  query(cql: string): Promise<any[]>;
  execute(cql: string): Promise<void>;
  close(): Promise<void>;
}

async function getNativeDriverExecutor(): Promise<CassandraExecutor | null> {
  const host = process.env.CASSANDRA_HOST || "127.0.0.1";
  const port = parseInt(process.env.CASSANDRA_PORT || "9042", 10);
  const dc = process.env.CASSANDRA_DC || "dc-1";

  try {
    const client = new cassandra.Client({
      contactPoints: [host],
      localDataCenter: dc,
      keyspace: "kms_hybrid_hybrid",
      protocolOptions: { port },
      socketOptions: { connectTimeout: 3000, readTimeout: 5000 },
    });

    await client.connect();
    return {
      async query(cql: string) {
        const res = await client.execute(cql);
        return res.rows;
      },
      async execute(cql: string) {
        await client.execute(cql);
      },
      async close() {
        try {
          await client.shutdown();
        } catch {}
      },
    };
  } catch (err: any) {
    return null;
  }
}

function getDockerCqlExecutor(): CassandraExecutor | null {
  try {
    const checkCmd = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf-8" });
    if (checkCmd.status !== 0 || !checkCmd.stdout?.includes("apigee")) {
      return null;
    }

    return {
      async query(cql: string) {
        const cmd = spawnSync(
          "docker",
          ["exec", "apigee", "cqlsh", "-e", cql],
          { encoding: "utf-8", timeout: 10000 },
        );
        if (cmd.status !== 0) {
          throw new Error(cmd.stderr || cmd.stdout || "cqlsh query failed");
        }
        const lines = (cmd.stdout || "").split("\n");
        const rows: any[] = [];
        for (const line of lines) {
          const parts = line.split("|").map((s) => s.trim());
          if (parts.length >= 2 && parts[0].length === 36) {
            rows.push({ id: parts[0], name: parts[1] });
          }
        }
        return rows;
      },
      async execute(cql: string) {
        const cmd = spawnSync(
          "docker",
          ["exec", "apigee", "cqlsh", "-e", cql],
          { encoding: "utf-8", timeout: 10000 },
        );
        if (cmd.status !== 0) {
          throw new Error(cmd.stderr || cmd.stdout || "cqlsh execution failed");
        }
      },
      async close() {},
    };
  } catch {
    return null;
  }
}

async function getCassandraExecutor(): Promise<CassandraExecutor | null> {
  const native = await getNativeDriverExecutor();
  if (native) {
    return native;
  }
  return getDockerCqlExecutor();
}

export async function syncCassandraDeveloperAppKeys(
  dataDir: string,
  distDir?: string,
  appsOverride?: any[],
): Promise<boolean> {
  let executor: CassandraExecutor | null = null;
  try {
    executor = await getCassandraExecutor();
    if (!executor) {
      console.log("[CassandraSync] Neither Cassandra native port (127.0.0.1:9042) nor docker 'apigee' is reachable, skipping sync");
      return false;
    }

    // 1. Fetch products and apps from Cassandra
    const prodRows = await executor.query("SELECT id, name FROM kms_hybrid_hybrid.api_product;");
    const appRows = await executor.query("SELECT id, name FROM kms_hybrid_hybrid.app;");

    const prodMap: { [name: string]: string } = {};
    for (const r of prodRows) {
      const id = typeof r.id?.toString === "function" ? r.id.toString() : String(r.id);
      const name = r.name || "";
      if (id && name) prodMap[name] = id;
    }

    const appMap: { [name: string]: string } = {};
    for (const r of appRows) {
      const id = typeof r.id?.toString === "function" ? r.id.toString() : String(r.id);
      const name = r.name || "";
      if (id && name) appMap[name] = id;
    }

    // Ensure products in Cassandra have the proxies set so the runtime VerifyAPIKey policy allows requests
    const defaultProxies = ["REST-AI-Completions", "REST-AI-GenerateContent", "REST-AI-Interactions", "REST-AI-Messages", "REST-AI-Embeddings"];
    const proxiesSetLiteral = "{" + defaultProxies.map((p) => `'${p}'`).join(", ") + "}";
    for (const [pName, pId] of Object.entries(prodMap)) {
      try {
        await executor.execute(`UPDATE kms_hybrid_hybrid.api_product SET proxies = ${proxiesSetLiteral} WHERE tid = 'hybrid' AND id = ${pId};`);
      } catch (err) {
        console.warn(`[CassandraSync] Could not update proxies for product ${pName}:`, err);
      }
    }

    // 2. Resolve list of apps
    let apps: any[] = [];
    if (Array.isArray(appsOverride) && appsOverride.length > 0) {
      apps = appsOverride;
    } else {
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

      if (devAppsFile) {
        try {
          const content = fs.readFileSync(devAppsFile, "utf-8");
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            apps = parsed;
          }
        } catch (e) {
          console.warn("[CassandraSync] Failed to parse developerapps.json:", e);
        }
      }

      // Also merge custom resources if present
      const customFile = path.join(dataDir, "labs-custom-resources.json");
      if (fs.existsSync(customFile)) {
        try {
          const customData = JSON.parse(fs.readFileSync(customFile, "utf-8"));
          if (Array.isArray(customData.apps)) {
            apps = [...apps, ...customData.apps];
          }
        } catch (e) {
          console.warn("[CassandraSync] Failed to parse labs-custom-resources.json:", e);
        }
      }

      // Also merge lab participants if present
      const participantsFile = path.join(dataDir, "lab-participants.json");
      if (fs.existsSync(participantsFile)) {
        try {
          const participants = JSON.parse(fs.readFileSync(participantsFile, "utf-8"));
          if (Array.isArray(participants)) {
            for (const p of participants) {
              apps.push({
                name: p.appName || `${p.name}'s Lab App`,
                developerEmail: p.email,
                apiProducts: ["test-product"],
                credentials: [
                  {
                    consumerKey: p.consumerKey,
                    consumerSecret: p.consumerSecret || "secret",
                    apiProducts: ["test-product"],
                  },
                ],
              });
            }
          }
        } catch (e) {
          console.warn("[CassandraSync] Failed to parse lab-participants.json:", e);
        }
      }
    }

    if (!apps || apps.length === 0) {
      console.log("[CassandraSync] No developer apps found, skipping credential sync");
      return false;
    }

    const allProdEntries: string[] = [];
    for (const pid of Object.values(prodMap)) {
      allProdEntries.push(`${pid}: 'APPROVED'`);
    }
    const defaultProdMapStr = "{" + allProdEntries.join(", ") + "}";

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

        let credProdMapStr = defaultProdMapStr;
        const targetProds = cred.apiProducts || app.apiProducts || [];
        if (Array.isArray(targetProds) && targetProds.length > 0) {
          const matchedEntries: string[] = [];
          for (const item of targetProds) {
            const pName = typeof item === "string" ? item : item.apiproduct || item.name;
            if (pName && prodMap[pName]) {
              matchedEntries.push(`${prodMap[pName]}: 'APPROVED'`);
            }
          }
          if (matchedEntries.length > 0) {
            credProdMapStr = "{" + matchedEntries.join(", ") + "}";
          }
        }

        const q1 = `INSERT INTO kms_hybrid_hybrid.app_credential (tid, id, app_id, c_at, iss_at, sts, c_sec, api_prdt) VALUES ('hybrid', '${ckey}', ${appID}, toTimestamp(now()), toTimestamp(now()), 'APPROVED', '${csec}', ${credProdMapStr});`;
        const q2 = `INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('app_id=${appID}&tid=hybrid', 'id=${ckey}:tid=hybrid');`;
        const q3 = `INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('tid=hybrid', 'id=${ckey}:tid=hybrid');`;

        try {
          await executor.execute(q1);
          await executor.execute(q2);
          await executor.execute(q3);
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
  } finally {
    if (executor) {
      await executor.close();
    }
  }
}

export async function syncSingleCredentialToCassandra(
  consumerKey: string,
  consumerSecret: string,
  appName?: string,
  dataDir?: string,
): Promise<boolean> {
  const dummyApp = {
    name: appName || "Participant App",
    apiProducts: ["test-product"],
    credentials: [
      {
        consumerKey,
        consumerSecret: consumerSecret || "secret",
        apiProducts: ["test-product"],
      },
    ],
  };
  return await syncCassandraDeveloperAppKeys(dataDir || path.join(process.cwd(), "data"), undefined, [dummyApp]);
}

export async function removeCredentialFromCassandra(consumerKey: string): Promise<boolean> {
  const executor = (await getNativeDriverExecutor()) || getDockerCqlExecutor();
  if (!executor) return false;
  try {
    const q1 = `DELETE FROM kms_hybrid_hybrid.app_credential WHERE tid='hybrid' AND id='${consumerKey}';`;
    await executor.execute(q1);
    return true;
  } catch (e) {
    console.warn(`[CassandraSync] Notice deleting credential for ${consumerKey}:`, e);
    return false;
  } finally {
    await executor.close();
  }
}

