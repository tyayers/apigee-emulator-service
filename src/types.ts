export interface DeployedProxy {
  name: string;
  revision: string;
  basePath: string;
  displayName?: string;
  endpoints?: string[];
}

export interface BundleInfo {
  fileName: string;
  filePath: string;
  proxyName: string;
  displayName?: string;
  sizeBytes: number;
  basePaths: string[];
  targetRoutes: string[];
  policies: string[];
  isDeployed?: boolean;
}

export interface EmulatorStatus {
  online: boolean;
  version: string;
  activeProxies: DeployedProxy[];
  availableBundles: BundleInfo[];
  products: any[];
  users: any[];
  apps: any[];
  isDeploying?: boolean;
  deployMessage?: string;
  error?: string;
}

export interface TestCase {
  name: string;
  description?: string;
  proxy: string;
  proxyDisplayName?: string;
  verb: string;
  path: string;
  headers?: { [key: string]: string };
  payload?: string;
  body?: string;
  request?: string;
  assertions?: string[];
  deployment?: string;
}

export interface DeploymentConfig {
  name: string;
  filePath: string;
  templates?: string[];
  products?: any[];
  users?: any[];
  tests?: TestCase[];
}

export interface TestRequest {
  proxy?: string;
  method?: string;
  path: string;
  headers?: { [key: string]: string };
  body?: string;
  recordTrace?: boolean;
  testName?: string;
  assertions?: string[];
}

export interface AssertionResult {
  assertion: string;
  passed: boolean;
  actual?: string;
  expected?: string;
  error?: string;
}

export interface TestResponse {
  statusCode: number;
  statusText: string;
  durationMs: number;
  targetLatencyMs?: number;
  headers: { [key: string]: string };
  body: string;
  traceSessionId?: string;
  traceData?: any;
  assertions?: AssertionResult[];
  passed?: boolean;
  testRunId?: string;
  error?: string;
  request?: TestRequest;
}

export interface TestRunResult {
  id: string;
  testName: string;
  proxy: string;
  deployment?: string;
  timestamp: string;
  passed: boolean;
  statusCode: number;
  statusText: string;
  durationMs: number;
  request: TestRequest;
  response?: TestResponse;
  assertions?: AssertionResult[];
  traceSessionId?: string;
  traceData?: any;
  error?: string;
}

export interface DeployRequest {
  all?: boolean;
  reset?: boolean;
  bundles?: string[];
  yaml?: string;
  deploymentYaml?: string;
  deploymentFile?: string;
}

export interface DeployResponse {
  success: boolean;
  message?: string;
  revision?: string;
  deployed?: DeployedProxy[];
  totalDeployed?: number;
  deployedCount?: number;
  durationMs?: number;
  error?: string;
}

export interface TestsRunRequest {
  proxy?: string;
  testName?: string;
}

export interface TestsRunResponse {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: TestRunResult[];
}

export interface ValidationCheck {
  category: string;
  title: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

export interface EmulatorStateResponse {
  online: boolean;
  mgmtUrl: string;
  runtimeUrl: string;
  deploymentTree: any;
  activeProxies: DeployedProxy[];
  packagedBundles: BundleInfo[];
  products: any[];
  users: any[];
  apps: any[];
  maps: any[];
  dataCollectors: any[];
  testDataLoaded: boolean;
  lastTestDataUpload?: string;
  lastTestDataStatus?: string;
  validationChecks: ValidationCheck[];
  totalActiveProxies: number;
  totalProducts: number;
  totalUsers: number;
  totalApps: number;
}

export interface ProxyYamlResponse {
  success: boolean;
  proxy?: string;
  displayName?: string;
  yaml?: string;
  source?: string;
  error?: string;
}

export interface AnalyticsSaveResponse {
  success: boolean;
  id?: string;
  record?: any;
  error?: string;
}

export interface AnalyticsQueryResponse {
  records: any[];
  count: number;
  projectId: string;
  database: string;
  error?: string;
}
