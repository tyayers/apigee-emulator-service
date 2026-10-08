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
        let jsonCql = cql.trim();
        if (!jsonCql.toLowerCase().includes("select json ")) {
          jsonCql = jsonCql.replace(/^(\s*select\s+)/i, "$1json ");
        }
        const cmd = spawnSync(
          "docker",
          ["exec", "apigee", "/opt/apigee/apigee-cassandra/bin/cqlsh", "-e", jsonCql],
          { encoding: "utf-8", timeout: 15000 },
        );
        if (cmd.status !== 0) {
          throw new Error(cmd.stderr || cmd.stdout || "cqlsh query failed");
        }
        const lines = (cmd.stdout || "").split("\n");
        const rows: any[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              rows.push(JSON.parse(trimmed));
            } catch {}
          }
        }
        return rows;
      },
      async execute(cql: string) {
        const cmd = spawnSync(
          "docker",
          ["exec", "apigee", "/opt/apigee/apigee-cassandra/bin/cqlsh", "-e", cql],
          { encoding: "utf-8", timeout: 15000 },
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
  const dockerExec = getDockerCqlExecutor();
  if (dockerExec) {
    return dockerExec;
  }
  return await getNativeDriverExecutor();
}

export async function purgeOrphanedCassandraKmsData(
  executorArg?: CassandraExecutor | null,
): Promise<{ cleanedMappers: number; cleanedMapperIdx: number; cleanedCreds: number; cleanedCredIdx: number }> {
  let executor = executorArg;
  let createdExecutor = false;
  if (!executor) {
    executor = await getCassandraExecutor();
    if (!executor) return { cleanedMappers: 0, cleanedMapperIdx: 0, cleanedCreds: 0, cleanedCredIdx: 0 };
    createdExecutor = true;
  }

  try {
    const prodRows = await executor.query("SELECT id, name FROM kms_hybrid_hybrid.api_product;");
    const appRows = await executor.query("SELECT id, name FROM kms_hybrid_hybrid.app;");

    const validAppIds = new Set<string>();
    for (const r of appRows) {
      const id = typeof r.id?.toString === "function" ? r.id.toString() : String(r.id || "");
      if (id) validAppIds.add(id);
    }

    const validProdIds = new Set<string>();
    for (const r of prodRows) {
      const id = typeof r.id?.toString === "function" ? r.id.toString() : String(r.id || "");
      if (id) validProdIds.add(id);
    }

    let cleanedMappers = 0;
    let cleanedMapperIdx = 0;
    let cleanedCreds = 0;
    let cleanedCredIdx = 0;

    // 1. Clean app_and_api_product_mapper (delete rows pointing to deleted apps or deleted products)
    try {
      const mapperRows = await executor.query("SELECT tid, api_prdt_id, app_id, app_cred_id FROM kms_hybrid_hybrid.app_and_api_product_mapper;");
      for (const m of mapperRows) {
        const appId = typeof m.app_id?.toString === "function" ? m.app_id.toString() : String(m.app_id || "");
        const prodId = typeof m.api_prdt_id?.toString === "function" ? m.api_prdt_id.toString() : String(m.api_prdt_id || "");
        if (!validAppIds.has(appId) || !validProdIds.has(prodId)) {
          const tid = m.tid || "hybrid";
          const credId = m.app_cred_id;
          await executor.execute(`DELETE FROM kms_hybrid_hybrid.app_and_api_product_mapper WHERE tid = '${tid}' AND api_prdt_id = ${prodId} AND app_id = ${appId} AND app_cred_id = '${credId}';`);
          cleanedMappers++;
        }
      }
    } catch (e) {
      console.warn("[CassandraSync] Notice checking app_and_api_product_mapper:", e);
    }

    // 2. Clean app_and_api_product_mapper_idx (delete rows pointing to deleted apps)
    try {
      const mapperIdxRows = await executor.query("SELECT key, rid FROM kms_hybrid_hybrid.app_and_api_product_mapper_idx;");
      for (const row of mapperIdxRows) {
        const key = row.key || "";
        const m = key.match(/app_id=([0-9a-fA-F-]+)/);
        if (m && !validAppIds.has(m[1])) {
          await executor.execute(`DELETE FROM kms_hybrid_hybrid.app_and_api_product_mapper_idx WHERE key = '${row.key}' AND rid = '${row.rid}';`);
          cleanedMapperIdx++;
        }
      }
    } catch (e) {
      console.warn("[CassandraSync] Notice checking app_and_api_product_mapper_idx:", e);
    }

    // 3. Clean app_credential (delete credentials pointing to deleted apps)
    const validCredKeys = new Set<string>();
    try {
      const credRows = await executor.query("SELECT tid, id, app_id FROM kms_hybrid_hybrid.app_credential;");
      for (const c of credRows) {
        const appId = typeof c.app_id?.toString === "function" ? c.app_id.toString() : String(c.app_id || "");
        if (!validAppIds.has(appId)) {
          const tid = c.tid || "hybrid";
          await executor.execute(`DELETE FROM kms_hybrid_hybrid.app_credential WHERE tid = '${tid}' AND id = '${c.id}';`);
          cleanedCreds++;
        } else if (c.id) {
          validCredKeys.add(c.id);
        }
      }
    } catch (e) {
      console.warn("[CassandraSync] Notice checking app_credential:", e);
    }

    // 4. Clean app_credential_idx (delete index entries pointing to deleted apps or deleted credentials)
    try {
      const credIdxRows = await executor.query("SELECT key, rid FROM kms_hybrid_hybrid.app_credential_idx;");
      for (const row of credIdxRows) {
        const key = row.key || "";
        const m = key.match(/app_id=([0-9a-fA-F-]+)/);
        if (m && !validAppIds.has(m[1])) {
          await executor.execute(`DELETE FROM kms_hybrid_hybrid.app_credential_idx WHERE key = '${row.key}' AND rid = '${row.rid}';`);
          cleanedCredIdx++;
        } else if (key === "tid=hybrid") {
          const mCred = row.rid?.match(/id=([^:]+):tid=hybrid/);
          if (mCred && !validCredKeys.has(mCred[1])) {
            await executor.execute(`DELETE FROM kms_hybrid_hybrid.app_credential_idx WHERE key = '${row.key}' AND rid = '${row.rid}';`);
            cleanedCredIdx++;
          }
        }
      }
    } catch (e) {
      console.warn("[CassandraSync] Notice checking app_credential_idx:", e);
    }

    if (cleanedMappers > 0 || cleanedMapperIdx > 0 || cleanedCreds > 0 || cleanedCredIdx > 0) {
      console.log(`[CassandraSync] Purged orphaned KMS entities: ${cleanedMappers} mapper(s), ${cleanedMapperIdx} mapper index(es), ${cleanedCreds} credential(s), ${cleanedCredIdx} cred index(es)`);
    }

    return { cleanedMappers, cleanedMapperIdx, cleanedCreds, cleanedCredIdx };
  } finally {
    if (createdExecutor && executor) {
      await executor.close();
    }
  }
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

    // 0. Purge any orphaned KMS records from previous runs to prevent 404 Fault App does not exist
    await purgeOrphanedCassandraKmsData(executor);

    // 1. Fetch products and apps from Cassandra
    const prodRows = await executor.query("SELECT id, name FROM kms_hybrid_hybrid.api_product;");
    const appRows = await executor.query("SELECT id, name FROM kms_hybrid_hybrid.app;");

    const prodMap: { [name: string]: string } = {};
    for (const r of prodRows) {
      const id = typeof r.id?.toString === "function" ? r.id.toString() : String(r.id);
      const name = (r.name || "").trim();
      if (id && name) {
        prodMap[name] = id;
        prodMap[name.toLowerCase()] = id;
      }
    }

    const appMap: { [name: string]: string } = {};
    for (const r of appRows) {
      const id = typeof r.id?.toString === "function" ? r.id.toString() : String(r.id);
      const name = (r.name || "").trim();
      if (id && name) {
        appMap[name] = id;
        appMap[name.toLowerCase()] = id;
      }
    }

    // Ensure REST products in Cassandra have proxies and api_res set so the runtime VerifyAPIKey policy allows requests
    const defaultProxies = ["REST-AI-Completions", "REST-AI-GenerateContent", "REST-AI-Interactions", "REST-AI-Messages", "REST-AI-Embeddings"];
    const proxiesSetLiteral = "{" + defaultProxies.map((p) => `'${p}'`).join(", ") + "}";
    const apiResLiteral = "{'/', '/*', '/**', '/v1/chat/completions', '/v1/chat/completions/**', '/v1beta/interactions', '/v1beta/interactions/**', '/v1/messages', '/v1/messages/**', '/v1/projects', '/v1/projects/**', '/v1/embeddings', '/v1/embeddings/**'}";
    for (const [pName, pId] of Object.entries(prodMap)) {
      if (pName.toLowerCase().includes("mcp")) continue;
      try {
        await executor.execute(`UPDATE kms_hybrid_hybrid.api_product SET proxies = ${proxiesSetLiteral}, api_res = ${apiResLiteral} WHERE tid = 'hybrid' AND id = ${pId};`);
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
            const targetProducts = ["ai-starter-package", "mcp-package"];
            for (const p of participants) {
              apps.push({
                name: p.appName || `${p.name}'s Lab App`,
                developerEmail: p.email,
                apiProducts: targetProducts,
                credentials: [
                  {
                    consumerKey: p.consumerKey,
                    consumerSecret: p.consumerSecret || "secret",
                    apiProducts: targetProducts,
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
      const appName = app.name || "";
      let appID = appMap[appName] || appMap[appName.toLowerCase()];
      if (!appID) {
        for (const [k, v] of Object.entries(appMap)) {
          if (
            k.toLowerCase() === appName.toLowerCase() ||
            k.toLowerCase().replace(/[\s-_]/g, "") === appName.toLowerCase().replace(/[\s-_]/g, "")
          ) {
            appID = v;
            break;
          }
        }
      }
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
        const matchedProductIds: string[] = [];
        let credProdList = (cred.apiProducts || []).map((c: any) =>
          typeof c === "string" ? c : c.apiproduct || c.name,
        );
        let appProdList = (app.apiProducts || []).map((p: any) =>
          typeof p === "string" ? p : p.apiproduct || p.name,
        );
        // Default to all products if missing or using placeholder test-product
        if (credProdList.length === 0 || credProdList.includes("test-product")) {
          credProdList = Object.keys(prodMap);
        }
        if (appProdList.length === 0 || appProdList.includes("test-product")) {
          appProdList = Object.keys(prodMap);
        }
        const allTargetProds = Array.from(new Set([...credProdList, ...appProdList])).filter(Boolean);
        if (allTargetProds.length > 0) {
          const matchedEntries: string[] = [];
          for (const pName of allTargetProds) {
            if (pName && prodMap[pName]) {
              matchedEntries.push(`${prodMap[pName]}: 'APPROVED'`);
              matchedProductIds.push(prodMap[pName]);
            }
          }
          if (matchedEntries.length > 0) {
            credProdMapStr = "{" + matchedEntries.join(", ") + "}";
          }
        }
        // Fallback: If no products matched, ensure all known product IDs are authorized
        if (matchedProductIds.length === 0) {
          for (const pid of Object.values(prodMap)) {
            matchedProductIds.push(pid);
          }
        }

        const q1 = `INSERT INTO kms_hybrid_hybrid.app_credential (tid, id, app_id, c_at, iss_at, sts, c_sec, api_prdt) VALUES ('hybrid', '${ckey}', ${appID}, toTimestamp(now()), toTimestamp(now()), 'APPROVED', '${csec}', ${credProdMapStr});`;
        const q2 = `INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('app_id=${appID}&tid=hybrid', 'id=${ckey}:tid=hybrid');`;
        const q3 = `INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('tid=hybrid', 'id=${ckey}:tid=hybrid');`;

        try {
          await executor.execute(q1);
          await executor.execute(q2);
          await executor.execute(q3);
          for (const pid of matchedProductIds) {
            try {
              await executor.execute(`INSERT INTO kms_hybrid_hybrid.app_and_api_product_mapper (tid, api_prdt_id, app_id, app_cred_id) VALUES ('hybrid', ${pid}, ${appID}, '${ckey}');`);
              await executor.execute(`INSERT INTO kms_hybrid_hybrid.app_and_api_product_mapper_idx (key, rid) VALUES ('app_id=${appID}&tid=hybrid', 'api_prdt_id=${pid}:tid=hybrid');`);
            } catch (e) {
              console.warn(`[CassandraSync] Error inserting app_and_api_product_mapper for ${ckey} -> ${pid}:`, e);
            }
          }
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
  products?: string[],
): Promise<boolean> {
  const targetProducts =
    products && products.length > 0
      ? products
      : ["ai-starter-package", "mcp-package"];
  const dummyApp = {
    name: appName || "Participant App",
    apiProducts: targetProducts,
    credentials: [
      {
        consumerKey,
        consumerSecret: consumerSecret || "secret",
        apiProducts: targetProducts,
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

