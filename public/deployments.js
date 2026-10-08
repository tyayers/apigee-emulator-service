/**
 * Apigee Emulator - Deployments Hub Dashboard Logic
 */

(function () {
  'use strict';

  // Application State
  const state = {
    deployments: [],
    activeProxiesSet: new Set(),
    isDeploying: false,
    filterStatus: 'all',
    searchQuery: '',
    selectedFile: null,
    runningTests: new Set(),
    activeModalYaml: ''
  };

  // DOM Elements
  const el = {
    // Header
    emulatorStatusBadge: document.getElementById('emulator-status-badge'),
    emulatorStatusText: document.getElementById('emulator-status-text'),
    btnDeployAllHeader: document.getElementById('btn-deploy-all-header'),
    btnThemeToggle: document.getElementById('btn-theme-toggle'),
    themeIconSun: document.getElementById('theme-icon-sun'),
    themeIconMoon: document.getElementById('theme-icon-moon'),
    navBtnOpenTester: document.getElementById('nav-btn-open-tester'),
    navBtnOpenLabs: document.getElementById('nav-btn-open-labs'),

    // Hero / Actions
    btnToggleLoadPanel: document.getElementById('btn-toggle-load-panel'),
    btnRunAllTestsGlobal: document.getElementById('btn-run-all-tests-global'),

    // Stats
    statTotalDeployments: document.getElementById('stat-total-deployments'),
    statActiveProxies: document.getElementById('stat-active-proxies'),
    statTotalTests: document.getElementById('stat-total-tests'),
    statTotalRequests: document.getElementById('stat-total-requests'),

    // Load Modal
    modalLoadDeployment: document.getElementById('modal-load-deployment'),
    btnCloseLoadModal: document.getElementById('btn-close-load-modal'),
    loadTabBtns: document.querySelectorAll('.load-tab-btn'),
    loadTabContents: document.querySelectorAll('.load-tab-content'),
    inputDeploymentUrl: document.getElementById('input-deployment-url'),
    btnLoadUrl: document.getElementById('btn-load-url'),
    sampleUrlChips: document.querySelectorAll('.sample-url-chip'),
    uploadDropzone: document.getElementById('upload-dropzone'),
    fileUploadInput: document.getElementById('file-upload-input'),
    uploadFileInfo: document.getElementById('upload-file-info'),
    uploadFileName: document.getElementById('upload-file-name'),
    btnSubmitUpload: document.getElementById('btn-submit-upload'),
    inputPasteFilename: document.getElementById('input-paste-filename'),
    textareaPasteYaml: document.getElementById('textarea-paste-yaml'),
    btnLoadPasted: document.getElementById('btn-load-pasted'),
    chkAutoDeployLoaded: document.getElementById('chk-auto-deploy-loaded'),
    loadStatusAlert: document.getElementById('load-status-alert'),

    // Grid & Filters
    badgeDeploymentCount: document.getElementById('badge-deployment-count'),
    inputSearchDeployments: document.getElementById('input-search-deployments'),
    filterDeployStatus: document.getElementById('filter-deploy-status'),
    deploymentsGrid: document.getElementById('deployments-grid'),

    // Analytics
    analyticsTotalCalls: document.getElementById('analytics-total-calls'),
    analyticsSuccessRate: document.getElementById('analytics-success-rate'),
    analyticsAvgLatency: document.getElementById('analytics-avg-latency'),
    analyticsTotalTokens: document.getElementById('analytics-total-tokens'),
    recentRequestsTbody: document.getElementById('recent-requests-tbody'),

    // YAML Modal
    modalYamlViewer: document.getElementById('modal-yaml-viewer'),
    modalYamlTitle: document.getElementById('modal-yaml-title'),
    modalYamlContent: document.getElementById('modal-yaml-content'),
    btnCopyModalYaml: document.getElementById('btn-copy-modal-yaml'),
    btnCloseModalYaml: document.getElementById('btn-close-modal-yaml'),

    // Toast Container
    toastContainer: document.getElementById('toast-container')
  };

  // -------------------------------------------------------------
  // Theme Toggle Support
  // -------------------------------------------------------------
  function initTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    updateThemeIcons(currentTheme);

    if (el.btnThemeToggle) {
      el.btnThemeToggle.addEventListener('click', () => {
        const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', nextTheme);
        localStorage.setItem('theme', nextTheme);
        updateThemeIcons(nextTheme);
      });
    }
  }

  function updateThemeIcons(theme) {
    if (theme === 'dark') {
      el.themeIconSun?.classList.remove('hidden');
      el.themeIconMoon?.classList.add('hidden');
    } else {
      el.themeIconSun?.classList.add('hidden');
      el.themeIconMoon?.classList.remove('hidden');
    }
  }

  // -------------------------------------------------------------
  // Toast Helper
  // -------------------------------------------------------------
  function showToast(message, type = 'info', duration = 3500) {
    if (!el.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-left: 4px solid ${type === 'success' ? 'var(--accent-green)' : type === 'error' ? 'var(--accent-red)' : 'var(--accent-primary)'};
      padding: 10px 16px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      margin-bottom: 8px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
      animation: fadeIn 0.2s ease;
    `;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // -------------------------------------------------------------
  // Check Health & Status
  // -------------------------------------------------------------
  async function checkEmulatorStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('Status endpoint returned ' + res.status);
      const data = await res.json();
      const healthy = (data.online === true) || (data.healthy === true) || (data.status === 'ready' || data.status === 'ok') || (Array.isArray(data.activeProxies) && data.activeProxies.length > 0);

      const wasDeploying = state.isDeploying;
      state.isDeploying = Boolean(data.isDeploying);

      if (Array.isArray(data.activeProxies)) {
        state.activeProxiesSet = new Set(data.activeProxies.map((p) => (typeof p === 'string' ? p.toLowerCase() : (p.name || '').toLowerCase())));
      }

      if (el.emulatorStatusBadge && el.emulatorStatusText) {
        if (data.isDeploying) {
          el.emulatorStatusBadge.className = 'status-badge status-deploying';
          el.emulatorStatusText.textContent = data.deployMessage || 'Emulator proxies deploying...';
        } else if (healthy) {
          const count = data.activeProxies?.length || state.activeProxiesSet.size || 0;
          el.emulatorStatusBadge.className = 'status-badge status-healthy';
          el.emulatorStatusText.textContent = `Emulator Ready (${count} proxies)`;
        } else {
          el.emulatorStatusBadge.className = 'status-badge status-degraded';
          el.emulatorStatusText.textContent = 'Emulator Starting...';
        }
      }

      // If deployment just transitioned from in-progress to finished, refresh the grid
      if (wasDeploying && !state.isDeploying) {
        await fetchDeployments();
      }
    } catch (err) {
      if (el.emulatorStatusBadge && el.emulatorStatusText) {
        el.emulatorStatusBadge.className = 'status-badge status-unhealthy';
        el.emulatorStatusText.textContent = 'Emulator Disconnected';
      }
    }
  }

  // -------------------------------------------------------------
  // Fetch Deployments
  // -------------------------------------------------------------
  async function fetchDeployments() {
    try {
      const res = await fetch('/api/deployments');
      if (!res.ok) throw new Error('Failed to fetch deployments: HTTP ' + res.status);
      state.deployments = await res.json();

      updateKpis();
      updateNavigationLinks();
      renderDeploymentsGrid();
    } catch (err) {
      console.error('Error fetching deployments:', err);
      if (el.deploymentsGrid) {
        el.deploymentsGrid.innerHTML = `
          <div class="empty-state-card">
            <h4 style="color:var(--accent-red)">Failed to load deployments</h4>
            <p>${escapeHtml(err.message)}</p>
            <button class="btn btn-outline btn-sm" onclick="location.reload()">Retry</button>
          </div>
        `;
      }
    }
  }

  function updateKpis() {
    const totalDeployments = state.deployments.length;
    let totalTests = 0;
    const activeProxiesSet = new Set();

    state.deployments.forEach((d) => {
      const testsCount = d.tests ? d.tests.length : (d.testsCount || 0);
      totalTests += testsCount;
      (d.proxies || []).forEach((p) => {
        const proxyName = typeof p === 'string' ? p : (p.name || '');
        if (proxyName && (state.activeProxiesSet.has(proxyName.toLowerCase()) || d.deployed)) {
          activeProxiesSet.add(proxyName.toLowerCase());
        }
      });
    });

    const activeCount = Math.max(state.activeProxiesSet.size, activeProxiesSet.size);

    if (el.statTotalDeployments) el.statTotalDeployments.textContent = totalDeployments;
    if (el.statActiveProxies) el.statActiveProxies.textContent = activeCount;
    if (el.statTotalTests) el.statTotalTests.textContent = totalTests;
    if (el.badgeDeploymentCount) el.badgeDeploymentCount.textContent = totalDeployments;
  }

  function updateNavigationLinks() {
    // Pick the most relevant deployment (last deployed or first) to pre-seed Tester & Labs links
    let targetDeploymentId = '';
    if (state.deployments.length > 0) {
      const last = state.deployments[state.deployments.length - 1];
      targetDeploymentId = last.id;
    }

    if (targetDeploymentId) {
      if (el.navBtnOpenTester) el.navBtnOpenTester.href = `/tester/?deployment=${encodeURIComponent(targetDeploymentId)}`;
      if (el.navBtnOpenLabs) el.navBtnOpenLabs.href = `/labs/?deployment=${encodeURIComponent(targetDeploymentId)}`;
    }
  }

  // -------------------------------------------------------------
  // Render Deployments Grid
  // -------------------------------------------------------------
  function renderDeploymentsGrid() {
    if (!el.deploymentsGrid) return;

    let filtered = state.deployments.filter((d) => {
      // Status filter
      if (state.filterStatus === 'deployed' && !d.deployed) return false;
      if (state.filterStatus === 'not-deployed' && d.deployed) return false;

      // Search query
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        const matchesName = (d.displayName || d.id || '').toLowerCase().includes(q);
        const matchesProxy = (d.proxies || []).some((p) => (p.name || '').toLowerCase().includes(q));
        const matchesSource = (d.sourceUrl || d.sourceType || '').toLowerCase().includes(q);
        if (!matchesName && !matchesProxy && !matchesSource) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      el.deploymentsGrid.innerHTML = `
        <div class="empty-state-card">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
          <h4>No Deployments Found</h4>
          <p>${state.deployments.length === 0 ? 'No deployments loaded yet. Load one from a URL, YAML file, or pasted text above.' : 'No deployments match your current search or status filter.'}</p>
        </div>
      `;
      return;
    }

    el.deploymentsGrid.innerHTML = filtered.map((d) => buildDeploymentCardHtml(d)).join('');
    attachCardListeners();
  }

  function buildDeploymentCardHtml(d) {
    const isDeployed = d.deployed;
    const isRunning = state.runningTests.has(d.id);

    // Source display
    let sourceLabel = d.sourceType || 'Local';
    let sourceDesc = '';
    if (d.sourceType === 'url' && d.sourceUrl) {
      sourceLabel = 'Remote URL';
      sourceDesc = d.sourceUrl;
    } else if (d.sourceType === 'file' || d.sourceType === 'upload') {
      sourceLabel = 'File';
      sourceDesc = d.filePath || d.id;
    } else {
      sourceDesc = d.id + '.yaml';
    }

    // Proxies list chips
    const proxyChips = (d.proxies || []).map((p) => {
      const proxyName = typeof p === 'string' ? p : (p.name || 'Proxy');
      const isProxyDeployed = typeof p === 'object' && p.isDeployed !== undefined
        ? p.isDeployed
        : (state.activeProxiesSet.has(proxyName.toLowerCase()) || d.deployed);
      const activeClass = isProxyDeployed ? '' : 'offline';
      const statusTitle = isProxyDeployed ? `${proxyName} - Active in Emulator Runtime` : `${proxyName} - Offline / Not Deployed`;
      return `
        <span class="proxy-chip ${activeClass}" title="${escapeHtml(statusTitle)}">
          <span class="proxy-dot"></span>
          ${escapeHtml(proxyName)}
        </span>
      `;
    }).join('') || '<span class="text-muted" style="font-size:11px;">No proxies defined</span>';

    // Last test run stats
    let lastTestRunHtml = '';
    if (d.lastTestRun) {
      const passRate = d.lastTestRun.total > 0 ? Math.round((d.lastTestRun.passed / d.lastTestRun.total) * 100) : 0;
      const allPassed = d.lastTestRun.passed === d.lastTestRun.total && d.lastTestRun.total > 0;
      const timeStr = formatRelativeTime(d.lastTestRun.timestamp);

      lastTestRunHtml = `
        <div class="test-summary-box">
          <div class="test-summary-left">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>Tests:</span>
            <span class="${allPassed ? 'test-pass-badge' : 'test-fail-badge'}">
              ${d.lastTestRun.passed}/${d.lastTestRun.total} passed (${passRate}%)
            </span>
          </div>
          <span class="text-muted" style="font-size:10px;">${timeStr} (${d.lastTestRun.durationMs || 0}ms)</span>
        </div>
      `;
    }

    const testsCount = d.tests ? d.tests.length : (d.testsCount || 0);

    return `
      <div class="deployment-card" data-id="${escapeHtml(d.id)}">
        <div class="deployment-card-header">
          <div class="card-title-group">
            <div class="card-deployment-name">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-primary); flex-shrink:0;">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
              <span title="${escapeHtml(d.displayName || d.id)}">${escapeHtml(d.displayName || d.id)}</span>
            </div>
            <span class="card-deployment-source" title="${escapeHtml(sourceDesc)}">
              [${escapeHtml(sourceLabel)}] ${escapeHtml(sourceDesc)}
            </span>
          </div>
          <span class="status-pill ${state.isDeploying && !isDeployed ? 'deploying' : (isDeployed ? 'deployed' : 'not-deployed')}">
            <span class="status-dot"></span>
            ${state.isDeploying && !isDeployed ? 'Deploying...' : (isDeployed ? 'Deployed' : 'Pending Deploy')}
          </span>
        </div>

        <div class="deployment-card-body">
          <div class="deployment-stats-row">
            <div class="mini-stat">
              <span class="mini-stat-label">Proxies</span>
              <span class="mini-stat-val">${d.activeProxyCount || (d.proxies ? d.proxies.length : 0)}/${d.totalProxyCount || (d.proxies ? d.proxies.length : 0)} Active</span>
            </div>
            <div class="mini-stat">
              <span class="mini-stat-label">Tests</span>
              <span class="mini-stat-val">${testsCount} Defined</span>
            </div>
            <div class="mini-stat">
              <span class="mini-stat-label">Created</span>
              <span class="mini-stat-val">${formatDate(d.createdAt)}</span>
            </div>
          </div>

          <div class="proxy-chips-section">
            <div class="proxy-chips-title">Proxies &amp; Endpoints</div>
            <div class="proxy-chips-list">
              ${proxyChips}
            </div>
          </div>

          ${lastTestRunHtml}

          <!-- Test Results Drawer (rendered dynamically on test run) -->
          <div class="card-test-results-drawer hidden" id="drawer-${escapeHtml(d.id)}"></div>
        </div>

        <div class="deployment-card-footer">
          <div class="card-primary-actions">
            <a href="/tester/?deployment=${encodeURIComponent(d.id)}" class="btn-open-tool btn-open-tester" title="Open this deployment in API Tester">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
              Tester
            </a>
            <a href="/labs/?deployment=${encodeURIComponent(d.id)}" class="btn-open-tool btn-open-labs" title="Open this deployment in Skills Labs">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
              </svg>
              Labs
            </a>
          </div>

          <div class="card-secondary-actions">
            <button class="btn btn-outline btn-sm btn-run-card-tests" data-id="${escapeHtml(d.id)}" ${isRunning ? 'disabled' : ''} title="Run test suite for this deployment">
              ${isRunning ? '<span class="modal-spinner" style="width:12px; height:12px; border-width:2px;"></span> Testing...' : `
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Run Tests
              `}
            </button>
            <button class="btn btn-outline btn-sm btn-view-card-yaml" data-id="${escapeHtml(d.id)}" title="View Deployment YAML">
              YAML
            </button>
            <button class="btn btn-outline btn-sm btn-deploy-card" data-id="${escapeHtml(d.id)}" title="Deploy to Emulator">
              Deploy
            </button>
            <button class="btn-delete-card" data-id="${escapeHtml(d.id)}" title="Delete Deployment">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function attachCardListeners() {
    // Run Card Tests
    document.querySelectorAll('.btn-run-card-tests').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (!id) return;
        await runDeploymentTests(id);
      });
    });

    // View YAML
    document.querySelectorAll('.btn-view-card-yaml').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (!id) return;
        await openYamlModal(id);
      });
    });

    // Deploy Card
    document.querySelectorAll('.btn-deploy-card').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (!id) return;
        await deploySingleDeployment(id, e.currentTarget);
      });
    });

    // Delete Card
    document.querySelectorAll('.btn-delete-card').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (!id) return;
        if (!confirm(`Are you sure you want to remove deployment '${id}'? This will delete the configuration file.`)) return;
        await deleteDeployment(id);
      });
    });
  }

  // -------------------------------------------------------------
  // Test Execution
  // -------------------------------------------------------------
  async function runDeploymentTests(deploymentId) {
    if (state.runningTests.has(deploymentId)) return;
    state.runningTests.add(deploymentId);
    renderDeploymentsGrid();

    const drawer = document.getElementById(`drawer-${deploymentId}`);
    if (drawer) {
      drawer.classList.remove('hidden');
      drawer.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; color:var(--text-secondary); padding:4px 0;">
          <div class="modal-spinner" style="width:14px; height:14px; border-width:2px;"></div>
          <span>Executing test suite for ${escapeHtml(deploymentId)}...</span>
        </div>
      `;
    }

    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      showToast(`Tests completed for ${deploymentId}: ${data.passed}/${data.total} passed`, data.failed === 0 ? 'success' : 'error');

      // Update drawer
      if (drawer && data.results) {
        drawer.innerHTML = `
          <div style="font-weight:600; margin-bottom:6px; display:flex; justify-content:space-between;">
            <span>Results: ${data.passed}/${data.total} passed</span>
            <span style="font-size:10px; color:var(--text-muted);">${data.durationMs || 0}ms</span>
          </div>
          ${data.results.map((r) => `
            <div class="test-run-item">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px;" title="${escapeHtml(r.name || r.id)}">
                ${r.passed ? '✅' : '❌'} ${escapeHtml(r.name || r.id)}
              </span>
              <span style="color:${r.passed ? 'var(--accent-green)' : 'var(--accent-red)'}; font-family:var(--font-mono); font-size:10px;">
                ${r.status || (r.passed ? '200' : 'FAIL')} (${r.duration || 0}ms)
              </span>
            </div>
          `).join('')}
        `;
      }

      // Re-fetch deployments to update metadata stats
      await fetchDeployments();
      await fetchAnalytics();
    } catch (err) {
      console.error('Failed to run deployment tests:', err);
      showToast(`Error running tests: ${err.message}`, 'error');
      if (drawer) {
        drawer.innerHTML = `<span style="color:var(--accent-red)">Error: ${escapeHtml(err.message)}</span>`;
      }
    } finally {
      state.runningTests.delete(deploymentId);
      renderDeploymentsGrid();
    }
  }

  // -------------------------------------------------------------
  // Deploy Handlers
  // -------------------------------------------------------------
  async function deploySingleDeployment(deploymentId, btn) {
    const origText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Deploying...';
    }

    try {
      showToast(`Deploying '${deploymentId}' and bundle set to Apigee Emulator...`, 'info', 4000);
      const res = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/deploy`, {
        method: 'POST'
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      showToast(`Successfully deployed '${deploymentId}' to emulator!`, 'success');
      await checkEmulatorStatus();
      await fetchDeployments();
    } catch (err) {
      console.error('Deploy error:', err);
      showToast(`Deployment failed: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText;
      }
    }
  }

  async function deployAllDeployments() {
    if (!el.btnDeployAllHeader) return;
    el.btnDeployAllHeader.disabled = true;
    const origHtml = el.btnDeployAllHeader.innerHTML;
    el.btnDeployAllHeader.innerHTML = `
      <span class="modal-spinner" style="width:13px; height:13px; border-width:2px; vertical-align:middle; margin-right:4px;"></span>
      Deploying All...
    `;

    try {
      showToast('Compiling and deploying all deployments together to emulator...', 'info', 5000);
      const res = await fetch('/api/deployments/deploy-all', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      showToast(`All deployments successfully deployed (${data.proxiesDeployed?.length || 0} proxies active)!`, 'success');
      await checkEmulatorStatus();
      await fetchDeployments();
    } catch (err) {
      console.error('Deploy all failed:', err);
      showToast(`Deploy All failed: ${err.message}`, 'error');
    } finally {
      el.btnDeployAllHeader.disabled = false;
      el.btnDeployAllHeader.innerHTML = origHtml;
    }
  }

  async function deleteDeployment(deploymentId) {
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      showToast(`Deployment '${deploymentId}' deleted`, 'info');
      await fetchDeployments();
    } catch (err) {
      console.error('Delete error:', err);
      showToast(`Failed to delete deployment: ${err.message}`, 'error');
    }
  }

  // -------------------------------------------------------------
  // YAML Viewer Modal
  // -------------------------------------------------------------
  async function openYamlModal(deploymentId) {
    if (!el.modalYamlViewer || !el.modalYamlContent) return;
    el.modalYamlTitle.textContent = `${deploymentId}.yaml`;
    el.modalYamlContent.textContent = 'Loading YAML content...';
    el.modalYamlViewer.classList.remove('hidden');

    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/yaml`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      state.activeModalYaml = text;
      el.modalYamlContent.textContent = state.activeModalYaml;
    } catch (err) {
      el.modalYamlContent.textContent = `Error loading YAML: ${err.message}`;
    }
  }

  function closeYamlModal() {
    if (!el.modalYamlViewer) return;
    el.modalYamlViewer.classList.add('hidden');
    state.activeModalYaml = '';
  }

  // -------------------------------------------------------------
  // Load New Deployment (URL, Upload, Paste)
  // -------------------------------------------------------------
  function openLoadModal() {
    if (!el.modalLoadDeployment) return;
    el.modalLoadDeployment.classList.remove('hidden');
    hideAlert();
    // Auto-focus first input after modal opens
    setTimeout(() => {
      const activeTab = document.querySelector('.load-tab-content.active');
      if (activeTab) {
        const input = activeTab.querySelector('input, textarea');
        input?.focus();
      }
    }, 50);
  }

  function closeLoadModal() {
    if (!el.modalLoadDeployment) return;
    el.modalLoadDeployment.classList.add('hidden');
    hideAlert();
  }

  function initLoadPanel() {
    // Open Modal button
    if (el.btnToggleLoadPanel) {
      el.btnToggleLoadPanel.addEventListener('click', () => {
        openLoadModal();
      });
    }

    // Close Modal button
    if (el.btnCloseLoadModal) {
      el.btnCloseLoadModal.addEventListener('click', () => {
        closeLoadModal();
      });
    }

    // Close on overlay backdrop click
    el.modalLoadDeployment?.addEventListener('click', (e) => {
      if (e.target === el.modalLoadDeployment) {
        closeLoadModal();
      }
    });

    // Tabs
    el.loadTabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        el.loadTabBtns.forEach((b) => b.classList.remove('active'));
        el.loadTabContents.forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(targetTab)?.classList.add('active');
        hideAlert();
      });
    });

    // Sample URLs
    el.sampleUrlChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const url = chip.getAttribute('data-url');
        if (el.inputDeploymentUrl && url) {
          el.inputDeploymentUrl.value = url;
        }
      });
    });

    // Tab 1: Load from URL
    el.btnLoadUrl?.addEventListener('click', async () => {
      const url = el.inputDeploymentUrl?.value?.trim();
      if (!url) {
        showAlert('Please enter a valid deployment YAML URL', 'error');
        return;
      }
      await submitLoadDeployment({
        sourceType: 'url',
        url: url,
        autoDeploy: el.chkAutoDeployLoaded?.checked ?? true
      }, el.btnLoadUrl);
    });

    // Tab 2: File Upload / Dropzone
    if (el.uploadDropzone && el.fileUploadInput) {
      el.uploadDropzone.addEventListener('click', () => el.fileUploadInput.click());

      el.uploadDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.uploadDropzone.classList.add('dragover');
      });

      el.uploadDropzone.addEventListener('dragleave', () => {
        el.uploadDropzone.classList.remove('dragover');
      });

      el.uploadDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        el.uploadDropzone.classList.remove('dragover');
        if (e.dataTransfer?.files?.length) {
          handleFileSelected(e.dataTransfer.files[0]);
        }
      });

      el.fileUploadInput.addEventListener('change', (e) => {
        if (e.target.files?.length) {
          handleFileSelected(e.target.files[0]);
        }
      });

      el.btnSubmitUpload?.addEventListener('click', async () => {
        if (!state.selectedFile) {
          showAlert('Please choose a file to upload first', 'error');
          return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
          const yamlContent = event.target.result;
          await submitLoadDeployment({
            sourceType: 'upload',
            filename: state.selectedFile.name,
            yaml: yamlContent,
            autoDeploy: el.chkAutoDeployLoaded?.checked ?? true
          }, el.btnSubmitUpload);
        };
        reader.readAsText(state.selectedFile);
      });
    }

    // Tab 3: Paste YAML
    el.btnLoadPasted?.addEventListener('click', async () => {
      const yaml = el.textareaPasteYaml?.value?.trim();
      const filename = el.inputPasteFilename?.value?.trim();
      if (!yaml) {
        showAlert('Please paste valid YAML content', 'error');
        return;
      }

      await submitLoadDeployment({
        sourceType: 'paste',
        filename: filename || 'custom-deployment.yaml',
        yaml: yaml,
        autoDeploy: el.chkAutoDeployLoaded?.checked ?? true
      }, el.btnLoadPasted);
    });
  }

  function handleFileSelected(file) {
    if (!file.name.endsWith('.yaml') && !file.name.endsWith('.yml')) {
      showAlert('Selected file must be a .yaml or .yml file', 'error');
      return;
    }
    state.selectedFile = file;
    if (el.uploadFileName) el.uploadFileName.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
    el.uploadFileInfo?.classList.remove('hidden');
    hideAlert();
  }

  async function submitLoadDeployment(payload, btn) {
    const origText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }
    showAlert('Processing deployment...', 'info');

    try {
      const res = await fetch('/api/deployments/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      showAlert(`Deployment '${data.deployment?.id || data.id}' loaded successfully!`, 'success');
      showToast(`Loaded deployment '${data.deployment?.id || data.id}'`, 'success');

      // Clear inputs
      if (el.inputDeploymentUrl) el.inputDeploymentUrl.value = '';
      if (el.textareaPasteYaml) el.textareaPasteYaml.value = '';
      if (el.uploadFileInfo) el.uploadFileInfo.classList.add('hidden');
      state.selectedFile = null;

      // Close modal and refresh
      setTimeout(() => {
        closeLoadModal();
      }, 1500);

      await checkEmulatorStatus();
      await fetchDeployments();
    } catch (err) {
      console.error('Error loading deployment:', err);
      showAlert(`Failed to load deployment: ${err.message}`, 'error');
      showToast(`Load failed: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText;
      }
    }
  }

  function showAlert(message, type) {
    if (!el.loadStatusAlert) return;
    el.loadStatusAlert.className = `alert-box ${type}`;
    el.loadStatusAlert.textContent = message;
    el.loadStatusAlert.classList.remove('hidden');
  }

  function hideAlert() {
    if (!el.loadStatusAlert) return;
    el.loadStatusAlert.classList.add('hidden');
  }

  // -------------------------------------------------------------
  // Analytics Overview
  // -------------------------------------------------------------
  async function fetchAnalytics() {
    try {
      const res = await fetch('/api/analytics?limit=15');
      if (!res.ok) return;
      const data = await res.json();
      const records = data.records || [];

      // Update KPI
      if (el.statTotalRequests) el.statTotalRequests.textContent = data.count || records.length;
      if (el.analyticsTotalCalls) el.analyticsTotalCalls.textContent = data.count || records.length;

      if (records.length > 0) {
        let totalLatency = 0;
        let successCount = 0;
        let totalTokens = 0;

        records.forEach((r) => {
          const lat = r.durationMs ?? r.latency ?? r.general?.durationMs ?? 0;
          totalLatency += lat;
          const status = r.statusCode ?? r.status ?? r.general?.statusCode ?? 0;
          if ((status >= 200 && status < 400) || status === 200) {
            successCount += 1;
          }
          const tok = r.ai?.totalTokens ?? r.tokens ?? r.tokenUsage?.total_tokens ?? (r.ai?.['ai.totalTokenCount'] ? parseInt(r.ai['ai.totalTokenCount'], 10) : 0);
          totalTokens += (typeof tok === 'number' && !isNaN(tok) ? tok : 0);
        });

        const avgLat = Math.round(totalLatency / records.length);
        const succRate = Math.round((successCount / records.length) * 100);

        if (el.analyticsAvgLatency) el.analyticsAvgLatency.textContent = `${avgLat} ms`;
        if (el.analyticsSuccessRate) el.analyticsSuccessRate.textContent = `${succRate}%`;
        if (el.analyticsTotalTokens) el.analyticsTotalTokens.textContent = totalTokens.toLocaleString();

        // Render recent requests table
        if (el.recentRequestsTbody) {
          el.recentRequestsTbody.innerHTML = records.slice(0, 8).map((r) => {
            const status = r.statusCode ?? r.status ?? r.general?.statusCode ?? '-';
            const isSuccess = (typeof status === 'number' && status >= 200 && status < 400);
            const proxy = r.proxy || r.proxyName || r.general?.proxyName || 'Unknown';
            const method = r.method || r.httpMethod || r.general?.httpMethod || 'GET';
            const duration = r.durationMs ?? r.latency ?? r.general?.durationMs;
            const rawTokens = r.ai?.totalTokens ?? r.tokens ?? r.tokenUsage?.total_tokens ?? (r.ai?.['ai.totalTokenCount'] ? parseInt(r.ai['ai.totalTokenCount'], 10) : 0);
            const tokens = (rawTokens !== undefined && rawTokens !== 0) ? rawTokens : (rawTokens === 0 ? '0' : '-');
            return `
              <tr>
                <td style="font-size:11px; color:var(--text-muted);">${formatRelativeTime(r.timestamp)}</td>
                <td><strong style="font-family:var(--font-mono); font-size:11px;">${escapeHtml(proxy)}</strong></td>
                <td><span class="badge" style="font-size:10px;">${escapeHtml(method)}</span></td>
                <td><span style="color:${isSuccess ? 'var(--accent-green)' : 'var(--accent-red)'}; font-weight:600;">${status}</span></td>
                <td style="font-family:var(--font-mono);">${duration !== undefined ? duration + 'ms' : '-'}</td>
                <td style="font-family:var(--font-mono);">${tokens}</td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (err) {
      console.warn('Analytics fetch skipped or failed:', err);
    }
  }

  // -------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '-';
    }
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return 'Just now';
    try {
      const ms = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(ms / 60000);
      if (mins < 1) return 'Just now';
      if (mins === 1) return '1 min ago';
      if (mins < 60) return `${mins} mins ago`;
      const hours = Math.floor(mins / 60);
      if (hours === 1) return '1 hour ago';
      if (hours < 24) return `${hours} hours ago`;
      return `${Math.floor(hours / 24)}d ago`;
    } catch {
      return 'Recently';
    }
  }

  // -------------------------------------------------------------
  // Initialization & Event Listeners
  // -------------------------------------------------------------
  function init() {
    initTheme();
    initLoadPanel();

    // Start with load panel collapsed by default
    el.loadDeploymentPanel?.classList.add('collapsed');

    // Header deploy all
    el.btnDeployAllHeader?.addEventListener('click', deployAllDeployments);

    // Global run all tests
    el.btnRunAllTestsGlobal?.addEventListener('click', async () => {
      showToast('Running test suites across all deployments...', 'info', 4000);
      for (const d of state.deployments) {
        await runDeploymentTests(d.id);
      }
    });

    // Filters & Search
    el.inputSearchDeployments?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      renderDeploymentsGrid();
    });

    el.filterDeployStatus?.addEventListener('change', (e) => {
      state.filterStatus = e.target.value;
      renderDeploymentsGrid();
    });

    // Modal Copy & Close
    el.btnCloseModalYaml?.addEventListener('click', closeYamlModal);
    el.modalYamlViewer?.addEventListener('click', (e) => {
      if (e.target === el.modalYamlViewer) closeYamlModal();
    });
    el.btnCopyModalYaml?.addEventListener('click', () => {
      if (!state.activeModalYaml) return;
      navigator.clipboard.writeText(state.activeModalYaml).then(() => {
        showToast('YAML copied to clipboard!', 'success');
      }).catch(() => {
        showToast('Failed to copy to clipboard', 'error');
      });
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el.modalYamlViewer?.classList.contains('hidden')) {
          closeYamlModal();
        }
        if (!el.modalLoadDeployment?.classList.contains('hidden')) {
          closeLoadModal();
        }
      }
    });

    // Initial Data Fetch
    checkEmulatorStatus();
    fetchDeployments();
    fetchAnalytics();

    // Dynamic reactive status poll (fast 1.5s when deploying, 5s when ready)
    function scheduleStatusPoll() {
      setTimeout(async () => {
        await checkEmulatorStatus();
        scheduleStatusPoll();
      }, state.isDeploying ? 1500 : 5000);
    }
    scheduleStatusPoll();
  }

  // Start on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
