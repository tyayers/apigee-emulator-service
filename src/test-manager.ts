import { AssertionResult, TestResponse, TestRunResult } from "./types.ts";
import { JSONPath } from "jsonpath-plus";

export class TestHistoryManager {
  private runs: TestRunResult[] = [];
  private maxHistory: number = 300;

  public record(run: TestRunResult): void {
    this.runs.unshift(run);
    if (this.runs.length > this.maxHistory) {
      this.runs = this.runs.slice(0, this.maxHistory);
    }
  }

  public getHistory(proxyFilter?: string): TestRunResult[] {
    if (!proxyFilter) {
      return [...this.runs];
    }
    const filterLower = proxyFilter.toLowerCase();
    return this.runs.filter((r) => r.proxy.toLowerCase() === filterLower);
  }

  public getRun(id: string): TestRunResult | undefined {
    return this.runs.find((r) => r.id === id);
  }

  public clear(proxyFilter?: string): void {
    if (!proxyFilter) {
      this.runs = [];
    } else {
      const filterLower = proxyFilter.toLowerCase();
      this.runs = this.runs.filter((r) => r.proxy.toLowerCase() !== filterLower);
    }
  }
}

export function evaluateAssertions(
  assertions: string[] = [],
  resp: TestResponse,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (!assertions || assertions.length === 0) return results;

  let parsedBody: any = null;
  let hasParsedBody = false;

  const getParsedBody = () => {
    if (!hasParsedBody) {
      hasParsedBody = true;
      try {
        parsedBody = JSON.parse(resp.body);
      } catch {
        parsedBody = null;
      }
    }
    return parsedBody;
  };

  for (const assertion of assertions) {
    const trimmed = assertion.trim();
    if (!trimmed) continue;

    try {
      const res = evaluateSingleAssertion(trimmed, resp, getParsedBody);
      results.push(res);
    } catch (err: any) {
      results.push({
        assertion: trimmed,
        passed: false,
        error: err.message || String(err),
      });
    }
  }

  return results;
}

function evaluateSingleAssertion(
  assertion: string,
  resp: TestResponse,
  getBody: () => any,
): AssertionResult {
  // Support operators: ==, !=, <=, >=, <, >, contains, not contains, startswith, endswith, matches, exists, not exists
  const operators = [
    "==",
    "!=",
    "<=",
    ">=",
    "<",
    ">",
    " not contains ",
    " contains ",
    " startswith ",
    " endswith ",
    " matches ",
    " not exists",
    " exists",
  ];

  let op = "";
  let leftExpr = "";
  let rightExpr = "";

  for (const cand of operators) {
    const idx = assertion.indexOf(cand);
    if (idx !== -1) {
      op = cand.trim();
      leftExpr = assertion.slice(0, idx).trim();
      rightExpr = assertion.slice(idx + cand.length).trim();
      break;
    }
  }

  if (!op) {
    return {
      assertion,
      passed: false,
      error: "No supported comparison operator found",
    };
  }

  // Remove surrounding quotes from rightExpr
  if (
    (rightExpr.startsWith('"') && rightExpr.endsWith('"')) ||
    (rightExpr.startsWith("'") && rightExpr.endsWith("'"))
  ) {
    rightExpr = rightExpr.slice(1, -1);
  }

  // Resolve left value
  const actualVal = resolveAssertionValue(leftExpr, resp, getBody);

  // Evaluate operator
  let passed = false;
  const actualStr = String(actualVal !== undefined ? actualVal : "");

  switch (op) {
    case "exists":
      passed = actualVal !== undefined && actualVal !== null && actualVal !== "";
      break;
    case "not exists":
      passed = actualVal === undefined || actualVal === null || actualVal === "";
      break;
    case "==":
      passed = actualStr.toLowerCase() === rightExpr.toLowerCase();
      break;
    case "!=":
      passed = actualStr.toLowerCase() !== rightExpr.toLowerCase();
      break;
    case "contains":
      passed = actualStr.toLowerCase().includes(rightExpr.toLowerCase());
      break;
    case "not contains":
      passed = !actualStr.toLowerCase().includes(rightExpr.toLowerCase());
      break;
    case "startswith":
      passed = actualStr.toLowerCase().startsWith(rightExpr.toLowerCase());
      break;
    case "endswith":
      passed = actualStr.toLowerCase().endsWith(rightExpr.toLowerCase());
      break;
    case "matches":
      try {
        passed = new RegExp(rightExpr).test(actualStr);
      } catch {
        passed = false;
      }
      break;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const numAct = Number(actualVal);
      const numExp = Number(rightExpr);
      if (!isNaN(numAct) && !isNaN(numExp)) {
        if (op === "<") passed = numAct < numExp;
        if (op === "<=") passed = numAct <= numExp;
        if (op === ">") passed = numAct > numExp;
        if (op === ">=") passed = numAct >= numExp;
      } else {
        passed = false;
      }
      break;
    }
    default:
      passed = false;
  }

  return {
    assertion,
    passed,
    actual: actualStr,
    expected: rightExpr,
  };
}

function resolveAssertionValue(
  expr: string,
  resp: TestResponse,
  getBody: () => any,
): any {
  expr = expr.trim();
  const lower = expr.toLowerCase();

  if (lower === "status" || lower === "response.status" || lower === "response.statuscode") {
    return resp.statusCode;
  }
  if (lower === "duration" || lower === "durationms" || lower === "response.duration") {
    return resp.durationMs;
  }
  if (lower === "targetlatency" || lower === "targetlatencyms") {
    return resp.targetLatencyMs ?? 0;
  }

  if (lower.startsWith("headers.") || lower.startsWith("response.headers.")) {
    const key = expr.slice(expr.indexOf(".") + 1).toLowerCase();
    for (const [k, v] of Object.entries(resp.headers || {})) {
      if (k.toLowerCase() === key) return v;
    }
    return undefined;
  }

  if (lower === "body" || lower === "response.body") {
    return resp.body;
  }

  if (lower.startsWith("body.") || lower.startsWith("response.body.") || lower.startsWith("$.") || lower.startsWith("$[")) {
    const body = getBody();
    if (!body) return undefined;

    let pathExpr = expr;
    if (pathExpr.startsWith("response.body.")) pathExpr = pathExpr.slice("response.body.".length);
    else if (pathExpr.startsWith("body.")) pathExpr = pathExpr.slice("body.".length);

    if (!pathExpr.startsWith("$")) pathExpr = "$." + pathExpr;

    try {
      const result = JSONPath({ path: pathExpr, json: body });
      if (Array.isArray(result) && result.length > 0) {
        return result[0];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
