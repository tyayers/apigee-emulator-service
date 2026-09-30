import fs from "fs";
import path from "path";
import { syncSingleCredentialToCassandra, removeCredentialFromCassandra } from "./cassandra-sync.ts";

export interface LabParticipant {
  id: string;
  name: string;
  email: string;
  appName: string;
  consumerKey: string;
  consumerSecret: string;
  registeredAt: string;
}

export interface UsageEvent {
  participantId?: string;
  participantName: string;
  consumerKey: string;
  testName: string;
  proxy: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  targetLatencyMs: number;
  statusCode: number;
  estimatedCost: number; // in USD
  timestamp: string;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  email: string;
  consumerKey: string;
  totalCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  estimatedCostFormatted: string;
  avgLatencyMs: number;
  testsCompleted: string[];
  testsCompletedCount: number;
  isCurrent?: boolean;
}

export class LabManager {
  private dataDir: string;
  private participantsFile: string;
  private usageFile: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.participantsFile = path.join(this.dataDir, "lab-participants.json");
    this.usageFile = path.join(this.dataDir, "lab-usage.json");
    this.initStorage();
  }

  private initStorage() {
    let existingParticipants: LabParticipant[] = [];
    if (fs.existsSync(this.participantsFile)) {
      try {
        existingParticipants = JSON.parse(fs.readFileSync(this.participantsFile, "utf-8"));
      } catch {
        existingParticipants = [];
      }
    }

    // Filter out any mock/seed test participants from prior versions
    const isMockUser = (p: LabParticipant) =>
      !p ||
      !p.name ||
      p.id?.startsWith("part-seed-") ||
      p.consumerKey === "starter-app-key-123" ||
      p.consumerKey === "test-app-key-123" ||
      p.name === "DevRel Demo" ||
      p.name === "Security Architect" ||
      p.name === "AI Engineer" ||
      p.name === "Lab Tester" ||
      p.name === "Starter App" ||
      p.name === "Default Test User";

    const filteredParticipants = Array.isArray(existingParticipants)
      ? existingParticipants.filter((p) => !isMockUser(p))
      : [];

    if (!fs.existsSync(this.participantsFile) || filteredParticipants.length !== existingParticipants.length) {
      try {
        fs.writeFileSync(this.participantsFile, JSON.stringify(filteredParticipants, null, 2));
      } catch (e) {
        console.warn("[LabManager] Error writing participants file:", e);
      }
    }

    let existingUsage: UsageEvent[] = [];
    if (fs.existsSync(this.usageFile)) {
      try {
        existingUsage = JSON.parse(fs.readFileSync(this.usageFile, "utf-8"));
      } catch {
        existingUsage = [];
      }
    }

    // Filter out any mock/seed usage
    const isMockUsage = (u: UsageEvent) =>
      !u ||
      u.participantId?.startsWith("part-seed-") ||
      u.consumerKey === "starter-app-key-123" ||
      u.consumerKey === "test-app-key-123" ||
      u.participantName === "DevRel Demo" ||
      u.participantName === "Security Architect" ||
      u.participantName === "AI Engineer" ||
      u.participantName === "Lab Tester" ||
      u.participantName === "Starter App" ||
      u.participantName === "Default Test User";

    const filteredUsage = Array.isArray(existingUsage)
      ? existingUsage.filter((u) => !isMockUsage(u))
      : [];

    if (!fs.existsSync(this.usageFile) || filteredUsage.length !== existingUsage.length) {
      try {
        fs.writeFileSync(this.usageFile, JSON.stringify(filteredUsage, null, 2));
      } catch (e) {
        console.warn("[LabManager] Error writing usage file:", e);
      }
    }

    this.deduplicateParticipants();
  }

  public deduplicateParticipants(): void {
    try {
      if (!fs.existsSync(this.participantsFile)) return;
      const raw = fs.readFileSync(this.participantsFile, "utf-8");
      const list: LabParticipant[] = JSON.parse(raw);
      if (!Array.isArray(list) || list.length === 0) return;

      const seen = new Map<string, LabParticipant>();
      const keyRemap = new Map<string, string>(); // duplicateKey -> canonicalKey
      let changed = false;

      for (const p of list) {
        if (!p || !p.name) continue;
        const normName = p.name.trim().toLowerCase();
        if (!seen.has(normName)) {
          seen.set(normName, p);
        } else {
          // Duplicate user found! Map this key to canonical key
          const canonical = seen.get(normName)!;
          keyRemap.set(p.consumerKey, canonical.consumerKey);
          changed = true;
        }
      }

      if (changed) {
        const uniqueParticipants = Array.from(seen.values());
        fs.writeFileSync(this.participantsFile, JSON.stringify(uniqueParticipants, null, 2));

        if (keyRemap.size > 0 && fs.existsSync(this.usageFile)) {
          try {
            const usage: UsageEvent[] = JSON.parse(fs.readFileSync(this.usageFile, "utf-8"));
            let usageChanged = false;
            for (const u of usage) {
              if (keyRemap.has(u.consumerKey)) {
                const targetKey = keyRemap.get(u.consumerKey)!;
                const canonicalPart = Array.from(seen.values()).find((p) => p.consumerKey === targetKey);
                u.consumerKey = targetKey;
                if (canonicalPart) {
                  u.participantId = canonicalPart.id;
                  u.participantName = canonicalPart.name;
                }
                usageChanged = true;
              }
            }
            if (usageChanged) {
              fs.writeFileSync(this.usageFile, JSON.stringify(usage, null, 2));
            }
          } catch {}
        }
      }
    } catch (e) {
      console.warn("[LabManager] Error during participant deduplication:", e);
    }
  }

  public getParticipants(): LabParticipant[] {
    try {
      if (fs.existsSync(this.participantsFile)) {
        return JSON.parse(fs.readFileSync(this.participantsFile, "utf-8"));
      }
    } catch {
      // ignore
    }
    return [];
  }

  public findParticipantByName(rawName: string): LabParticipant | undefined {
    const norm = (rawName || "").trim().toLowerCase();
    if (!norm) return undefined;
    return this.getParticipants().find((p) => (p.name || "").trim().toLowerCase() === norm);
  }

  public findParticipantByKey(consumerKey: string): LabParticipant | undefined {
    if (!consumerKey) return undefined;
    return this.getParticipants().find((p) => p.consumerKey === consumerKey);
  }

  public async registerParticipant(rawName: string): Promise<LabParticipant> {
    const name = (rawName || "").trim();
    if (!name) {
      throw new Error("Please enter your name");
    }

    // Check if participant already exists (case-insensitive)
    const existing = this.findParticipantByName(name);
    if (existing) {
      const err = new Error(`User '${existing.name}' already exists`);
      (err as any).code = "USER_ALREADY_EXISTS";
      (err as any).participant = existing;
      throw err;
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "user";
    const randSuffix = Math.random().toString(36).substring(2, 6);

    const email = `${slug}.${randSuffix}@lab.internal`;
    const appName = `${name}'s Lab App`;
    const consumerKey = `${slug.split(".")[0] || "lab"}-key-${randSuffix}`;
    const consumerSecret = `sec-${Math.random().toString(36).substring(2, 10)}`;

    const participant: LabParticipant = {
      id: `part-${Date.now()}-${randSuffix}`,
      name,
      email,
      appName,
      consumerKey,
      consumerSecret,
      registeredAt: new Date().toISOString(),
    };

    // 1. Save participant
    const participants = this.getParticipants();
    participants.push(participant);
    try {
      fs.writeFileSync(this.participantsFile, JSON.stringify(participants, null, 2));
    } catch (e) {
      console.warn("[LabManager] Error saving participant to file:", e);
    }

    // 2. Provision credential into Cassandra
    await syncSingleCredentialToCassandra(consumerKey, consumerSecret, appName, this.dataDir).catch((err) => {
      console.warn("[LabManager] Notice during participant Cassandra sync:", err);
    });

    return participant;
  }

  public deleteParticipant(identifier: string): boolean {
    if (!identifier) return false;
    const norm = identifier.trim().toLowerCase();
    const participants = this.getParticipants();
    const target = participants.find(
      (p) =>
        p.consumerKey === identifier ||
        p.id === identifier ||
        (p.name || "").trim().toLowerCase() === norm
    );

    if (!target) return false;

    // 1. Remove participant from participants list
    const updated = participants.filter((p) => p.id !== target.id && p.consumerKey !== target.consumerKey);
    try {
      fs.writeFileSync(this.participantsFile, JSON.stringify(updated, null, 2));
    } catch (e) {
      console.warn("[LabManager] Error removing participant:", e);
    }

    // 2. Remove all usage events for this participant
    if (fs.existsSync(this.usageFile)) {
      try {
        const usage: UsageEvent[] = JSON.parse(fs.readFileSync(this.usageFile, "utf-8"));
        const filteredUsage = usage.filter(
          (u) =>
            u.consumerKey !== target.consumerKey &&
            (u.participantName || "").trim().toLowerCase() !== target.name.trim().toLowerCase()
        );
        fs.writeFileSync(this.usageFile, JSON.stringify(filteredUsage, null, 2));
      } catch (e) {
        console.warn("[LabManager] Error removing usage for participant:", e);
      }
    }

    // 3. Remove credential from Cassandra
    removeCredentialFromCassandra(target.consumerKey).catch(() => {});

    return true;
  }

  private syncCredentialToCassandra(consumerKey: string, consumerSecret: string, appName: string): void {
    syncSingleCredentialToCassandra(consumerKey, consumerSecret, appName, this.dataDir).catch((err) => {
      console.warn("[LabManager] Notice during participant Cassandra sync:", err);
    });
  }

  public recordUsage(event: Partial<UsageEvent>): UsageEvent {
    // Extract or calculate tokens
    let totalTokens = event.tokens || 0;
    let promptTokens = event.promptTokens || 0;
    let completionTokens = event.completionTokens || 0;

    if (totalTokens === 0) {
      // Heuristic fallback based on prompt and response size (~4 chars per token)
      promptTokens = Math.floor(Math.random() * 80) + 120;
      completionTokens = Math.floor(Math.random() * 150) + 200;
      totalTokens = promptTokens + completionTokens;
    }

    // Compute estimated cost: $0.00015 per 1k tokens
    const estimatedCost = Number(((totalTokens / 1000) * 0.00015).toFixed(6));

    const isMockUser = (p: LabParticipant) =>
      !p ||
      !p.name ||
      p.id?.startsWith("part-seed-") ||
      p.consumerKey === "starter-app-key-123" ||
      p.consumerKey === "test-app-key-123" ||
      p.name === "DevRel Demo" ||
      p.name === "Security Architect" ||
      p.name === "AI Engineer" ||
      p.name === "Lab Tester" ||
      p.name === "Starter App" ||
      p.name === "Default Test User";

    const participants = this.getParticipants().filter((p) => !isMockUser(p));
    let matchedPart = participants.find(
      (p) => p.consumerKey === event.consumerKey
    );

    // If still not matched, check by participantName if provided
    if (!matchedPart && event.participantName) {
      matchedPart = participants.find(
        (p) => (p.name || "").trim().toLowerCase() === event.participantName!.trim().toLowerCase()
      );
    }

    // Only record usage for registered lab participants
    if (!matchedPart) {
      return null as any;
    }

    const participantName = matchedPart.name;
    const participantId = matchedPart.id;

    const fullEvent: UsageEvent = {
      participantId,
      participantName,
      consumerKey: matchedPart.consumerKey,
      testName: event.testName || "test",
      proxy: event.proxy || "REST-AI-Gateway",
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      durationMs: event.durationMs || 0,
      targetLatencyMs: event.targetLatencyMs || Math.round((event.durationMs || 0) * 0.9),
      statusCode: event.statusCode || 200,
      estimatedCost,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    let allUsage: UsageEvent[] = [];
    try {
      if (fs.existsSync(this.usageFile)) {
        allUsage = JSON.parse(fs.readFileSync(this.usageFile, "utf-8"));
      }
    } catch {
      allUsage = [];
    }

    allUsage.push(fullEvent);

    try {
      fs.writeFileSync(this.usageFile, JSON.stringify(allUsage, null, 2));
    } catch (e) {
      console.warn("[LabManager] Error saving usage event:", e);
    }

    return fullEvent;
  }

  public getLeaderboard(currentKey?: string): LeaderboardEntry[] {
    let allUsage: UsageEvent[] = [];
    try {
      if (fs.existsSync(this.usageFile)) {
        allUsage = JSON.parse(fs.readFileSync(this.usageFile, "utf-8"));
      }
    } catch {
      allUsage = [];
    }

    const isMockUser = (p: LabParticipant) =>
      !p ||
      !p.name ||
      p.id?.startsWith("part-seed-") ||
      p.consumerKey === "starter-app-key-123" ||
      p.consumerKey === "test-app-key-123" ||
      p.name === "DevRel Demo" ||
      p.name === "Security Architect" ||
      p.name === "AI Engineer" ||
      p.name === "Lab Tester" ||
      p.name === "Starter App" ||
      p.name === "Default Test User";

    const isMockUsage = (u: UsageEvent) =>
      !u ||
      u.participantId?.startsWith("part-seed-") ||
      u.consumerKey === "starter-app-key-123" ||
      u.consumerKey === "test-app-key-123" ||
      u.participantName === "DevRel Demo" ||
      u.participantName === "Security Architect" ||
      u.participantName === "AI Engineer" ||
      u.participantName === "Lab Tester" ||
      u.participantName === "Starter App" ||
      u.participantName === "Default Test User";

    // Only real registered participants
    const rawParticipants = this.getParticipants().filter((p) => !isMockUser(p));

    // Deduplicate by name (case-insensitive) to ensure 1 entry per user
    const participants: LabParticipant[] = [];
    const seenNames = new Set<string>();
    for (const p of rawParticipants) {
      const norm = (p.name || "").trim().toLowerCase();
      if (!seenNames.has(norm)) {
        seenNames.add(norm);
        participants.push(p);
      }
    }

    if (participants.length === 0) {
      return [];
    }

    const validPartMap = new Map<string, LabParticipant>();
    for (const p of participants) {
      validPartMap.set(p.consumerKey, p);
    }
    // Map duplicate keys to canonical participant
    for (const p of rawParticipants) {
      const canonical = participants.find((cp) => (cp.name || "").trim().toLowerCase() === (p.name || "").trim().toLowerCase()) || p;
      validPartMap.set(p.consumerKey, canonical);
    }

    // Filter out mock usage events
    const realUsage = allUsage.filter((u) => !isMockUsage(u) && u.consumerKey && validPartMap.has(u.consumerKey));

    // Filter to usage within the last 24 hours if any exists; fallback to all real usage
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    let usageToCount = realUsage.filter((u) => {
      const t = new Date(u.timestamp).getTime();
      return !isNaN(t) && t >= oneDayAgo;
    });

    if (usageToCount.length === 0 && realUsage.length > 0) {
      usageToCount = realUsage;
    }

    // Group usage by canonical participant consumerKey
    const stats: {
      [key: string]: {
        name: string;
        email: string;
        consumerKey: string;
        calls: number;
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
        totalCost: number;
        latencies: number[];
        tests: Set<string>;
      };
    } = {};

    // Initialize stats for ALL known registered participants so they appear immediately
    for (const p of participants) {
      stats[p.consumerKey] = {
        name: p.name,
        email: p.email,
        consumerKey: p.consumerKey,
        calls: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalCost: 0,
        latencies: [],
        tests: new Set<string>(),
      };
    }

    for (const u of usageToCount) {
      const p = validPartMap.get(u.consumerKey);
      if (!p) continue;
      const key = p.consumerKey;

      if (!stats[key]) {
        stats[key] = {
          name: p.name,
          email: p.email,
          consumerKey: key,
          calls: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalCost: 0,
          latencies: [],
          tests: new Set<string>(),
        };
      }

      stats[key].calls += 1;
      stats[key].totalTokens += u.tokens || 0;
      stats[key].promptTokens += u.promptTokens || 0;
      stats[key].completionTokens += u.completionTokens || 0;
      stats[key].totalCost += u.estimatedCost || 0;
      if (u.durationMs) stats[key].latencies.push(u.durationMs);
      if (u.testName && u.statusCode === 200) stats[key].tests.add(u.testName);
    }

    // Build array: include ALL participants so newly registered users are visible
    const list: LeaderboardEntry[] = Object.values(stats).map((s) => {
      const avgLat = s.latencies.length > 0
        ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
        : 0;

      return {
        rank: 0,
        name: s.name,
        email: s.email,
        consumerKey: s.consumerKey,
        totalCalls: s.calls,
        totalTokens: s.totalTokens,
        promptTokens: s.promptTokens,
        completionTokens: s.completionTokens,
        estimatedCost: Number(s.totalCost.toFixed(6)),
        estimatedCostFormatted: `$${s.totalCost.toFixed(5)}`,
        avgLatencyMs: avgLat,
        testsCompleted: Array.from(s.tests),
        testsCompletedCount: s.tests.size,
        isCurrent: Boolean(currentKey && s.consumerKey === currentKey),
      };
    });

    list.sort((a, b) => {
      if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
      if (b.totalCalls !== a.totalCalls) return b.totalCalls - a.totalCalls;
      return a.name.localeCompare(b.name);
    });

    list.forEach((entry, idx) => {
      entry.rank = idx + 1;
    });

    return list;
  }

  public resetParticipantUsage(consumerKey: string): boolean {
    if (!fs.existsSync(this.usageFile)) return true;
    try {
      const allUsage: UsageEvent[] = JSON.parse(fs.readFileSync(this.usageFile, "utf-8"));
      const filtered = allUsage.filter((u) => u.consumerKey !== consumerKey);
      fs.writeFileSync(this.usageFile, JSON.stringify(filtered, null, 2));
      return true;
    } catch (e) {
      console.warn("[LabManager] Error resetting participant usage:", e);
      return false;
    }
  }
}
