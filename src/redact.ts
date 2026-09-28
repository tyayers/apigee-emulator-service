export function redactKVMValue(val: string): string {
  val = (val || "").trim();
  if (val.length < 6) {
    return val;
  }
  let visibleLen = 4;
  if (val.length < 8) {
    visibleLen = 2;
  }
  if (visibleLen >= val.length) {
    return val;
  }
  return val.slice(0, visibleLen) + "***";
}

export function extractKVMSecretValues(mapsData: any): string[] {
  const secrets: string[] = [];
  const seen = new Set<string>();

  const addSecret = (s: string) => {
    s = (s || "").trim();
    if (s.length < 6) return;
    if (s.startsWith("env.") || s.startsWith("${")) return;
    if (
      s.startsWith("http://") ||
      s.startsWith("https://") ||
      s.startsWith("application/") ||
      s.startsWith("text/")
    ) {
      return;
    }
    if (!seen.has(s)) {
      seen.add(s);
      secrets.push(s);
    }
  };

  const extractFromEntries = (entries: any) => {
    if (!entries) return;
    if (Array.isArray(entries)) {
      for (const item of entries) {
        if (typeof item === "string") {
          addSecret(item);
        } else if (item && typeof item === "object") {
          if (typeof item.value === "string") {
            addSecret(item.value);
          }
          for (const [k, v] of Object.entries(item)) {
            if (["name", "scope", "env", "environment"].includes(k)) continue;
            if (typeof v === "string") {
              addSecret(v);
            }
          }
        }
      }
    } else if (typeof entries === "object") {
      for (const v of Object.values(entries)) {
        if (typeof v === "string") {
          addSecret(v);
        } else if (v && typeof v === "object") {
          extractFromEntries(v);
        }
      }
    }
  };

  if (Array.isArray(mapsData)) {
    for (const mapObj of mapsData) {
      if (mapObj && mapObj.entries) {
        extractFromEntries(mapObj.entries);
      }
    }
  } else if (mapsData && typeof mapsData === "object") {
    if (mapsData.entries) {
      extractFromEntries(mapsData.entries);
    }
  }

  // Sort longest secrets first
  secrets.sort((a, b) => b.length - a.length);
  return secrets;
}

export function redactValue(v: any, secret: string, redacted: string): any {
  if (typeof v === "string") {
    let res = v;
    if (res.includes(secret)) {
      res = res.replaceAll(secret, redacted);
    }
    const queryEsc = encodeURIComponent(secret);
    if (queryEsc !== secret && res.includes(queryEsc)) {
      res = res.replaceAll(queryEsc, encodeURIComponent(redacted));
    }
    return res;
  }
  if (Array.isArray(v)) {
    return v.map((item) => redactValue(item, secret, redacted));
  }
  if (v && typeof v === "object") {
    const res: any = {};
    for (const [k, val] of Object.entries(v)) {
      res[k] = redactValue(val, secret, redacted);
    }
    return res;
  }
  return v;
}
