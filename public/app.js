// Apigee Emulator Tester Frontend Application
(() => {
  // Determine API Base dynamically based on location
  const API_BASE = window.location.pathname.startsWith('/manage') ? '/manage/api' : '/tester/api';

  // Application State
  const state = {
    status: null,
    bundles: [],
    activeProxies: [],
    tests: [],
    selectedProxyName: null,
    selectedPreset: null,
    lastResponse: null,
    lastTraceData: null,
    activeTraceView: 'timeline', // 'timeline' or 'json'
  };

  // SVG Icons (Monochromatic)
  const ICONS = {
    proxyNode: `<svg class="proxy-indicator-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>`,
    check: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    alert: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  // DOM Elements
  const el = {
    statusBadge: document.getElementById('emulator-status-badge'),
    statusText: document.getElementById('emulator-status-text'),
    btnDeployAll: document.getElementById('btn-deploy-all'),
    btnReset: document.getElementById('btn-reset-emulator'),
    btnRefresh: document.getElementById('btn-refresh'),
    activeProxiesList: document.getElementById('active-proxies-list'),
    activeProxiesCount: document.getElementById('active-proxies-count'),
    bundlesList: document.getElementById('bundles-list'),
    bundlesCount: document.getElementById('bundles-count'),
    btnDeploySelected: document.getElementById('btn-deploy-selected'),
    presetSelect: document.getElementById('test-preset-select'),
    reqMethod: document.getElementById('req-method'),
    reqPath: document.getElementById('req-path'),
    reqProxyName: document.getElementById('req-proxy-name'),
    chkRecordTrace: document.getElementById('chk-record-trace'),
    btnSendReq: document.getElementById('btn-send-req'),
    headersTbody: document.getElementById('headers-tbody'),
    headerCountBadge: document.getElementById('header-count-badge'),
    btnAddHeader: document.getElementById('btn-add-header'),
    btnAddApiKey: document.getElementById('btn-add-apikey'),
    reqBody: document.getElementById('req-body'),
    btnPrettifyBody: document.getElementById('btn-prettify-body'),
    btnClearBody: document.getElementById('btn-clear-body'),
    respStatusBadge: document.getElementById('resp-status-badge'),
    respTimeBadge: document.getElementById('resp-time-badge'),
    respSizeBadge: document.getElementById('resp-size-badge'),
    respBodyContent: document.getElementById('resp-body-content'),
    respHeadersTbody: document.getElementById('resp-headers-tbody'),
    btnCopyResponse: document.getElementById('btn-copy-response'),
    traceIndicator: document.getElementById('trace-indicator'),
    traceSummaryBar: document.getElementById('trace-summary-bar'),
    traceSessionId: document.getElementById('trace-session-id'),
    btnCopySession: document.getElementById('btn-copy-session'),
    btnTraceViewTimeline: document.getElementById('btn-trace-view-timeline'),
    btnTraceViewJson: document.getElementById('btn-trace-view-json'),
    btnDownloadTrace: document.getElementById('btn-download-trace'),
    traceTimelineView: document.getElementById('trace-timeline-view'),
    tracePipelineContainer: document.getElementById('trace-pipeline-container'),
    traceJsonView: document.getElementById('trace-json-view'),
    traceRawContent: document.getElementById('trace-raw-content'),
    btnCopyTraceJson: document.getElementById('btn-copy-trace-json'),
    traceStepDetail: document.getElementById('trace-step-detail'),
    stepDetailPhase: document.getElementById('step-detail-phase'),
    stepDetailTitle: document.getElementById('step-detail-title'),
    stepDetailBody: document.getElementById('step-detail-body'),
    btnCloseStepDetail: document.getElementById('btn-close-step-detail'),

    // View Navigation & Analytics
    viewTester: document.getElementById('view-tester'),
    viewAnalytics: document.getElementById('view-analytics'),
    navBtnTester: document.getElementById('nav-btn-tester'),
    navBtnAnalytics: document.getElementById('nav-btn-analytics'),
    navAnalyticsBadge: document.getElementById('nav-analytics-badge'),
    btnViewTraceAnalytics: document.getElementById('btn-view-trace-analytics'),

    // Analytics Header & Toolbar
    btnRefreshAnalytics: document.getElementById('btn-refresh-analytics'),
    iconRefreshAnalytics: document.getElementById('icon-refresh-analytics'),
    btnSeedAnalytics: document.getElementById('btn-seed-analytics'),
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnExportJson: document.getElementById('btn-export-json'),
    chkAnalyticsAutorefresh: document.getElementById('chk-analytics-autorefresh'),
    analyticsDbTag: document.getElementById('analytics-db-tag'),

    // KPI Summary elements
    kpiTotalRequests: document.getElementById('kpi-total-requests'),
    kpiStatusSplit: document.getElementById('kpi-status-split'),
    kpiTotalTokens: document.getElementById('kpi-total-tokens'),
    kpiTokensSplit: document.getElementById('kpi-tokens-split'),
    kpiAvgDuration: document.getElementById('kpi-avg-duration'),
    kpiTargetLatency: document.getElementById('kpi-target-latency'),
    kpiSuccessRate: document.getElementById('kpi-success-rate'),
    kpiErrorCount: document.getElementById('kpi-error-count'),
    kpiTopModel: document.getElementById('kpi-top-model'),
    kpiTopModelCount: document.getElementById('kpi-top-model-count'),
    kpiActiveProviders: document.getElementById('kpi-active-providers'),
    kpiProvidersList: document.getElementById('kpi-providers-list'),

    // Charts
    chartTimeline: document.getElementById('chart-timeline'),
    chartModels: document.getElementById('chart-models'),
    chartTokens: document.getElementById('chart-tokens'),
    chartLatency: document.getElementById('chart-latency'),

    // Filters
    analyticsSearch: document.getElementById('analytics-search'),
    analyticsFilterProxy: document.getElementById('analytics-filter-proxy'),
    analyticsFilterModel: document.getElementById('analytics-filter-model'),
    analyticsFilterProvider: document.getElementById('analytics-filter-provider'),
    analyticsFilterStatus: document.getElementById('analytics-filter-status'),
    btnResetFilters: document.getElementById('btn-reset-filters'),
    analyticsFilterCounter: document.getElementById('analytics-filter-counter'),

    // Table & Pagination
    analyticsTableBody: document.getElementById('analytics-table-body'),
    analyticsPageSize: document.getElementById('analytics-page-size'),
    analyticsPageText: document.getElementById('analytics-page-text'),
    btnPagePrev: document.getElementById('btn-page-prev'),
    btnPageNext: document.getElementById('btn-page-next'),

    // Drawer / Modal
    analyticsRecordDrawer: document.getElementById('analytics-record-drawer'),
    analyticsDrawerBackdrop: document.getElementById('analytics-drawer-backdrop'),
    drawerRecordId: document.getElementById('drawer-record-id'),
    btnCloseAnalyticsDrawer: document.getElementById('btn-close-analytics-drawer'),
    drawerAiContent: document.getElementById('drawer-ai-content'),
    drawerGeneralContent: document.getElementById('drawer-general-content'),
    drawerRawJson: document.getElementById('drawer-raw-json'),
    btnCopyDrawerJson: document.getElementById('btn-copy-drawer-json'),

    // Deployment Wait Modal
    deployModal: document.getElementById('deploy-modal'),
    deployModalTitle: document.getElementById('deploy-modal-title'),
    deployModalDesc: document.getElementById('deploy-modal-desc'),
    deployModalStatusText: document.getElementById('deploy-modal-status-text'),
    btnDeployModalDismiss: document.getElementById('btn-deploy-modal-dismiss'),
  };

  // Deployment Wait Dialog Management
  function showDeployWaitDialog(options = {}) {
    if (!el.deployModal) return;
    const title = options.title || 'Deploying Proxy Bundles';
    const desc = options.desc || 'The service is automatically deploying all proxy bundles to the Apigee emulator. Please wait while the environment and test data are initialized.';
    const status = options.status || 'Deploying bundles...';

    if (el.deployModalTitle) el.deployModalTitle.textContent = title;
    if (el.deployModalDesc) el.deployModalDesc.textContent = desc;
    if (el.deployModalStatusText) el.deployModalStatusText.textContent = status;
    if (el.btnDeployModalDismiss) el.btnDeployModalDismiss.classList.add('hidden');

    el.deployModal.classList.remove('hidden');
  }

  function updateDeployWaitDialog(statusText) {
    if (el.deployModalStatusText && statusText) {
      el.deployModalStatusText.textContent = statusText;
    }
  }

  function hideDeployWaitDialog() {
    if (!el.deployModal) return;
    el.deployModal.classList.add('hidden');
    if (el.btnDeployModalDismiss) el.btnDeployModalDismiss.classList.add('hidden');
  }

  function isDeployWaitDialogVisible() {
    return el.deployModal && !el.deployModal.classList.contains('hidden');
  }

  let isWaitingForDeployment = false;
  async function waitForDeployment(customStatusText) {
    if (isWaitingForDeployment) return;
    isWaitingForDeployment = true;

    showDeployWaitDialog({
      status: customStatusText || (state.status && state.status.deployMessage) || 'Waiting for Apigee emulator and deploying bundles...'
    });

    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 120; // 2 minutes with 1s interval
      const pollTimer = setInterval(async () => {
        attempts++;
        try {
          const resp = await fetch(`${API_BASE}/status`);
          if (resp.ok) {
            const data = await resp.json();
            state.status = data;
            state.activeProxies = data.activeProxies || [];
            state.bundles = data.availableBundles || [];

            if (data.isDeploying) {
              updateDeployWaitDialog(data.deployMessage || 'Deploying bundles to Apigee emulator...');
            } else {
              clearInterval(pollTimer);
              isWaitingForDeployment = false;
              hideDeployWaitDialog();

              if (data.online) {
                el.statusBadge.className = 'status-badge status-online';
                const proxyCount = state.activeProxies.length;
                el.statusText.textContent = `Emulator Ready (${proxyCount} deployed)`;
              } else {
                el.statusBadge.className = 'status-badge status-offline';
                el.statusText.textContent = data.error || 'Emulator Offline';
              }

              try { renderActiveProxies(); } catch (e) { console.error(e); }
              try { renderBundles(); } catch (e) { console.error(e); }
              try { updateProxySelector(); } catch (e) { console.error(e); }

              if (data.error && (!data.activeProxies || data.activeProxies.length === 0)) {
                showToast(`Deployment error: ${data.error}`, 5000);
              } else if (data.activeProxies && data.activeProxies.length > 0) {
                showToast(`All bundles deployed successfully! (${data.activeProxies.length} active proxies)`);
                if (!state.selectedProxyName && state.activeProxies.length > 0) {
                  const first = state.activeProxies[0];
                  const name = first.name || first.Name;
                  if (name) selectProxy(name, false);
                }
              }
              resolve(data);
              return;
            }
          }
        } catch (err) {
          console.warn('[AutoDeploy] Error polling status:', err);
        }

        if (attempts >= maxAttempts) {
          clearInterval(pollTimer);
          isWaitingForDeployment = false;
          if (el.deployModalStatusText) {
            el.deployModalStatusText.textContent = 'Deployment timeout reached';
          }
          if (el.btnDeployModalDismiss) {
            el.btnDeployModalDismiss.classList.remove('hidden');
          }
          resolve(null);
        }
      }, 1000);
    });
  }

  // Initialization
  async function init() {
    setupTabHandlers();
    setupEventListeners();
    setupAnalyticsEventListeners();
    initDefaultHeaders();
    await loadInitialData();
    fetchAnalyticsSummary();

    if (window.location.hash === '#analytics' || new URLSearchParams(window.location.search).get('view') === 'analytics') {
      switchView('analytics');
    }
  }

  async function loadInitialData() {
    await Promise.all([
      fetchStatus(),
      fetchTests(),
    ]);

    // If the service is currently auto-deploying bundles on startup, wait for it
    if (state.status && state.status.isDeploying) {
      await waitForDeployment();
    }

    // Handle deep linked proxy parameter from URL (e.g. ?proxy=TestProxy)
    const urlParams = new URLSearchParams(window.location.search);
    const proxyFromUrl = urlParams.get('proxy');
    if (proxyFromUrl) {
      selectProxy(proxyFromUrl, false);
    } else if (state.activeProxies.length > 0) {
      // Default to first active proxy without overwriting URL
      const first = state.activeProxies[0];
      const name = first.name || first.Name;
      if (name) selectProxy(name, false);
    }
  }

  // URL State Management
  function getSelectedProxyFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('proxy') || '';
  }

  function setProxyInUrl(proxyName) {
    if (!proxyName) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('proxy') === proxyName) return;
    url.searchParams.set('proxy', proxyName);
    window.history.replaceState({}, '', url.toString());
  }

  // Setup generic tab switching
  function setupTabHandlers() {
    document.querySelectorAll('.tabs-header, .response-tabs').forEach(container => {
      container.addEventListener('click', e => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const targetId = btn.getAttribute('data-tab');
        if (!targetId) return;

        // Deactivate siblings in this container
        container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Find parent card and switch tab-content
        const card = container.closest('.card');
        if (card) {
          card.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          const targetContent = card.querySelector(`#${targetId}`);
          if (targetContent) targetContent.classList.add('active');
        }
      });
    });
  }

  // Event Listeners
  function setupEventListeners() {
    el.btnRefresh.addEventListener('click', () => fetchStatus(true));
    el.btnDeployAll.addEventListener('click', deployAll);
    el.btnDeploySelected.addEventListener('click', deploySelected);
    el.btnReset.addEventListener('click', resetEmulator);
    el.btnSendReq.addEventListener('click', sendTestRequest);
    if (el.btnDeployModalDismiss) {
      el.btnDeployModalDismiss.addEventListener('click', hideDeployWaitDialog);
    }

    el.btnAddHeader.addEventListener('click', () => addHeaderRow('', ''));
    el.btnAddApiKey.addEventListener('click', () => {
      addHeaderRow('x-api-key', 'starter-app-key-123');
    });

    el.btnPrettifyBody.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(el.reqBody.value);
        el.reqBody.value = JSON.stringify(parsed, null, 2);
      } catch (err) {
        alert('Invalid JSON in body: ' + err.message);
      }
    });

    el.btnClearBody.addEventListener('click', () => {
      el.reqBody.value = '';
    });

    el.btnCopyResponse.addEventListener('click', () => {
      navigator.clipboard.writeText(el.respBodyContent.textContent);
      showToast('Response body copied to clipboard');
    });

    if (el.btnCopySession) {
      el.btnCopySession.addEventListener('click', () => {
        const sid = el.traceSessionId.textContent;
        if (sid && sid !== '-') {
          navigator.clipboard.writeText(sid);
          showToast('Session ID copied');
        }
      });
    }

    if (el.btnCopyTraceJson) {
      el.btnCopyTraceJson.addEventListener('click', () => {
        navigator.clipboard.writeText(el.traceRawContent.textContent);
        showToast('Trace JSON copied');
      });
    }

    if (el.btnTraceViewTimeline && el.btnTraceViewJson) {
      el.btnTraceViewTimeline.addEventListener('click', () => {
        el.btnTraceViewTimeline.classList.add('active');
        el.btnTraceViewJson.classList.remove('active');
        el.traceTimelineView.classList.remove('hidden');
        el.traceJsonView.classList.add('hidden');
        state.activeTraceView = 'timeline';
      });

      el.btnTraceViewJson.addEventListener('click', () => {
        el.btnTraceViewJson.classList.add('active');
        el.btnTraceViewTimeline.classList.remove('active');
        el.traceTimelineView.classList.add('hidden');
        el.traceJsonView.classList.remove('hidden');
        state.activeTraceView = 'json';
      });
    }

    el.btnDownloadTrace.addEventListener('click', downloadTraceJson);
    el.btnCloseStepDetail.addEventListener('click', () => {
      el.traceStepDetail.classList.add('hidden');
    });

    el.presetSelect.addEventListener('change', handlePresetChange);

    // Target Proxy Dropdown change
    el.reqProxyName.addEventListener('change', () => {
      selectProxy(el.reqProxyName.value, true);
    });

    // Browser navigation (back/forward)
    window.addEventListener('popstate', () => {
      const p = getSelectedProxyFromUrl();
      if (p) selectProxy(p, false);
    });

    // View Navigation (API Tester vs Analytics)
    if (el.navBtnTester) {
      el.navBtnTester.addEventListener('click', () => switchView('tester'));
    }
    if (el.navBtnAnalytics) {
      el.navBtnAnalytics.addEventListener('click', () => switchView('analytics'));
    }
    if (el.btnViewTraceAnalytics) {
      el.btnViewTraceAnalytics.addEventListener('click', () => switchView('analytics'));
    }
  }

  function initDefaultHeaders() {
    el.headersTbody.innerHTML = '';
    addHeaderRow('Content-Type', 'application/json', true);
    addHeaderRow('Accept', 'application/json', true);
  }

  function addHeaderRow(key = '', val = '', enabled = true) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="header-enable" ${enabled ? 'checked' : ''}>
      </td>
      <td>
        <input type="text" class="table-input header-key" placeholder="Key" value="${escapeHtml(key)}">
      </td>
      <td>
        <input type="text" class="table-input header-val" placeholder="Value" value="${escapeHtml(val)}">
      </td>
      <td style="text-align: center;">
        <button class="btn-del-row" title="Delete header">&times;</button>
      </td>
    `;

    tr.querySelector('.btn-del-row').addEventListener('click', () => {
      tr.remove();
      updateHeaderCount();
    });

    tr.querySelectorAll('.table-input, .header-enable').forEach(input => {
      input.addEventListener('input', updateHeaderCount);
    });

    el.headersTbody.appendChild(tr);
    updateHeaderCount();
  }

  function updateHeaderCount() {
    const activeHeaders = el.headersTbody.querySelectorAll('.header-enable:checked');
    el.headerCountBadge.textContent = activeHeaders.length;
  }

  function getHeadersFromTable() {
    const headers = {};
    el.headersTbody.querySelectorAll('tr').forEach(tr => {
      const enabled = tr.querySelector('.header-enable')?.checked;
      const key = tr.querySelector('.header-key')?.value?.trim();
      const val = tr.querySelector('.header-val')?.value?.trim();
      if (enabled && key) {
        headers[key] = val;
      }
    });
    return headers;
  }

  // API Calls
  async function fetchStatus(notify = false) {
    el.statusBadge.className = 'status-badge status-loading';
    el.statusText.textContent = 'Checking Emulator...';

    try {
      const resp = await fetch(`${API_BASE}/status`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      state.status = data;
      state.activeProxies = data.activeProxies || [];
      state.bundles = data.availableBundles || [];

      // If service is currently deploying bundles and dialog is not yet shown, wait for it
      if (data.isDeploying && !isDeployWaitDialogVisible()) {
        waitForDeployment();
      }

      // Update UI
      if (data.online) {
        el.statusBadge.className = 'status-badge status-online';
        const proxyCount = state.activeProxies.length;
        el.statusText.textContent = `Emulator Ready (${proxyCount} deployed)`;
      } else {
        el.statusBadge.className = 'status-badge status-offline';
        el.statusText.textContent = data.error || 'Emulator Offline';
      }

      try { renderActiveProxies(); } catch (e) { console.error('Error rendering active proxies:', e); }
      try { renderBundles(); } catch (e) { console.error('Error rendering bundles:', e); }
      try { updateProxySelector(); } catch (e) { console.error('Error updating proxy selector:', e); }

      // Restore selected proxy if in URL or active
      const currentSelected = state.selectedProxyName || getSelectedProxyFromUrl();
      if (currentSelected) {
        highlightProxyInList(currentSelected);
      }

      if (notify) {
        showToast('Refreshed emulator status');
      }
    } catch (err) {
      el.statusBadge.className = 'status-badge status-offline';
      el.statusText.textContent = 'Disconnected: ' + err.message;
      console.error('Failed to fetch status:', err);
    }
  }

  async function fetchTests() {
    try {
      const resp = await fetch(`${API_BASE}/tests`);
      if (!resp.ok) return;
      const data = await resp.json();
      state.tests = data || [];
      populatePresets();
    } catch (err) {
      console.warn('Failed to load tests:', err);
    }
  }

  function populatePresets() {
    el.presetSelect.innerHTML = '<option value="">-- Load a Sample Test --</option>';
    state.tests.forEach((t, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = `${t.proxy} - ${t.name}`;
      el.presetSelect.appendChild(opt);
    });
  }

  function handlePresetChange() {
    const idx = el.presetSelect.value;
    if (idx === '') return;
    const test = state.tests[idx];
    if (!test) return;

    state.selectedPreset = test;
    el.reqMethod.value = test.method || 'POST';
    el.reqPath.value = (test.path || '').replace(/^\//, '');
    el.reqProxyName.value = test.proxy || 'TestProxy';

    // Update URL to match proxy
    selectProxy(test.proxy, true, false);

    // Populate Headers
    el.headersTbody.innerHTML = '';
    const headers = test.headers || {};
    Object.keys(headers).forEach(k => {
      addHeaderRow(k, headers[k], true);
    });
    if (!headers['Content-Type']) {
      addHeaderRow('Content-Type', 'application/json', true);
    }

    // Populate Body
    if (test.body) {
      try {
        const parsed = JSON.parse(test.body);
        el.reqBody.value = JSON.stringify(parsed, null, 2);
      } catch {
        el.reqBody.value = test.body;
      }
    } else {
      el.reqBody.value = '';
    }

    showToast(`Loaded preset: ${test.name}`);
  }

  // Select Proxy & Deep Link
  function selectProxy(proxyName, updateUrl = true, autoPopulateTest = true) {
    if (!proxyName) return;
    state.selectedProxyName = proxyName;

    // Update target dropdown if exists
    if (el.reqProxyName) {
      const hasOpt = Array.from(el.reqProxyName.options).some(o => o.value === proxyName);
      if (hasOpt) {
        el.reqProxyName.value = proxyName;
      }
    }

    // Highlight in list
    highlightProxyInList(proxyName);

    // If autoPopulateTest is enabled, find proxy info or matching preset test
    if (autoPopulateTest) {
      // Find proxy basePath
      const foundProxy = state.activeProxies.find(p => {
        const n = p.name || p.Name;
        return n && n.toLowerCase() === proxyName.toLowerCase();
      });

      if (foundProxy) {
        const n = foundProxy.name || foundProxy.Name;
        const bp = foundProxy.basePath || foundProxy.BasePath || (n ? '/' + n.toLowerCase() : '');
        el.reqPath.value = bp.replace(/^\//, '');
      }

      // Check if there is a preset test for this proxy
      const matchingTestIdx = state.tests.findIndex(t => t.proxy && t.proxy.toLowerCase() === proxyName.toLowerCase());
      if (matchingTestIdx !== -1) {
        el.presetSelect.value = matchingTestIdx;
        const test = state.tests[matchingTestIdx];
        if (test) {
          el.reqMethod.value = test.method || 'GET';
          el.reqPath.value = (test.path || '').replace(/^\//, '');
          if (test.headers) {
            el.headersTbody.innerHTML = '';
            Object.keys(test.headers).forEach(k => addHeaderRow(k, test.headers[k], true));
          }
          if (test.body) {
            try {
              el.reqBody.value = JSON.stringify(JSON.parse(test.body), null, 2);
            } catch {
              el.reqBody.value = test.body;
            }
          }
        }
      }
    }

    if (updateUrl) {
      setProxyInUrl(proxyName);
    }
  }

  function highlightProxyInList(proxyName) {
    document.querySelectorAll('.proxy-item').forEach(li => {
      const name = li.getAttribute('data-proxy-name');
      if (name && name.toLowerCase() === proxyName.toLowerCase()) {
        li.classList.add('active');
      } else {
        li.classList.remove('active');
      }
    });
  }

  // Render Functions
  function renderActiveProxies() {
    el.activeProxiesCount.textContent = state.activeProxies.length;
    if (state.activeProxies.length === 0) {
      el.activeProxiesList.innerHTML = '<li class="empty-state">No proxies currently deployed.</li>';
      return;
    }

    el.activeProxiesList.innerHTML = '';
    state.activeProxies.forEach(p => {
      const name = p.name || p.Name || '';
      const basePath = p.basePath || p.BasePath || (name ? '/' + name.toLowerCase() : '');
      const revision = p.revision || p.Revision || '1';

      const li = document.createElement('li');
      li.className = 'proxy-item';
      li.setAttribute('data-proxy-name', name);
      li.setAttribute('title', `${name} (${basePath}) - Click to select & test`);

      li.innerHTML = `
        <div class="proxy-item-left">
          ${ICONS.proxyNode}
          <div class="proxy-info">
            <span class="proxy-name">${escapeHtml(name)}</span>
            <span class="proxy-basepath">${escapeHtml(basePath)} (r${revision})</span>
          </div>
        </div>
        <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3);">Active</span>
      `;

      li.addEventListener('click', () => {
        selectProxy(name, true, true);
      });

      el.activeProxiesList.appendChild(li);
    });

    if (state.selectedProxyName) {
      highlightProxyInList(state.selectedProxyName);
    }
  }

  function renderBundles() {
    el.bundlesCount.textContent = state.bundles.length;
    if (state.bundles.length === 0) {
      el.bundlesList.innerHTML = '<li class="empty-state">No bundles found in data/bundles</li>';
      return;
    }

    el.bundlesList.innerHTML = '';
    state.bundles.forEach(b => {
      const li = document.createElement('li');
      li.className = 'bundle-item';
      li.setAttribute('title', `${b.proxyName} (${b.fileName})`);

      const kb = (b.sizeBytes / 1024).toFixed(1);
      const isDeployed = b.isDeployed;
      const statusBadge = isDeployed
        ? '<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3);">Deployed</span>'
        : '<span class="badge">Available</span>';

      const basePathsStr = b.basePaths ? b.basePaths.join(', ') : '';

      li.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0; flex: 1;">
          <input type="checkbox" class="bundle-checkbox" data-file="${escapeHtml(b.fileName)}" ${isDeployed ? 'checked' : ''} title="Select bundle for deployment">
          <div class="bundle-info">
            <span class="bundle-name">${escapeHtml(b.proxyName)}</span>
            <span class="bundle-meta">${kb} KB ${basePathsStr ? '&bull; ' + escapeHtml(basePathsStr) : ''}</span>
          </div>
        </div>
        ${statusBadge}
      `;

      li.querySelector('.bundle-checkbox').addEventListener('change', updateDeploySelectedState);
      el.bundlesList.appendChild(li);
    });

    updateDeploySelectedState();
  }

  function updateProxySelector() {
    const current = el.reqProxyName.value;
    el.reqProxyName.innerHTML = '';

    const proxyNames = new Set();
    state.activeProxies.forEach(p => {
      const n = p.name || p.Name;
      if (n) proxyNames.add(n);
    });
    state.bundles.forEach(b => {
      if (b.proxyName) proxyNames.add(b.proxyName);
    });

    if (proxyNames.size === 0) {
      proxyNames.add('TestProxy');
    }

    Array.from(proxyNames).sort().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      el.reqProxyName.appendChild(opt);
    });

    if (state.selectedProxyName && proxyNames.has(state.selectedProxyName)) {
      el.reqProxyName.value = state.selectedProxyName;
    } else if (current && proxyNames.has(current)) {
      el.reqProxyName.value = current;
    }
  }

  function updateDeploySelectedState() {
    const anyChecked = el.bundlesList.querySelectorAll('.bundle-checkbox:checked').length > 0;
    el.btnDeploySelected.disabled = !anyChecked;
  }

  // Deploy Actions
  async function deployAll() {
    el.btnDeployAll.disabled = true;
    el.statusBadge.className = 'status-badge status-loading';
    el.statusText.textContent = 'Deploying all bundles...';

    showDeployWaitDialog({
      title: 'Deploying All Bundles',
      desc: 'Packaging all proxy bundles and uploading test data to the Apigee emulator...',
      status: 'Deploying all bundles to Apigee emulator...',
    });

    try {
      const resp = await fetch(`${API_BASE}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Deployment failed');

      const count = data.deployedCount || data.totalDeployed || (data.deployed ? data.deployed.length : 0);
      showToast(`Deployed ${count} proxies successfully!`);
      await fetchStatus();
    } catch (err) {
      alert('Deployment failed: ' + err.message);
      await fetchStatus();
    } finally {
      hideDeployWaitDialog();
      el.btnDeployAll.disabled = false;
    }
  }

  async function deploySelected() {
    const files = [];
    el.bundlesList.querySelectorAll('.bundle-checkbox:checked').forEach(cb => {
      const f = cb.getAttribute('data-file');
      if (f) files.push(f);
    });

    if (files.length === 0) return;

    el.btnDeploySelected.disabled = true;
    el.statusBadge.className = 'status-badge status-loading';
    el.statusText.textContent = `Deploying ${files.length} bundle(s)...`;

    showDeployWaitDialog({
      title: 'Deploying Selected Bundles',
      desc: `Packaging and deploying ${files.length} selected proxy bundle(s) to the Apigee emulator...`,
      status: `Deploying ${files.length} bundle(s)...`,
    });

    try {
      const resp = await fetch(`${API_BASE}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleFiles: files }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Deployment failed');

      const count = data.deployedCount || data.totalDeployed || (data.deployed ? data.deployed.length : 0);
      showToast(`Deployed ${count} proxies!`);
      await fetchStatus();
    } catch (err) {
      alert('Deployment failed: ' + err.message);
      await fetchStatus();
    } finally {
      hideDeployWaitDialog();
      updateDeploySelectedState();
    }
  }

  async function resetEmulator() {
    if (!confirm('Are you sure you want to reset the Apigee emulator state? All undeployed bundles will need to be redeployed.')) {
      return;
    }

    el.btnReset.disabled = true;
    el.statusBadge.className = 'status-badge status-loading';
    el.statusText.textContent = 'Resetting emulator state...';

    try {
      const resp = await fetch(`${API_BASE}/reset`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Reset failed');

      showToast('Emulator reset completed successfully');
      await fetchStatus();
    } catch (err) {
      alert('Reset failed: ' + err.message);
      await fetchStatus();
    } finally {
      el.btnReset.disabled = false;
    }
  }

  // Send Test Request
  async function sendTestRequest() {
    el.btnSendReq.disabled = true;
    el.btnSendReq.textContent = 'Sending...';

    const method = el.reqMethod.value;
    const path = el.reqPath.value.trim().replace(/^\//, '');
    const proxy = el.reqProxyName.value;
    const recordTrace = el.chkRecordTrace.checked;
    const headers = getHeadersFromTable();
    const body = el.reqBody.value;

    // Reset response view
    el.respStatusBadge.className = 'status-tag status-none';
    el.respStatusBadge.textContent = 'Sending...';
    el.respTimeBadge.classList.add('hidden');
    el.respSizeBadge.classList.add('hidden');
    el.respBodyContent.textContent = 'Executing request...';
    el.respHeadersTbody.innerHTML = '<tr><td colspan="2" class="empty-state">Waiting for response...</td></tr>';
    el.traceIndicator.classList.add('hidden');

    try {
      const resp = await fetch(`${API_BASE}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          path,
          proxy,
          headers,
          body,
          recordTrace,
        }),
      });

      const data = await resp.json();
      state.lastResponse = data;
      state.lastTraceData = data.traceData;

      // Update response metadata
      renderResponseMeta(data);

      // Render response body
      renderResponseBody(data.body);

      // Render response headers
      renderResponseHeaders(data.headers);

      // If trace data present, render vertical execution timeline
      if (data.traceData) {
        el.traceIndicator.classList.remove('hidden');
        renderTracePipeline(data.traceSessionId, data.traceData, data);

        // Extract all "ai." prefixed variables and general useful information, and save to Firestore
        handleTraceAnalyticsExtraction(data, { method, path, proxy, headers, body });
      } else {
        if (el.btnViewTraceAnalytics) el.btnViewTraceAnalytics.classList.add('hidden');
        el.tracePipelineContainer.innerHTML = '<div class="empty-state">Trace session was not recorded. Enable "Record & Inspect Trace" to inspect policy execution.</div>';
        el.traceSummaryBar.classList.add('hidden');
      }

    } catch (err) {
      el.respStatusBadge.className = 'status-tag status-5xx';
      el.respStatusBadge.textContent = 'Client Error';
      el.respBodyContent.textContent = 'Error sending request: ' + err.message;
      console.error('Request error:', err);
    } finally {
      el.btnSendReq.disabled = false;
      el.btnSendReq.innerHTML = `
        <svg class="btn-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Send
      `;
    }
  }

  function renderResponseMeta(data) {
    const sc = data.statusCode || 0;
    el.respStatusBadge.textContent = `${sc} ${data.statusText || ''}`.trim();

    if (sc >= 200 && sc < 300) {
      el.respStatusBadge.className = 'status-tag status-2xx';
    } else if (sc >= 400 && sc < 500) {
      el.respStatusBadge.className = 'status-tag status-4xx';
    } else if (sc >= 500) {
      el.respStatusBadge.className = 'status-tag status-5xx';
    } else {
      el.respStatusBadge.className = 'status-tag status-none';
    }

    if (data.durationMs !== undefined) {
      el.respTimeBadge.textContent = `${data.durationMs} ms`;
      el.respTimeBadge.classList.remove('hidden');
    }

    if (data.body) {
      const bytes = new Blob([data.body]).size;
      el.respSizeBadge.textContent = formatBytes(bytes);
      el.respSizeBadge.classList.remove('hidden');
    }
  }

  function renderResponseBody(body) {
    if (!body) {
      el.respBodyContent.textContent = '(Empty response body)';
      return;
    }
    try {
      const parsed = JSON.parse(body);
      el.respBodyContent.textContent = JSON.stringify(parsed, null, 2);
    } catch {
      el.respBodyContent.textContent = body;
    }
  }

  function renderResponseHeaders(headers) {
    el.respHeadersTbody.innerHTML = '';
    if (!headers || Object.keys(headers).length === 0) {
      el.respHeadersTbody.innerHTML = '<tr><td colspan="2" class="empty-state">No headers received.</td></tr>';
      return;
    }

    Object.keys(headers).sort().forEach(k => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family: var(--font-mono); color: var(--text-secondary);">${escapeHtml(k)}</td>
        <td style="font-family: var(--font-mono); word-break: break-all;">${escapeHtml(headers[k])}</td>
      `;
      el.respHeadersTbody.appendChild(tr);
    });
  }

  // Helper to extract properties from Apigee emulator trace format
  function extractProperties(propertiesObj) {
    if (!propertiesObj) return {};
    if (Array.isArray(propertiesObj.property)) {
      const map = {};
      propertiesObj.property.forEach(item => {
        if (item && item.name) {
          map[item.name] = item.value !== undefined ? item.value : '';
        }
      });
      return map;
    }
    if (typeof propertiesObj === 'object') {
      return propertiesObj;
    }
    return {};
  }

  // --------------------------------------------------------------------------
  // Rich Vertical Execution Trace Visualizer
  // --------------------------------------------------------------------------
  function renderTracePipeline(sessionId, traceData, testResponse) {
    el.traceSummaryBar.classList.remove('hidden');
    el.traceSessionId.textContent = sessionId || 'N/A';

    // Populate Raw JSON content
    el.traceRawContent.textContent = JSON.stringify(traceData, null, 2);

    // Parse transactions
    let txs = [];
    if (Array.isArray(traceData.transactions)) {
      txs = traceData.transactions;
    } else if (Array.isArray(traceData.Messages)) {
      txs = traceData.Messages;
    } else if (Array.isArray(traceData)) {
      txs = traceData;
    }

    if (txs.length === 0) {
      el.tracePipelineContainer.innerHTML = '<div class="empty-state">Trace session was recorded, but transaction buffer was empty.</div>';
      return;
    }

    const tx = txs[0];
    const pointList = tx.point || tx.points || [];

    // Extract policy steps and flow metadata
    const steps = [];
    let proxyName = testResponse?.proxy || '';
    let targetName = 'Target Runtime';
    let targetUrl = '';
    let totalPolicyDuration = 0;

    pointList.forEach(pt => {
      const results = pt.results || [];
      results.forEach(res => {
        const props = extractProperties(res.properties);
        const action = res.action || res.ActionResult || pt.id || '';

        // Check for flow/target info
        if (props['apiproxy.name']) proxyName = props['apiproxy.name'];
        if (props['target.name']) targetName = props['target.name'];
        if (props['target.url']) targetUrl = props['target.url'];

        // Check for policy execution
        const stepName = props['stepDefinition-name'] || props['stepDefinition-displayName'] || props['stepDefinition.name'] || props['policy.name'] || (pt.id === 'Execution' ? props['name'] : '');
        const stepType = props['stepDefinition-type'] || props['stepDefinition.type'] || props['type'] || props['policy.type'] || '';
        const durStr = props['javascript-executionTime'] || props['duration'] || '0';
        const dur = parseInt(durStr, 10) || 0;
        const result = (props['result'] || props['state'] || '').toLowerCase();
        const enforcement = props['enforcement'] || (props['flow'] ? props['flow'] : 'flow');

        if (stepName && stepName !== 'Null' && stepName !== 'None') {
          totalPolicyDuration += dur;
          const isError = result.includes('fail') || result.includes('false') || result.includes('error');
          steps.push({
            name: stepName,
            type: stepType || 'Policy',
            enforcement: enforcement,
            duration: dur,
            isError: isError,
            rawProps: props,
          });
        }
      });
    });

    // Build Vertical Layout HTML
    let html = `
      <div class="trace-vertical-timeline">
        <!-- Top Metrics Cards -->
        <div class="trace-metrics-cards">
          <div class="trace-metric-card">
            <div class="trace-metric-title">Policies Executed</div>
            <div class="trace-metric-value">${steps.length}</div>
          </div>
          <div class="trace-metric-card">
            <div class="trace-metric-title">Total Policy Time</div>
            <div class="trace-metric-value">${totalPolicyDuration} ms</div>
          </div>
          <div class="trace-metric-card">
            <div class="trace-metric-title">Status</div>
            <div class="trace-metric-value" style="color: ${testResponse?.statusCode < 400 ? '#34d399' : '#f87171'};">
              ${testResponse?.statusCode || 'OK'}
            </div>
          </div>
          <div class="trace-metric-card">
            <div class="trace-metric-title">Target Flow</div>
            <div class="trace-metric-value" style="font-size: 0.85rem; font-family: var(--font-mono); margin-top: 0.35rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(targetUrl || targetName)}">
              ${escapeHtml(targetName)}
            </div>
          </div>
        </div>

        <!-- Request Ingress -->
        <div class="trace-flow-phase">Client Request &bull; PreFlow</div>
    `;

    if (steps.length === 0) {
      html += `
        <div class="trace-step-item">
          <div class="trace-step-connector"></div>
          <div class="trace-step-node node-success">
            ${ICONS.check}
          </div>
          <div class="trace-step-card">
            <div class="trace-step-header">
              <div class="trace-step-left">
                <span class="step-type-pill">PASS-THROUGH</span>
                <span class="step-name-text">Direct Target Invocation (No Policies)</span>
              </div>
              <div class="trace-step-right">
                <span class="step-status-pill step-status-success">Passed</span>
              </div>
            </div>
          </div>
        </div>
      `;
    } else {
      let responsePhaseStarted = false;

      steps.forEach((s, idx) => {
        // If enforcement changes to response, insert flow divider
        if (!responsePhaseStarted && s.enforcement.toLowerCase().includes('response')) {
          responsePhaseStarted = true;
          html += `
            <div class="trace-flow-phase" style="margin-top: 0.75rem;">Target Response &bull; PostFlow</div>
          `;
        }

        const stepNum = String(idx + 1).padStart(2, '0');
        const nodeClass = s.isError ? 'node-error' : 'node-success';
        const statusClass = s.isError ? 'step-status-error' : 'step-status-success';
        const statusText = s.isError ? 'Failed' : 'Passed';

        html += `
          <div class="trace-step-item">
            <div class="trace-step-connector"></div>
            <div class="trace-step-node ${nodeClass}">
              ${stepNum}
            </div>
            <div class="trace-step-card" data-step-idx="${idx}">
              <div class="trace-step-header">
                <div class="trace-step-left">
                  <span class="step-type-pill">${escapeHtml(s.type)}</span>
                  <span class="step-name-text">${escapeHtml(s.name)}</span>
                </div>
                <div class="trace-step-right">
                  ${s.duration ? `<span class="step-duration-badge">${s.duration} ms</span>` : ''}
                  <span class="step-status-pill ${statusClass}">${statusText}</span>
                </div>
              </div>
              <!-- Expandable details container injected on click -->
              <div class="trace-step-details-grid hidden"></div>
            </div>
          </div>
        `;
      });
    }

    // Target Egress
    html += `
        <div class="trace-flow-phase" style="margin-top: 0.75rem;">Response Delivered to Client</div>
      </div>
    `;

    el.tracePipelineContainer.innerHTML = html;

    // Attach step expansion handlers
    el.tracePipelineContainer.querySelectorAll('.trace-step-card[data-step-idx]').forEach(card => {
      card.addEventListener('click', () => {
        const idx = card.getAttribute('data-step-idx');
        const s = steps[idx];
        if (!s) return;

        const detailsGrid = card.querySelector('.trace-step-details-grid');
        const isCurrentlyExpanded = !detailsGrid.classList.contains('hidden');

        if (isCurrentlyExpanded) {
          detailsGrid.classList.add('hidden');
          card.classList.remove('expanded');
        } else {
          // Render properties in grid
          let gridHtml = '';
          const keys = Object.keys(s.rawProps).sort();
          if (keys.length === 0) {
            gridHtml = '<div style="color: var(--text-muted); padding: 0.25rem 0;">No policy properties recorded.</div>';
          } else {
            keys.forEach(k => {
              gridHtml += `
                <div class="step-prop-row">
                  <div class="step-prop-key">${escapeHtml(k)}</div>
                  <div class="step-prop-val">${escapeHtml(s.rawProps[k])}</div>
                </div>
              `;
            });
          }
          detailsGrid.innerHTML = gridHtml;
          detailsGrid.classList.remove('hidden');
          card.classList.add('expanded');
        }
      });
    });
  }

  function downloadTraceJson() {
    if (!state.lastTraceData) {
      alert('No trace session data to download.');
      return;
    }
    const blob = new Blob([JSON.stringify(state.lastTraceData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apigee-trace-${state.lastResponse?.traceSessionId || 'session'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showToast(msg) {
    const originalText = el.statusText.textContent;
    el.statusText.textContent = msg;
    setTimeout(() => {
      el.statusText.textContent = originalText;
    }, 2500);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================================================
  // Apigee AI Analytics Dashboard & Firestore Integration
  // ==========================================================================
  const analyticsState = {
    records: [],
    filteredRecords: [],
    loading: false,
    autoRefreshInterval: null,
    sortField: 'timestamp',
    sortAsc: false,
    pageSize: 50,
    currentPage: 1,
    selectedRecord: null,
    filters: {
      search: '',
      proxy: '',
      model: '',
      provider: '',
      status: '',
    },
  };

  // View Switcher (API Tester <-> Analytics)
  function switchView(viewName) {
    if (viewName === 'tester') {
      if (el.viewTester) el.viewTester.classList.remove('hidden');
      if (el.viewAnalytics) el.viewAnalytics.classList.add('hidden');
      if (el.navBtnTester) el.navBtnTester.classList.add('active');
      if (el.navBtnAnalytics) el.navBtnAnalytics.classList.remove('active');
      history.replaceState(null, '', window.location.pathname + (window.location.search || ''));
    } else if (viewName === 'analytics') {
      if (el.viewTester) el.viewTester.classList.add('hidden');
      if (el.viewAnalytics) el.viewAnalytics.classList.remove('hidden');
      if (el.navBtnTester) el.navBtnTester.classList.remove('active');
      if (el.navBtnAnalytics) el.navBtnAnalytics.classList.add('active');
      history.replaceState(null, '', window.location.pathname + '#analytics');
      fetchAnalyticsData();
    }
  }

  // Extract all variables recursively from Apigee trace
  function extractVariablesFromTrace(traceData) {
    const vars = {};
    if (!traceData) return vars;

    function walk(obj) {
      if (!obj) return;
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) walk(obj[i]);
        return;
      }
      if (typeof obj === 'object') {
        // 1. variableAccessList / VariableAccessMap
        const list = obj.variableAccessList || obj.VariableAccessMap;
        if (Array.isArray(list)) {
          list.forEach(v => {
            if (v && v.name && v.value !== undefined) {
              vars[v.name] = v.value;
            }
          });
        }

        // 2. accessList (Get / Set)
        if (Array.isArray(obj.accessList)) {
          obj.accessList.forEach(item => {
            if (item && typeof item === 'object') {
              ['Get', 'Set', 'access'].forEach(k => {
                if (item[k] && item[k].name && item[k].value !== undefined) {
                  vars[item[k].name] = item[k].value;
                }
              });
            }
          });
        }

        // 3. property / properties.property
        if (Array.isArray(obj.property)) {
          obj.property.forEach(p => {
            if (p && p.name && p.value !== undefined) {
              vars[p.name] = p.value;
            }
          });
        } else if (obj.properties && Array.isArray(obj.properties.property)) {
          obj.properties.property.forEach(p => {
            if (p && p.name && p.value !== undefined) {
              vars[p.name] = p.value;
            }
          });
        }

        // 4. Any direct property with ai. prefix
        for (const [k, v] of Object.entries(obj)) {
          if (k.startsWith('ai.') && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
            vars[k] = v;
          } else if (typeof v === 'object' && v !== null) {
            walk(v);
          }
        }
      }
    }

    walk(traceData);
    return vars;
  }

  // Build clean analytics record from test execution + trace
  function buildAnalyticsRecord(testResponse, reqContext) {
    const traceData = testResponse.traceData || {};
    const allVars = extractVariablesFromTrace(traceData);

    // Extract all "ai." prefixed variables
    const aiVars = {};
    for (const [k, v] of Object.entries(allVars)) {
      if (k.startsWith('ai.')) {
        aiVars[k] = v;
      }
    }

    // Try parsing response body for LLM metadata if missing from trace
    let parsedBody = null;
    if (testResponse.body) {
      try {
        parsedBody = typeof testResponse.body === 'string' ? JSON.parse(testResponse.body) : testResponse.body;
      } catch (e) {}
    }

    // Model resolution
    let model = aiVars['ai.model'] || parsedBody?.model || '';
    if (!model && testResponse.headers) {
      model = testResponse.headers['x-model'] || testResponse.headers['x-ai-model'] || '';
    }
    if (!model && reqContext?.body) {
      try {
        const reqJson = JSON.parse(reqContext.body);
        if (reqJson.model) model = reqJson.model;
      } catch (e) {}
    }

    // Provider resolution
    let provider = (aiVars['ai.provider'] || '').toLowerCase();
    if (!provider && model) {
      const lower = model.toLowerCase();
      if (lower.includes('claude')) provider = 'anthropic';
      else if (lower.includes('gemini')) provider = 'google';
      else if (lower.includes('gpt')) provider = 'openai';
      else provider = 'custom';
    }

    // Token counts
    let promptTokens = parseInt(
      aiVars['ai.promptTokenCount'] ||
      aiVars['ai.promptTokens'] ||
      parsedBody?.usage?.prompt_tokens || '0', 10) || 0;

    let completionTokens = parseInt(
      aiVars['ai.candidatesTokenCount'] ||
      aiVars['ai.completionTokenCount'] ||
      aiVars['ai.completionTokens'] ||
      parsedBody?.usage?.completion_tokens || '0', 10) || 0;

    let totalTokens = parseInt(
      aiVars['ai.totalTokenCount'] ||
      aiVars['ai.totalTokens'] ||
      parsedBody?.usage?.total_tokens || (promptTokens + completionTokens), 10) || (promptTokens + completionTokens);

    const targetRoute = aiVars['ai.targetRoute'] || allVars['target.route'] || '';

    // General metadata
    const statusCode = testResponse.statusCode || parseInt(allVars['message.status.code'] || '200', 10);
    const durationMs = testResponse.durationMs || 0;
    const proxy = testResponse.proxy || allVars['apiproxy.name'] || reqContext?.proxy || '';
    const method = reqContext?.method || allVars['request.verb'] || 'POST';
    const path = reqContext?.path || allVars['request.path'] || allVars['request.uri'] || '';
    const targetUrl = allVars['target.url'] || allVars['target.host'] || '';
    const targetName = allVars['target.name'] || 'default';
    const targetLatency = parseInt(allVars['X-Apigee-target-latency'] || '0', 10);
    const clientIp = allVars['client.ip'] || '';
    const environment = allVars['environment.name'] || 'test';
    const isError = statusCode >= 400 || allVars['is.error'] === 'true';

    return {
      timestamp: new Date().toISOString(),
      proxy: proxy,
      method: method,
      path: path,
      statusCode: statusCode,
      statusText: testResponse.statusText || (statusCode === 200 ? 'OK' : ''),
      durationMs: durationMs,
      targetLatencyMs: targetLatency,
      targetUrl: targetUrl,
      targetName: targetName,
      clientIp: clientIp,
      environment: environment,
      traceSessionId: testResponse.traceSessionId || '',
      isError: isError,
      ai: {
        ...aiVars,
        model: model,
        provider: provider,
        targetRoute: targetRoute,
        promptTokens: promptTokens,
        completionTokens: completionTokens,
        totalTokens: totalTokens,
      },
      general: {
        proxyName: proxy,
        httpMethod: method,
        requestPath: path,
        statusCode: statusCode,
        durationMs: durationMs,
        targetUrl: targetUrl,
        clientIp: clientIp,
        environment: environment,
      },
    };
  }

  // Handle trace analytics extraction and POST to server
  async function handleTraceAnalyticsExtraction(testResponse, reqContext) {
    try {
      const record = buildAnalyticsRecord(testResponse, reqContext);
      const res = await fetch(`${API_BASE}/analytics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });

      if (res.ok) {
        const data = await res.json();
        console.log('[Analytics] Record saved to Firestore apigee_analytics:', data.id);
        if (el.btnViewTraceAnalytics) {
          el.btnViewTraceAnalytics.classList.remove('hidden');
        }
        fetchAnalyticsSummary();
      }
    } catch (err) {
      console.warn('[Analytics] Failed to save trace analytics record:', err);
    }
  }

  // Fetch summary count for nav badge
  async function fetchAnalyticsSummary() {
    try {
      const resp = await fetch(`${API_BASE}/analytics?limit=500`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.records && el.navAnalyticsBadge) {
          el.navAnalyticsBadge.textContent = data.records.length;
        }
      }
    } catch (e) {}
  }

  // Fetch full last 500 records from server
  async function fetchAnalyticsData() {
    analyticsState.loading = true;
    if (el.iconRefreshAnalytics) {
      el.iconRefreshAnalytics.style.animation = 'spin 1s linear infinite';
    }

    try {
      const resp = await fetch(`${API_BASE}/analytics?limit=500`);
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.error || `Server status ${resp.status}`);
      }

      const data = await resp.json();
      analyticsState.records = data.records || [];

      if (data.projectId && el.analyticsDbTag) {
        el.analyticsDbTag.textContent = `projects/${data.projectId}/databases/(default)`;
      }
      if (el.navAnalyticsBadge) {
        el.navAnalyticsBadge.textContent = analyticsState.records.length;
      }

      populateFilterDropdowns();
      applyAnalyticsFilters();
    } catch (err) {
      console.error('[Analytics] Error retrieving records:', err);
      if (el.analyticsTableBody) {
        el.analyticsTableBody.innerHTML = `<tr><td colspan="8" class="empty-state">Error retrieving analytics from Firestore: ${escapeHtml(err.message)}</td></tr>`;
      }
    } finally {
      analyticsState.loading = false;
      if (el.iconRefreshAnalytics) {
        el.iconRefreshAnalytics.style.animation = '';
      }
    }
  }

  // Populate dynamic filter dropdowns
  function populateFilterDropdowns() {
    const proxies = new Set();
    const models = new Set();
    const providers = new Set();

    analyticsState.records.forEach(r => {
      if (r.proxy) proxies.add(r.proxy);
      const ai = r.ai || {};
      const m = ai.model || ai['ai.model'];
      if (m) models.add(m);
      const p = ai.provider || ai['ai.provider'];
      if (p) providers.add(p);
    });

    const updateSelect = (selectEl, set, currentVal, defaultLabel) => {
      if (!selectEl) return;
      const sorted = Array.from(set).sort();
      selectEl.innerHTML = `<option value="">${defaultLabel}</option>` +
        sorted.map(val => `<option value="${escapeHtml(val)}" ${val === currentVal ? 'selected' : ''}>${escapeHtml(val)}</option>`).join('');
    };

    updateSelect(el.analyticsFilterProxy, proxies, analyticsState.filters.proxy, 'All Proxies');
    updateSelect(el.analyticsFilterModel, models, analyticsState.filters.model, 'All Models');
    updateSelect(el.analyticsFilterProvider, providers, analyticsState.filters.provider, 'All Providers');
  }

  // Apply search and dropdown filters
  function applyAnalyticsFilters() {
    const { search, proxy, model, provider, status } = analyticsState.filters;
    const query = search.toLowerCase().trim();

    analyticsState.filteredRecords = analyticsState.records.filter(r => {
      // Proxy filter
      if (proxy && r.proxy !== proxy) return false;

      const ai = r.ai || {};
      const rModel = ai.model || ai['ai.model'] || '';
      const rProvider = (ai.provider || ai['ai.provider'] || '').toLowerCase();

      // Model filter
      if (model && rModel !== model) return false;

      // Provider filter
      if (provider && rProvider !== provider.toLowerCase()) return false;

      // Status filter
      const sc = r.statusCode || 200;
      if (status === 'success' && (sc < 200 || sc >= 300 || r.isError)) return false;
      if (status === '4xx' && (sc < 400 || sc >= 500)) return false;
      if (status === '5xx' && sc < 500) return false;

      // Search query
      if (query) {
        const str = [
          r.proxy,
          r.method,
          r.path,
          r.traceSessionId,
          rModel,
          rProvider,
          ai.targetRoute,
          String(sc),
        ].join(' ').toLowerCase();
        if (!str.includes(query)) return false;
      }

      return true;
    });

    sortAnalyticsRecords();
    computeKpis(analyticsState.filteredRecords);
    renderTimelineChart(analyticsState.filteredRecords);
    renderModelsChart(analyticsState.filteredRecords);
    renderTokensChart(analyticsState.filteredRecords);
    renderLatencyChart(analyticsState.filteredRecords);
    renderAnalyticsTable();
  }

  // Sort filtered records
  function sortAnalyticsRecords() {
    const field = analyticsState.sortField;
    const asc = analyticsState.sortAsc;

    analyticsState.filteredRecords.sort((a, b) => {
      let valA, valB;
      if (field === 'timestamp') {
        valA = a.timestamp || a.createTime || '';
        valB = b.timestamp || b.createTime || '';
      } else if (field === 'proxy') {
        valA = (a.proxy || '').toLowerCase();
        valB = (b.proxy || '').toLowerCase();
      } else if (field === 'statusCode') {
        valA = a.statusCode || 0;
        valB = b.statusCode || 0;
      } else if (field === 'durationMs') {
        valA = a.durationMs || 0;
        valB = b.durationMs || 0;
      } else if (field === 'model') {
        valA = (a.ai?.model || a.ai?.['ai.model'] || '').toLowerCase();
        valB = (b.ai?.model || b.ai?.['ai.model'] || '').toLowerCase();
      } else if (field === 'totalTokens') {
        valA = parseInt(a.ai?.totalTokens || a.ai?.['ai.totalTokenCount'] || 0, 10);
        valB = parseInt(b.ai?.totalTokens || b.ai?.['ai.totalTokenCount'] || 0, 10);
      } else {
        valA = a[field];
        valB = b[field];
      }

      if (valA < valB) return asc ? -1 : 1;
      if (valA > valB) return asc ? 1 : -1;
      return 0;
    });
  }

  // Compute and render KPI metrics
  function computeKpis(records) {
    const total = records.length;
    if (total === 0) {
      if (el.kpiTotalRequests) el.kpiTotalRequests.textContent = '0';
      if (el.kpiStatusSplit) el.kpiStatusSplit.textContent = '2xx: 0 • Errors: 0';
      if (el.kpiTotalTokens) el.kpiTotalTokens.textContent = '0';
      if (el.kpiTokensSplit) el.kpiTokensSplit.textContent = 'Prompt: 0 • Comp: 0';
      if (el.kpiAvgDuration) el.kpiAvgDuration.textContent = '0 ms';
      if (el.kpiTargetLatency) el.kpiTargetLatency.textContent = 'Target avg: 0 ms';
      if (el.kpiSuccessRate) {
        el.kpiSuccessRate.textContent = '100%';
        el.kpiSuccessRate.style.color = '#10b981';
      }
      if (el.kpiErrorCount) el.kpiErrorCount.textContent = '0 error calls';
      if (el.kpiTopModel) el.kpiTopModel.textContent = 'None';
      if (el.kpiTopModelCount) el.kpiTopModelCount.textContent = '0 requests';
      if (el.kpiActiveProviders) el.kpiActiveProviders.textContent = '0';
      if (el.kpiProvidersList) el.kpiProvidersList.textContent = '-';
      return;
    }

    let successCount = 0;
    let errorCount = 0;
    let totalPromptTok = 0;
    let totalCompTok = 0;
    let totalTokens = 0;
    let totalDuration = 0;
    let totalTargetLat = 0;
    let targetLatCount = 0;
    const modelCounts = {};
    const providers = new Set();

    records.forEach(r => {
      const sc = r.statusCode || 200;
      if (sc >= 200 && sc < 400 && !r.isError) {
        successCount++;
      } else {
        errorCount++;
      }

      const ai = r.ai || {};
      const pt = parseInt(ai.promptTokens || ai['ai.promptTokenCount'] || 0, 10) || 0;
      const ct = parseInt(ai.completionTokens || ai['ai.candidatesTokenCount'] || 0, 10) || 0;
      const tt = parseInt(ai.totalTokens || ai['ai.totalTokenCount'] || (pt + ct), 10) || (pt + ct);

      totalPromptTok += pt;
      totalCompTok += ct;
      totalTokens += tt;

      const dur = parseInt(r.durationMs || 0, 10) || 0;
      totalDuration += dur;

      const tLat = parseInt(r.targetLatencyMs || 0, 10);
      if (tLat > 0) {
        totalTargetLat += tLat;
        targetLatCount++;
      }

      const model = ai.model || ai['ai.model'] || 'Unknown';
      modelCounts[model] = (modelCounts[model] || 0) + 1;

      const prov = ai.provider || ai['ai.provider'];
      if (prov) providers.add(prov.toLowerCase());
    });

    const rate = ((successCount / total) * 100).toFixed(1);
    if (el.kpiSuccessRate) {
      el.kpiSuccessRate.textContent = `${rate}%`;
      el.kpiSuccessRate.style.color = rate >= 95 ? '#10b981' : rate >= 80 ? '#f59e0b' : '#ef4444';
    }
    if (el.kpiErrorCount) el.kpiErrorCount.textContent = `${errorCount} error call(s)`;

    if (el.kpiTotalRequests) el.kpiTotalRequests.textContent = total.toLocaleString();
    if (el.kpiStatusSplit) el.kpiStatusSplit.textContent = `2xx: ${successCount} • Errors: ${errorCount}`;

    if (el.kpiTotalTokens) el.kpiTotalTokens.textContent = totalTokens.toLocaleString();
    if (el.kpiTokensSplit) el.kpiTokensSplit.textContent = `Prompt: ${totalPromptTok.toLocaleString()} • Comp: ${totalCompTok.toLocaleString()}`;

    const avgDur = Math.round(totalDuration / total);
    if (el.kpiAvgDuration) el.kpiAvgDuration.textContent = `${avgDur} ms`;
    const avgTarget = targetLatCount > 0 ? Math.round(totalTargetLat / targetLatCount) : 0;
    if (el.kpiTargetLatency) el.kpiTargetLatency.textContent = `Target avg: ${avgTarget} ms`;

    let topModel = 'None';
    let topCount = 0;
    for (const [m, c] of Object.entries(modelCounts)) {
      if (c > topCount && m !== 'Unknown') {
        topModel = m;
        topCount = c;
      }
    }
    if (topModel === 'None' && Object.keys(modelCounts).length > 0) {
      topModel = Object.keys(modelCounts)[0];
      topCount = modelCounts[topModel];
    }
    if (el.kpiTopModel) el.kpiTopModel.textContent = topModel;
    if (el.kpiTopModelCount) el.kpiTopModelCount.textContent = `${topCount} calls (${((topCount / total) * 100).toFixed(0)}%)`;

    if (el.kpiActiveProviders) el.kpiActiveProviders.textContent = providers.size.toString();
    if (el.kpiProvidersList) el.kpiProvidersList.textContent = Array.from(providers).map(p => p.toUpperCase()).join(', ') || 'None';
  }

  // Chart 1: Time-series Traffic & Errors
  function renderTimelineChart(records) {
    if (!el.chartTimeline) return;
    if (records.length === 0) {
      el.chartTimeline.innerHTML = '<div class="empty-state">No records for timeline chart.</div>';
      return;
    }

    // Sort ascending by timestamp for timeline
    const chronological = [...records].sort((a, b) => {
      const ta = new Date(a.timestamp || a.createTime || 0).getTime();
      const tb = new Date(b.timestamp || b.createTime || 0).getTime();
      return ta - tb;
    });

    const numBuckets = Math.min(16, chronological.length);
    const bucketSize = Math.max(1, Math.ceil(chronological.length / numBuckets));
    const buckets = [];

    for (let i = 0; i < chronological.length; i += bucketSize) {
      const slice = chronological.slice(i, i + bucketSize);
      let s2xx = 0, s4xx = 0, s5xx = 0;
      slice.forEach(r => {
        const sc = r.statusCode || 200;
        if (sc >= 200 && sc < 300) s2xx++;
        else if (sc >= 400 && sc < 500) s4xx++;
        else s5xx++;
      });
      const firstTime = slice[0].timestamp || slice[0].createTime;
      buckets.push({
        label: formatTimelineLabel(firstTime),
        count2xx: s2xx,
        count4xx: s4xx,
        count5xx: s5xx,
        total: slice.length,
      });
    }

    let maxTotal = 1;
    buckets.forEach(b => {
      if (b.total > maxTotal) maxTotal = b.total;
    });

    const w = 560;
    const h = 200;
    const padding = { top: 20, right: 15, bottom: 35, left: 35 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;
    const barWidth = Math.max(12, Math.floor((chartW / buckets.length) * 0.65));
    const barStep = chartW / buckets.length;

    let svg = `
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
        <!-- Grid lines -->
        <line x1="${padding.left}" y1="${padding.top}" x2="${w - padding.right}" y2="${padding.top}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
        <line x1="${padding.left}" y1="${padding.top + chartH * 0.5}" x2="${w - padding.right}" y2="${padding.top + chartH * 0.5}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
        <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" stroke="rgba(255,255,255,0.15)" />

        <!-- Y Axis labels -->
        <text x="${padding.left - 6}" y="${padding.top + 4}" fill="#64748b" font-size="10" text-anchor="end">${maxTotal}</text>
        <text x="${padding.left - 6}" y="${padding.top + chartH * 0.5 + 4}" fill="#64748b" font-size="10" text-anchor="end">${Math.round(maxTotal / 2)}</text>
        <text x="${padding.left - 6}" y="${h - padding.bottom + 4}" fill="#64748b" font-size="10" text-anchor="end">0</text>
    `;

    buckets.forEach((b, idx) => {
      const x = padding.left + (idx * barStep) + (barStep - barWidth) / 2;
      const h2xx = Math.round((b.count2xx / maxTotal) * chartH);
      const h4xx = Math.round((b.count4xx / maxTotal) * chartH);
      const h5xx = Math.round((b.count5xx / maxTotal) * chartH);

      let curY = h - padding.bottom;

      if (h2xx > 0) {
        curY -= h2xx;
        svg += `<rect x="${x}" y="${curY}" width="${barWidth}" height="${h2xx}" fill="#10b981" rx="2">
          <title>${b.label}: ${b.count2xx} successful calls (2xx)</title>
        </rect>`;
      }
      if (h4xx > 0) {
        curY -= h4xx;
        svg += `<rect x="${x}" y="${curY}" width="${barWidth}" height="${h4xx}" fill="#f59e0b" rx="2">
          <title>${b.label}: ${b.count4xx} client errors (4xx)</title>
        </rect>`;
      }
      if (h5xx > 0) {
        curY -= h5xx;
        svg += `<rect x="${x}" y="${curY}" width="${barWidth}" height="${h5xx}" fill="#ef4444" rx="2">
          <title>${b.label}: ${b.count5xx} server errors (5xx)</title>
        </rect>`;
      }

      // X Axis label (render alternate to prevent overlap if many)
      if (buckets.length <= 8 || idx % 2 === 0) {
        svg += `<text x="${x + barWidth / 2}" y="${h - 12}" fill="#64748b" font-size="9" text-anchor="middle">${escapeHtml(b.label)}</text>`;
      }
    });

    svg += '</svg>';
    el.chartTimeline.innerHTML = svg;
  }

  // Chart 2: AI Model Distribution Donut & Legend
  function renderModelsChart(records) {
    if (!el.chartModels) return;
    if (records.length === 0) {
      el.chartModels.innerHTML = '<div class="empty-state">No AI model calls recorded.</div>';
      return;
    }

    const modelMap = {};
    records.forEach(r => {
      const ai = r.ai || {};
      const m = ai.model || ai['ai.model'] || 'Other / None';
      modelMap[m] = (modelMap[m] || 0) + 1;
    });

    const entries = Object.entries(modelMap).sort((a, b) => b[1] - a[1]);
    const total = records.length;

    const colors = ['#a855f7', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#6366f1'];

    // Donut SVG using circle stroke-dasharray
    const size = 180;
    const strokeWidth = 24;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    let accumulatedOffset = 0;

    let circlesSvg = '';
    entries.forEach(([model, count], idx) => {
      const fraction = count / total;
      const strokeLength = fraction * circumference;
      const color = colors[idx % colors.length];

      circlesSvg += `
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="transparent"
          stroke="${color}" stroke-width="${strokeWidth}"
          stroke-dasharray="${strokeLength} ${circumference - strokeLength}"
          stroke-dashoffset="${-accumulatedOffset}"
          style="transition: stroke-width 0.15s ease;"
          transform="rotate(-90 ${size / 2} ${size / 2})">
          <title>${escapeHtml(model)}: ${count} calls (${((count / total) * 100).toFixed(1)}%)</title>
        </circle>
      `;
      accumulatedOffset += strokeLength;
    });

    // Build legend
    const legendHtml = entries.map(([model, count], idx) => {
      const color = colors[idx % colors.length];
      const pct = ((count / total) * 100).toFixed(0);
      return `
        <div class="legend-item" style="cursor: pointer; padding: 0.2rem 0.4rem; border-radius: 4px;"
          onclick="window.__filterByModel && window.__filterByModel('${escapeHtml(model)}')"
          title="Click to filter by ${escapeHtml(model)}">
          <span class="legend-color" style="background-color: ${color};"></span>
          <span style="font-family: var(--font-mono); font-size: 0.75rem; color: #f1f5f9;">${escapeHtml(model)}</span>
          <span style="color: var(--text-muted); font-size: 0.725rem;">${count} (${pct}%)</span>
        </div>
      `;
    }).join('');

    el.chartModels.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-around; width: 100%; gap: 1rem; flex-wrap: wrap;">
        <div style="position: relative; width: ${size}px; height: ${size}px; flex-shrink: 0;">
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
            ${circlesSvg}
          </svg>
          <div style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none;">
            <span style="font-size: 1.25rem; font-weight: 700; color: #f8fafc; font-family: var(--font-mono);">${total}</span>
            <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--text-secondary); letter-spacing: 0.05em;">Calls</span>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.35rem; max-width: 280px; flex: 1;">
          ${legendHtml}
        </div>
      </div>
    `;

    window.__filterByModel = (model) => {
      if (el.analyticsFilterModel) {
        el.analyticsFilterModel.value = model;
        analyticsState.filters.model = model;
        applyAnalyticsFilters();
      }
    };
  }

  // Chart 3: Token Usage by Model (Prompt vs Completion Stacked Bars)
  function renderTokensChart(records) {
    if (!el.chartTokens) return;
    if (records.length === 0) {
      el.chartTokens.innerHTML = '<div class="empty-state">No token usage data found.</div>';
      return;
    }

    const modelTokens = {};
    records.forEach(r => {
      const ai = r.ai || {};
      const m = ai.model || ai['ai.model'] || 'Other';
      const pt = parseInt(ai.promptTokens || ai['ai.promptTokenCount'] || 0, 10) || 0;
      const ct = parseInt(ai.completionTokens || ai['ai.candidatesTokenCount'] || 0, 10) || 0;
      if (!modelTokens[m]) modelTokens[m] = { prompt: 0, comp: 0, total: 0 };
      modelTokens[m].prompt += pt;
      modelTokens[m].comp += ct;
      modelTokens[m].total += (pt + ct);
    });

    const entries = Object.entries(modelTokens)
      .filter(([_, t]) => t.total > 0)
      .sort((a, b) => b[1].total - a[1].total);

    if (entries.length === 0) {
      el.chartTokens.innerHTML = '<div class="empty-state">No token metrics present in selected records.</div>';
      return;
    }

    let maxTokens = 1;
    entries.forEach(([_, t]) => {
      if (t.total > maxTokens) maxTokens = t.total;
    });

    const rowsHtml = entries.slice(0, 5).map(([model, t]) => {
      const promptPct = ((t.prompt / maxTokens) * 100).toFixed(1);
      const compPct = ((t.comp / maxTokens) * 100).toFixed(1);

      return `
        <div style="margin-bottom: 0.85rem;">
          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.3rem;">
            <span style="font-family: var(--font-mono); font-size: 0.775rem; font-weight: 600; color: #f1f5f9;">${escapeHtml(model)}</span>
            <span style="font-size: 0.725rem; color: var(--text-muted);">
              <strong style="color: #6366f1;">${t.prompt.toLocaleString()}p</strong> +
              <strong style="color: #ec4899;">${t.comp.toLocaleString()}c</strong> =
              <strong style="color: #f8fafc;">${t.total.toLocaleString()}</strong>
            </span>
          </div>
          <div style="height: 12px; background-color: var(--bg-tertiary); border-radius: 4px; overflow: hidden; display: flex;">
            <div style="width: ${promptPct}%; background-color: #6366f1; transition: width 0.3s ease;" title="Prompt: ${t.prompt.toLocaleString()} tokens"></div>
            <div style="width: ${compPct}%; background-color: #ec4899; transition: width 0.3s ease;" title="Completion: ${t.comp.toLocaleString()} tokens"></div>
          </div>
        </div>
      `;
    }).join('');

    el.chartTokens.innerHTML = `<div style="width: 100%; padding: 0.5rem 0;">${rowsHtml}</div>`;
  }

  // Chart 4: Latency Performance Distribution
  function renderLatencyChart(records) {
    if (!el.chartLatency) return;
    if (records.length === 0) {
      el.chartLatency.innerHTML = '<div class="empty-state">No response time data.</div>';
      return;
    }

    const tiers = [
      { label: '<50ms', min: 0, max: 50, count: 0 },
      { label: '50-100ms', min: 50, max: 100, count: 0 },
      { label: '100-250ms', min: 100, max: 250, count: 0 },
      { label: '250-500ms', min: 250, max: 500, count: 0 },
      { label: '>500ms', min: 500, max: 999999, count: 0 },
    ];

    let totalDur = 0;
    records.forEach(r => {
      const d = parseInt(r.durationMs || 0, 10);
      totalDur += d;
      for (const t of tiers) {
        if (d >= t.min && d < t.max) {
          t.count++;
          break;
        }
      }
    });

    let maxTierCount = 1;
    tiers.forEach(t => {
      if (t.count > maxTierCount) maxTierCount = t.count;
    });

    const avg = Math.round(totalDur / records.length);
    const tierColors = ['#10b981', '#3b82f6', '#6366f1', '#f59e0b', '#ef4444'];

    const barsHtml = tiers.map((t, i) => {
      const heightPct = Math.max(4, Math.round((t.count / maxTierCount) * 100));
      const color = tierColors[i];
      return `
        <div style="display: flex; flex-direction: column; align-items: center; flex: 1; height: 160px; justify-content: flex-end;">
          <span style="font-size: 0.725rem; font-weight: 600; color: #f8fafc; margin-bottom: 0.35rem;">${t.count}</span>
          <div style="width: 70%; max-width: 44px; height: ${heightPct}%; background-color: ${color}; border-radius: 4px 4px 0 0; transition: height 0.3s ease;" title="${t.label}: ${t.count} requests"></div>
          <span style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.4rem; white-space: nowrap;">${t.label}</span>
        </div>
      `;
    }).join('');

    el.chartLatency.innerHTML = `
      <div style="width: 100%;">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; height: 160px; border-bottom: 1px solid var(--border-color); padding-bottom: 0.25rem;">
          ${barsHtml}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.65rem; font-size: 0.75rem; color: var(--text-secondary);">
          <span>Average Roundtrip: <strong style="color: #38bdf8;">${avg} ms</strong></span>
          <span>Total Sampled: <strong style="color: #f1f5f9;">${records.length}</strong></span>
        </div>
      </div>
    `;
  }

  // Render Analytics Data Table with Pagination
  function renderAnalyticsTable() {
    if (!el.analyticsTableBody) return;
    const records = analyticsState.filteredRecords;
    const total = records.length;
    const pageSize = analyticsState.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    if (analyticsState.currentPage > totalPages) analyticsState.currentPage = totalPages;
    const startIdx = (analyticsState.currentPage - 1) * pageSize;
    const pageRecords = records.slice(startIdx, startIdx + pageSize);

    if (el.analyticsPageText) {
      el.analyticsPageText.textContent = `Page ${analyticsState.currentPage} of ${totalPages}`;
    }
    if (el.btnPagePrev) el.btnPagePrev.disabled = analyticsState.currentPage <= 1;
    if (el.btnPageNext) el.btnPageNext.disabled = analyticsState.currentPage >= totalPages;
    if (el.analyticsFilterCounter) {
      el.analyticsFilterCounter.textContent = `Showing ${pageRecords.length} of ${total} records (from ${analyticsState.records.length} total)`;
    }

    if (pageRecords.length === 0) {
      el.analyticsTableBody.innerHTML = `<tr><td colspan="8" class="empty-state">No matching analytics records found.</td></tr>`;
      return;
    }

    let maxDuration = 1;
    pageRecords.forEach(r => {
      const d = parseInt(r.durationMs || 0, 10);
      if (d > maxDuration) maxDuration = d;
    });

    const rowsHtml = pageRecords.map(r => {
      const sc = r.statusCode || 200;
      const statusClass = (sc >= 200 && sc < 300) ? 'status-2xx' : (sc >= 400 && sc < 500) ? 'status-4xx' : 'status-5xx';
      const ai = r.ai || {};
      const model = ai.model || ai['ai.model'] || '-';
      const provider = (ai.provider || ai['ai.provider'] || '').toLowerCase();
      const badgeClass = provider === 'anthropic' ? 'badge-anthropic' : provider === 'google' ? 'badge-google' : provider === 'openai' ? 'badge-openai' : 'badge-generic';

      const pt = parseInt(ai.promptTokens || ai['ai.promptTokenCount'] || 0, 10);
      const ct = parseInt(ai.completionTokens || ai['ai.candidatesTokenCount'] || 0, 10);
      const tt = parseInt(ai.totalTokens || ai['ai.totalTokenCount'] || (pt + ct), 10);

      const dur = parseInt(r.durationMs || 0, 10);
      const barPct = Math.min(100, Math.round((dur / maxDuration) * 100));
      const timeStr = formatAnalyticsTimestamp(r.timestamp || r.createTime);
      const id = r.id || '';

      return `
        <tr class="clickable-row" data-id="${escapeHtml(id)}">
          <td><span class="code-snippet" style="font-size: 0.725rem;">${escapeHtml(timeStr)}</span></td>
          <td><strong>${escapeHtml(r.proxy || '-')}</strong></td>
          <td>
            <span class="tag tag-sm" style="font-weight: 700; margin-right: 0.25rem;">${escapeHtml(r.method || 'POST')}</span>
            <span class="code-snippet" style="font-size: 0.75rem;">${escapeHtml(r.path || '/')}</span>
          </td>
          <td>
            ${model !== '-' ? `<span class="badge-model ${badgeClass}">${escapeHtml(model)}</span>` : '<span style="color: var(--text-muted);">-</span>'}
            ${provider ? `<span class="tag tag-dim" style="margin-left: 0.25rem;">${escapeHtml(provider)}</span>` : ''}
          </td>
          <td>
            <div class="token-cell">
              <span class="token-total">${tt > 0 ? tt.toLocaleString() : '-'}</span>
              ${(pt > 0 || ct > 0) ? `<span class="token-breakdown">${pt.toLocaleString()}p / ${ct.toLocaleString()}c</span>` : ''}
            </div>
          </td>
          <td><span class="status-tag ${statusClass}">${sc}</span></td>
          <td>
            <div class="duration-cell">
              <span class="duration-value">${dur}ms</span>
              <div class="duration-bar-wrap">
                <div class="duration-bar" style="width: ${barPct}%;"></div>
              </div>
            </div>
          </td>
          <td>
            <button class="btn btn-sm btn-outline btn-inspect-record" data-id="${escapeHtml(id)}" title="Inspect all record fields">
              Inspect
            </button>
          </td>
        </tr>
      `;
    }).join('');

    el.analyticsTableBody.innerHTML = rowsHtml;

    // Attach click listeners to rows and inspect buttons
    el.analyticsTableBody.querySelectorAll('.clickable-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const id = tr.getAttribute('data-id');
        openRecordDrawer(id);
      });
    });
  }

  // Open Detailed Record Drawer / Modal
  function openRecordDrawer(id) {
    const record = analyticsState.records.find(r => r.id === id);
    if (!record) return;
    analyticsState.selectedRecord = record;

    if (el.drawerRecordId) {
      el.drawerRecordId.textContent = id || record.documentName || 'Analytics Record';
    }

    // 1. AI Variables Tab
    const ai = record.ai || {};
    const aiEntries = Object.entries(ai);
    let aiHtml = '';
    if (aiEntries.length === 0) {
      aiHtml = '<div class="empty-state">No AI variables extracted for this invocation.</div>';
    } else {
      const pt = parseInt(ai.promptTokens || ai['ai.promptTokenCount'] || 0, 10);
      const ct = parseInt(ai.completionTokens || ai['ai.candidatesTokenCount'] || 0, 10);
      const tt = parseInt(ai.totalTokens || ai['ai.totalTokenCount'] || (pt + ct), 10);

      aiHtml = `
        <div class="drawer-grid">
          <div class="drawer-card">
            <div class="drawer-card-label">AI Model</div>
            <div class="drawer-card-value">${escapeHtml(ai.model || ai['ai.model'] || 'Unknown')}</div>
          </div>
          <div class="drawer-card">
            <div class="drawer-card-label">AI Provider</div>
            <div class="drawer-card-value">${escapeHtml(ai.provider || ai['ai.provider'] || 'Unknown')}</div>
          </div>
          <div class="drawer-card">
            <div class="drawer-card-label">Target Route</div>
            <div class="drawer-card-value">${escapeHtml(ai.targetRoute || ai['ai.targetRoute'] || '-')}</div>
          </div>
          <div class="drawer-card">
            <div class="drawer-card-label">Total Tokens</div>
            <div class="drawer-card-value">${tt > 0 ? tt.toLocaleString() : '-'}</div>
          </div>
          <div class="drawer-card">
            <div class="drawer-card-label">Prompt Tokens</div>
            <div class="drawer-card-value">${pt > 0 ? pt.toLocaleString() : '-'}</div>
          </div>
          <div class="drawer-card">
            <div class="drawer-card-label">Completion Tokens</div>
            <div class="drawer-card-value">${ct > 0 ? ct.toLocaleString() : '-'}</div>
          </div>
        </div>
        <div class="drawer-section-title">All "ai.*" Trace Variables</div>
        <div class="step-props-table">
      `;
      for (const [k, v] of Object.entries(ai)) {
        if (k.startsWith('ai.')) {
          aiHtml += `
            <div class="step-prop-row">
              <span class="step-prop-name">${escapeHtml(k)}</span>
              <span class="step-prop-value">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>
            </div>
          `;
        }
      }
      aiHtml += '</div>';
    }
    if (el.drawerAiContent) el.drawerAiContent.innerHTML = aiHtml;

    // 2. Call Metadata Tab
    const genHtml = `
      <div class="drawer-grid">
        <div class="drawer-card">
          <div class="drawer-card-label">Proxy</div>
          <div class="drawer-card-value">${escapeHtml(record.proxy || '-')}</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">HTTP Method</div>
          <div class="drawer-card-value">${escapeHtml(record.method || 'POST')}</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">Status Code</div>
          <div class="drawer-card-value">${escapeHtml(String(record.statusCode || 200))} ${escapeHtml(record.statusText || '')}</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">Duration</div>
          <div class="drawer-card-value">${escapeHtml(String(record.durationMs || 0))} ms</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">Target Latency</div>
          <div class="drawer-card-value">${escapeHtml(String(record.targetLatencyMs || 0))} ms</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">Client IP</div>
          <div class="drawer-card-value">${escapeHtml(record.clientIp || '-')}</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">Environment</div>
          <div class="drawer-card-value">${escapeHtml(record.environment || '-')}</div>
        </div>
        <div class="drawer-card">
          <div class="drawer-card-label">Timestamp</div>
          <div class="drawer-card-value">${escapeHtml(record.timestamp || '-')}</div>
        </div>
      </div>
      <div class="drawer-section-title">Execution Context</div>
      <div class="step-props-table">
        <div class="step-prop-row">
          <span class="step-prop-name">Target URL</span>
          <span class="step-prop-value">${escapeHtml(record.targetUrl || '-')}</span>
        </div>
        <div class="step-prop-row">
          <span class="step-prop-name">Request Path</span>
          <span class="step-prop-value">${escapeHtml(record.path || '-')}</span>
        </div>
        <div class="step-prop-row">
          <span class="step-prop-name">Trace Session ID</span>
          <span class="step-prop-value">${escapeHtml(record.traceSessionId || '-')}</span>
        </div>
        <div class="step-prop-row">
          <span class="step-prop-name">Is Error</span>
          <span class="step-prop-value">${record.isError ? 'true' : 'false'}</span>
        </div>
      </div>
    `;
    if (el.drawerGeneralContent) el.drawerGeneralContent.innerHTML = genHtml;

    // 3. Raw JSON Tab
    if (el.drawerRawJson) {
      el.drawerRawJson.textContent = JSON.stringify(record, null, 2);
    }

    if (el.analyticsRecordDrawer) {
      el.analyticsRecordDrawer.classList.remove('hidden');
    }
  }

  function closeRecordDrawer() {
    if (el.analyticsRecordDrawer) {
      el.analyticsRecordDrawer.classList.add('hidden');
    }
    analyticsState.selectedRecord = null;
  }

  // Seed sample demo records
  async function seedDemoAnalytics() {
    if (el.btnSeedAnalytics) {
      el.btnSeedAnalytics.disabled = true;
      el.btnSeedAnalytics.textContent = 'Seeding...';
    }
    try {
      const resp = await fetch(`${API_BASE}/analytics/seed`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to seed');
      showToast(data.message || `Seeded ${data.count} demo analytics records!`);
      await fetchAnalyticsData();
    } catch (err) {
      alert('Error seeding demo analytics: ' + err.message);
    } finally {
      if (el.btnSeedAnalytics) {
        el.btnSeedAnalytics.disabled = false;
        el.btnSeedAnalytics.innerHTML = `
          <svg class="btn-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          Seed Demo Data
        `;
      }
    }
  }

  // Export records to CSV
  function exportAnalyticsCsv() {
    const records = analyticsState.filteredRecords;
    if (records.length === 0) {
      alert('No analytics records to export.');
      return;
    }

    const headers = ['ID', 'Timestamp', 'Proxy', 'Method', 'Path', 'StatusCode', 'DurationMs', 'TargetLatencyMs', 'AIModel', 'AIProvider', 'TotalTokens', 'PromptTokens', 'CompTokens', 'ClientIP'];
    const rows = records.map(r => {
      const ai = r.ai || {};
      const pt = ai.promptTokens || ai['ai.promptTokenCount'] || 0;
      const ct = ai.completionTokens || ai['ai.candidatesTokenCount'] || 0;
      const tt = ai.totalTokens || ai['ai.totalTokenCount'] || (pt + ct);

      return [
        r.id || '',
        r.timestamp || '',
        r.proxy || '',
        r.method || '',
        r.path || '',
        r.statusCode || 200,
        r.durationMs || 0,
        r.targetLatencyMs || 0,
        ai.model || ai['ai.model'] || '',
        ai.provider || ai['ai.provider'] || '',
        tt,
        pt,
        ct,
        r.clientIp || '',
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apigee_analytics_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Export records to JSON
  function exportAnalyticsJson() {
    const records = analyticsState.filteredRecords;
    if (records.length === 0) {
      alert('No analytics records to export.');
      return;
    }

    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apigee_analytics_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Setup analytics event listeners
  function setupAnalyticsEventListeners() {
    // Refresh button
    if (el.btnRefreshAnalytics) {
      el.btnRefreshAnalytics.addEventListener('click', fetchAnalyticsData);
    }

    // Seed Demo Data button
    if (el.btnSeedAnalytics) {
      el.btnSeedAnalytics.addEventListener('click', seedDemoAnalytics);
    }

    // Export buttons
    if (el.btnExportCsv) {
      el.btnExportCsv.addEventListener('click', exportAnalyticsCsv);
    }
    if (el.btnExportJson) {
      el.btnExportJson.addEventListener('click', exportAnalyticsJson);
    }

    // Auto-refresh checkbox
    if (el.chkAnalyticsAutorefresh) {
      el.chkAnalyticsAutorefresh.addEventListener('change', () => {
        if (el.chkAnalyticsAutorefresh.checked) {
          analyticsState.autoRefreshInterval = setInterval(() => {
            if (!document.hidden && el.viewAnalytics && !el.viewAnalytics.classList.contains('hidden')) {
              fetchAnalyticsData();
            }
          }, 15000);
        } else {
          clearInterval(analyticsState.autoRefreshInterval);
          analyticsState.autoRefreshInterval = null;
        }
      });
    }

    // Search input
    if (el.analyticsSearch) {
      el.analyticsSearch.addEventListener('input', () => {
        analyticsState.filters.search = el.analyticsSearch.value;
        analyticsState.currentPage = 1;
        applyAnalyticsFilters();
      });
    }

    // Filter dropdowns
    if (el.analyticsFilterProxy) {
      el.analyticsFilterProxy.addEventListener('change', () => {
        analyticsState.filters.proxy = el.analyticsFilterProxy.value;
        analyticsState.currentPage = 1;
        applyAnalyticsFilters();
      });
    }
    if (el.analyticsFilterModel) {
      el.analyticsFilterModel.addEventListener('change', () => {
        analyticsState.filters.model = el.analyticsFilterModel.value;
        analyticsState.currentPage = 1;
        applyAnalyticsFilters();
      });
    }
    if (el.analyticsFilterProvider) {
      el.analyticsFilterProvider.addEventListener('change', () => {
        analyticsState.filters.provider = el.analyticsFilterProvider.value;
        analyticsState.currentPage = 1;
        applyAnalyticsFilters();
      });
    }
    if (el.analyticsFilterStatus) {
      el.analyticsFilterStatus.addEventListener('change', () => {
        analyticsState.filters.status = el.analyticsFilterStatus.value;
        analyticsState.currentPage = 1;
        applyAnalyticsFilters();
      });
    }

    // Reset filters
    if (el.btnResetFilters) {
      el.btnResetFilters.addEventListener('click', () => {
        analyticsState.filters = { search: '', proxy: '', model: '', provider: '', status: '' };
        if (el.analyticsSearch) el.analyticsSearch.value = '';
        if (el.analyticsFilterProxy) el.analyticsFilterProxy.value = '';
        if (el.analyticsFilterModel) el.analyticsFilterModel.value = '';
        if (el.analyticsFilterProvider) el.analyticsFilterProvider.value = '';
        if (el.analyticsFilterStatus) el.analyticsFilterStatus.value = '';
        analyticsState.currentPage = 1;
        applyAnalyticsFilters();
      });
    }

    // Sortable table headers
    document.querySelectorAll('.analytics-table th.sortable-th').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (analyticsState.sortField === field) {
          analyticsState.sortAsc = !analyticsState.sortAsc;
        } else {
          analyticsState.sortField = field;
          analyticsState.sortAsc = false;
        }

        // Update header classes and arrows
        document.querySelectorAll('.analytics-table th.sortable-th').forEach(h => {
          h.classList.remove('active-sort', 'asc', 'desc');
          const icon = h.querySelector('.sort-icon');
          if (icon) icon.innerHTML = '';
        });

        th.classList.add('active-sort', analyticsState.sortAsc ? 'asc' : 'desc');
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.innerHTML = analyticsState.sortAsc ? '&uarr;' : '&darr;';

        sortAnalyticsRecords();
        renderAnalyticsTable();
      });
    });

    // Pagination controls
    if (el.analyticsPageSize) {
      el.analyticsPageSize.addEventListener('change', () => {
        analyticsState.pageSize = parseInt(el.analyticsPageSize.value, 10) || 50;
        analyticsState.currentPage = 1;
        renderAnalyticsTable();
      });
    }
    if (el.btnPagePrev) {
      el.btnPagePrev.addEventListener('click', () => {
        if (analyticsState.currentPage > 1) {
          analyticsState.currentPage--;
          renderAnalyticsTable();
        }
      });
    }
    if (el.btnPageNext) {
      el.btnPageNext.addEventListener('click', () => {
        const totalPages = Math.ceil(analyticsState.filteredRecords.length / analyticsState.pageSize);
        if (analyticsState.currentPage < totalPages) {
          analyticsState.currentPage++;
          renderAnalyticsTable();
        }
      });
    }

    // Drawer tabs & closing
    if (el.btnCloseAnalyticsDrawer) {
      el.btnCloseAnalyticsDrawer.addEventListener('click', closeRecordDrawer);
    }
    if (el.analyticsDrawerBackdrop) {
      el.analyticsDrawerBackdrop.addEventListener('click', closeRecordDrawer);
    }

    document.querySelectorAll('.drawer-tabs .drawer-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.drawer-tabs .drawer-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const targetTab = btn.getAttribute('data-tab');
        document.querySelectorAll('.drawer-body .drawer-tab-content').forEach(c => c.classList.remove('active'));
        const content = document.getElementById(targetTab);
        if (content) content.classList.add('active');
      });
    });

    if (el.btnCopyDrawerJson) {
      el.btnCopyDrawerJson.addEventListener('click', () => {
        if (el.drawerRawJson) {
          navigator.clipboard.writeText(el.drawerRawJson.textContent);
          showToast('Record JSON copied to clipboard');
        }
      });
    }
  }

  function formatAnalyticsTimestamp(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' +
             d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (e) {
      return isoStr;
    }
  }

  function formatTimelineLabel(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  // Start app
  init();
})();
