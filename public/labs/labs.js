/**
 * Apigee AI Gateway - Interactive Deployment Codelab
 * Dynamic Step-by-Step Walkthrough with Participant Provisioning & Usage Leaderboard
 */

(function () {
  'use strict';

  // Application State
  const state = {
    tests: [],
    currentStepIndex: 0,
    testResults: {}, // testName -> { passed, statusCode, durationMs, targetLatencyMs, assertions, responseData, headers, traceSessionId, traceData, usage }
    editMode: false,
    participant: null, // { id, name, email, appName, consumerKey, consumerSecret }
    proxyYamlCache: {}, // proxyName -> { yaml, source }
  };

  // Known Header Explanations for Apigee Gateway
  const HEADER_DESCRIPTIONS = {
    'x-apigee-proxy': 'Identifies the Apigee API proxy that processed the request.',
    'x-apigee-target-latency': 'Time (in ms) spent waiting for the upstream target service (e.g. Vertex AI/Gemini).',
    'x-apigee-tracking-id': 'Unique distributed trace correlation identifier assigned by the gateway.',
    'x-failover-target': 'Indicates intelligent failover was triggered to a secondary provider.',
    'content-type': 'MIME format of the response entity (e.g. application/json or text/event-stream).',
    'date': 'RFC 1123 HTTP timestamp of gateway execution.',
    'server': 'Upstream HTTP server identification header.',
  };

  // Helper: Markdown parser for documentation strings
  function renderMarkdown(md) {
    if (!md) return '<p class="text-muted">No documentation provided for this test.</p>';

    let html = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');
    html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

    html = html.replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li class="num-li" data-num="$1">$2</li>');
    html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>');

    const lines = html.split('\n');
    let inList = false;
    const processed = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        if (inList) {
          processed.push('</ul>');
          inList = false;
        }
        continue;
      }

      if (line.startsWith('<li>') || line.startsWith('<li class="num-li"')) {
        if (!inList) {
          processed.push('<ul class="doc-list">');
          inList = true;
        }
        processed.push(line);
      } else {
        if (inList) {
          processed.push('</ul>');
          inList = false;
        }
        if (line.startsWith('<h') || line.startsWith('<blockquote') || line.startsWith('<pre')) {
          processed.push(line);
        } else {
          processed.push(`<p>${line}</p>`);
        }
      }
    }

    if (inList) {
      processed.push('</ul>');
    }

    return processed.join('\n');
  }

  // Helper: Format test object to clean YAML string with participant key substituted
  function formatTestAsYaml(test) {
    if (!test) return '';
    const lines = [
      `- name: ${test.name}`,
      `  description: "${(test.description || '').replace(/"/g, '\\"')}"`,
      `  proxy: ${test.proxy}`,
      `  path: ${test.path}`,
      `  method: ${test.verb || test.method || 'POST'}`,
    ];

    const currentKey = state.participant?.consumerKey || 'test-app-key-123';
    const headers = { ...(test.headers || {}) };
    if (headers['x-api-key']) {
      headers['x-api-key'] = currentKey;
    }

    if (headers && Object.keys(headers).length > 0) {
      lines.push('  headers:');
      for (const [k, v] of Object.entries(headers)) {
        lines.push(`    ${k}: "${v}"`);
      }
    } else {
      lines.push('  headers: {}');
    }

    if (test.body) {
      lines.push('  body: |');
      const bodyLines = test.body.trim().split('\n');
      for (const bl of bodyLines) {
        lines.push(`    ${bl}`);
      }
    }

    if (test.assertions && test.assertions.length > 0) {
      lines.push('  assertions:');
      for (const a of test.assertions) {
        lines.push(`    - ${a}`);
      }
    }

    return lines.join('\n');
  }

  // Toast notifications
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `alert alert-${type}`;
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.animation = 'fadeIn 0.2s ease';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // Flow pipeline steps generator based on proxy type
  function getPipelineNodes(proxyName) {
    const p = (proxyName || '').toLowerCase();
    const nodes = [
      { type: 'client', label: 'Client Request' },
      { type: 'policy', label: 'VA-VerifyKey (Cassandra)' },
    ];

    if (p.includes('completions')) {
      nodes.push({ type: 'policy', label: 'JS-CheckModel' });
      nodes.push({ type: 'policy', label: 'LTQ-QuotaEnforce' });
      nodes.push({ type: 'target', label: 'Target / Failover Route' });
    } else if (p.includes('generatecontent') || p.includes('interactions')) {
      nodes.push({ type: 'policy', label: 'LTQ-QuotaEnforce' });
      nodes.push({ type: 'policy', label: 'AM-SetGoogleToken' });
      nodes.push({ type: 'target', label: 'Vertex AI Gemini Target' });
    } else if (p.includes('messages')) {
      nodes.push({ type: 'policy', label: 'JS-AnthropicTransform' });
      nodes.push({ type: 'target', label: 'Google Cloud AI Target' });
    } else if (p.includes('embeddings')) {
      nodes.push({ type: 'policy', label: 'JS-EmbeddingRoute' });
      nodes.push({ type: 'target', label: 'Vertex Embeddings Target' });
    } else {
      nodes.push({ type: 'policy', label: 'LTQ-QuotaEnforce' });
      nodes.push({ type: 'target', label: 'Backend AI Target' });
    }

    nodes.push({ type: 'policy', label: 'PostFlow Analytics' });
    nodes.push({ type: 'client', label: 'Response (200 OK)' });

    return nodes;
  }

  // Load Saved Progress and Participant from LocalStorage
  function loadSavedState() {
    try {
      const savedResults = localStorage.getItem('apigee_lab_test_results');
      if (savedResults) {
        state.testResults = JSON.parse(savedResults);
      }

      const savedParticipant = localStorage.getItem('apigee_lab_participant');
      if (savedParticipant) {
        state.participant = JSON.parse(savedParticipant);
        updateParticipantUI();
      }
    } catch {
      // ignore
    }
  }

  // Save Progress to LocalStorage
  function saveProgress() {
    try {
      localStorage.setItem('apigee_lab_test_results', JSON.stringify(state.testResults));
    } catch {
      // ignore
    }
  }

  // Update Participant Header Chip UI
  function updateParticipantUI() {
    const avatar = document.getElementById('participant-avatar');
    const name = document.getElementById('participant-name');
    const keyPill = document.getElementById('participant-key-pill');

    if (state.participant) {
      if (avatar) avatar.textContent = (state.participant.name || 'U').charAt(0).toUpperCase();
      if (name) name.textContent = state.participant.name || 'Participant';
      if (keyPill) keyPill.textContent = state.participant.consumerKey || 'No Key';
    } else {
      if (avatar) avatar.textContent = '?';
      if (name) name.textContent = 'Register User';
      if (keyPill) keyPill.textContent = 'Provision Key';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Prompt or Switch Participant Dialog
  function promptOnboarding(force = false) {
    const modal = document.getElementById('modal-onboarding');
    if (!modal) return;
    if (force || !state.participant) {
      const errBox = document.getElementById('onboarding-error-box');
      if (errBox) {
        errBox.style.display = 'none';
        errBox.innerHTML = '';
      }
      const closeBtn = document.getElementById('btn-close-onboarding');
      if (closeBtn) {
        closeBtn.style.display = state.participant ? 'block' : 'none';
      }
      if (typeof modal.showModal === 'function') {
        modal.showModal();
      } else {
        modal.style.display = 'block';
      }
      const input = document.getElementById('input-participant-name');
      if (input) {
        input.value = '';
        input.focus();
      }
    }
  }

  function closeOnboarding() {
    const modal = document.getElementById('modal-onboarding');
    if (!modal) return;
    if (typeof modal.close === 'function') modal.close();
    else modal.style.display = 'none';
  }

  // Open Participant Profile Dialog
  function openParticipantProfile() {
    if (!state.participant) {
      promptOnboarding(true);
      return;
    }
    const modal = document.getElementById('modal-participant-profile');
    if (!modal) return;

    const avatar = document.getElementById('profile-badge-avatar');
    const nameHeader = document.getElementById('profile-modal-name');
    const appHeader = document.getElementById('profile-modal-app');
    const valName = document.getElementById('profile-val-name');
    const valEmail = document.getElementById('profile-val-email');
    const valKey = document.getElementById('profile-val-key');

    if (avatar) avatar.textContent = (state.participant.name || 'U').charAt(0).toUpperCase();
    if (nameHeader) nameHeader.textContent = state.participant.name || 'Participant';
    if (appHeader) appHeader.textContent = state.participant.appName || 'Apigee Developer Sandbox';
    if (valName) valName.textContent = state.participant.name || '-';
    if (valEmail) valEmail.textContent = state.participant.email || '-';
    if (valKey) valKey.textContent = state.participant.consumerKey || '-';

    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.style.display = 'block';
  }

  function closeParticipantProfile() {
    const modal = document.getElementById('modal-participant-profile');
    if (!modal) return;
    if (typeof modal.close === 'function') modal.close();
    else modal.style.display = 'none';
  }

  // Delete Account Confirmation Dialog
  function openDeleteConfirm() {
    const modal = document.getElementById('modal-delete-confirm');
    if (!modal) return;
    const nameEl = document.getElementById('delete-confirm-user-name');
    if (nameEl) nameEl.textContent = state.participant?.name || 'this user';

    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.style.display = 'block';
  }

  function closeDeleteConfirm() {
    const modal = document.getElementById('modal-delete-confirm');
    if (!modal) return;
    if (typeof modal.close === 'function') modal.close();
    else modal.style.display = 'none';
  }

  async function handleAccountDelete() {
    if (!state.participant) return;
    const consumerKey = state.participant.consumerKey;
    const userName = state.participant.name;

    try {
      const resp = await fetch('/api/labs/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumerKey }),
      });
      const data = await resp.json();
      if (!data.success) {
        showToast(data.error || 'Failed to delete account', 'danger');
        return;
      }
    } catch {
      showToast('Error contacting server to delete account', 'danger');
      return;
    }

    // Clear state completely
    state.participant = null;
    state.testResults = {};
    state.currentStepIndex = 0;
    state.editMode = false;
    localStorage.removeItem('apigee_lab_participant');
    localStorage.removeItem('apigee_lab_test_results');

    closeDeleteConfirm();
    closeParticipantProfile();
    updateParticipantUI();
    renderCurrentStep();
    updateOverallProgress();

    showToast(`Account for "${userName}" and all data permanently deleted.`, 'info');
    setTimeout(() => promptOnboarding(true), 350);
  }

  // Register Participant Form Handler
  async function handleOnboardingSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('input-participant-name');
    const submitBtn = document.getElementById('btn-submit-onboarding');
    const errBox = document.getElementById('onboarding-error-box');
    const name = input ? input.value.trim() : '';

    if (!name) {
      showToast('Please enter your name', 'warning');
      return;
    }

    if (errBox) {
      errBox.style.display = 'none';
      errBox.innerHTML = '';
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>Provisioning in Cassandra... ⏳</span>';
    }

    try {
      const resp = await fetch('/api/labs/register-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();

      // Check if user already exists
      if (resp.status === 409 || data.code === 'USER_ALREADY_EXISTS') {
        if (errBox) {
          errBox.style.display = 'block';
          const pName = data.participant?.name || name;
          const pKey = data.participant?.consumerKey || '';
          errBox.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="font-weight: 600; color: #d93025; display: flex; align-items: center; gap: 6px;">
                <span>⚠️ User already exists</span>
              </div>
              <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.4;">
                A participant named <strong>${escapeHtml(pName)}</strong> already exists with key <code>${escapeHtml(pKey)}</code>. Each user uses the same key always.
              </div>
              <div style="display: flex; gap: 8px; margin-top: 4px;">
                <button type="button" class="btn btn-primary btn-sm" id="btn-use-existing-user">
                  <span>Continue as "${escapeHtml(pName)}"</span>
                </button>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-choose-diff-name">
                  <span>Enter different name</span>
                </button>
              </div>
            </div>
          `;

          document.getElementById('btn-use-existing-user')?.addEventListener('click', async () => {
            try {
              const loginResp = await fetch('/api/labs/login-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: pName }),
              });
              const loginData = await loginResp.json();
              if (loginData.success && loginData.participant) {
                state.participant = loginData.participant;
                localStorage.setItem('apigee_lab_participant', JSON.stringify(state.participant));
                updateParticipantUI();
                closeOnboarding();
                showToast(`Welcome back ${loginData.participant.name}!`, 'success');
                renderCurrentStep();
              } else {
                showToast(loginData.error || 'Failed to load user', 'danger');
              }
            } catch {
              showToast('Error loading existing user', 'danger');
            }
          });

          document.getElementById('btn-choose-diff-name')?.addEventListener('click', () => {
            errBox.style.display = 'none';
            if (input) {
              input.value = '';
              input.focus();
            }
          });
        }
        showToast('User already exists', 'warning');
        return;
      }

      if (data.success && data.participant) {
        state.participant = data.participant;
        localStorage.setItem('apigee_lab_participant', JSON.stringify(state.participant));
        updateParticipantUI();
        closeOnboarding();

        showToast(`Welcome ${data.participant.name}! API Key provisioned into Cassandra.`, 'success');
        renderCurrentStep();
      } else {
        showToast(data.error || 'Failed to register participant', 'danger');
      }
    } catch (err) {
      showToast('Error registering participant with emulator', 'danger');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Start Codelab & Provision Key 🚀</span>';
      }
    }
  }

  // Open Leaderboard Modal
  async function openLeaderboard() {
    const modal = document.getElementById('modal-leaderboard');
    if (!modal) return;

    if (typeof modal.showModal === 'function') {
      modal.showModal();
    } else {
      modal.style.display = 'block';
    }

    await refreshLeaderboard();
  }

  function closeLeaderboard() {
    const modal = document.getElementById('modal-leaderboard');
    if (!modal) return;
    if (typeof modal.close === 'function') {
      modal.close();
    } else {
      modal.style.display = 'none';
    }
  }

  // Open Reset Confirmation Modal
  function openResetModal() {
    const modal = document.getElementById('modal-reset-confirm');
    if (!modal) return;
    if (typeof modal.showModal === 'function') {
      modal.showModal();
    } else {
      modal.style.display = 'block';
    }
  }

  function closeResetModal() {
    const modal = document.getElementById('modal-reset-confirm');
    if (!modal) return;
    if (typeof modal.close === 'function') {
      modal.close();
    } else {
      modal.style.display = 'none';
    }
  }

  // Handle Confirmed Reset Action
  async function handleResetConfirm() {
    const chkDelete = document.getElementById('chk-delete-account');
    const chkUsage = document.getElementById('chk-reset-usage');
    const shouldDeleteAccount = chkDelete ? chkDelete.checked : false;
    const shouldResetUsage = chkUsage ? chkUsage.checked : true;

    // 1. Permanently delete account if requested
    if (shouldDeleteAccount && state.participant?.consumerKey) {
      try {
        await fetch('/api/labs/delete-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consumerKey: state.participant.consumerKey }),
        });
      } catch {
        // ignore
      }
      state.participant = null;
      localStorage.removeItem('apigee_lab_participant');
      updateParticipantUI();
    } else if (shouldResetUsage && state.participant?.consumerKey) {
      // Otherwise only clear leaderboard calls
      try {
        await fetch('/api/labs/reset-user-progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consumerKey: state.participant.consumerKey }),
        });
      } catch {
        // ignore
      }
    }

    // 2. Clear test execution progress in memory and storage
    state.testResults = {};
    state.currentStepIndex = 0;
    state.editMode = false;
    localStorage.removeItem('apigee_lab_test_results');
    sessionStorage.removeItem(`apigee_lab_leaderboard_prompted_${state.tests.length}`);

    closeResetModal();

    // 3. Update UI
    renderCurrentStep();
    updateOverallProgress();

    if (shouldDeleteAccount) {
      showToast('Account and all lab data deleted! Starting fresh.', 'info');
      setTimeout(() => promptOnboarding(true), 350);
    } else {
      showToast('Lab progress reset! You can now start fresh from Step 1.', 'success');
    }
  }

  // Refresh Leaderboard Data from API
  async function refreshLeaderboard() {
    const tableBody = document.getElementById('leaderboard-table-body');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Loading fleet analytics...</td></tr>';

    try {
      const currentKey = state.participant?.consumerKey || '';
      const url = currentKey
        ? `/api/labs/leaderboard?currentKey=${encodeURIComponent(currentKey)}`
        : '/api/labs/leaderboard';

      const resp = await fetch(url);
      const data = await resp.json();

      if (data.success && Array.isArray(data.leaderboard)) {
        renderLeaderboard(data.leaderboard);
      } else {
        tableBody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No usage data found yet.</td></tr>';
      }
    } catch {
      tableBody.innerHTML = '<tr><td colspan="8" class="text-center text-danger">Error fetching leaderboard data.</td></tr>';
    }
  }

  // Render Leaderboard Cards & Table
  function renderLeaderboard(entries) {
    const tableBody = document.getElementById('leaderboard-table-body');
    if (!tableBody) return;

    if (entries.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No participant usage recorded yet.</td></tr>';
      return;
    }

    // Identify leaders
    let maxTokensEntry = entries[0];
    let maxCallsEntry = entries[0];
    let maxBudgetEntry = entries[0];
    let totalFleetLatency = 0;
    let latencyCount = 0;

    for (const e of entries) {
      if (e.totalTokens > maxTokensEntry.totalTokens) maxTokensEntry = e;
      if (e.totalCalls > maxCallsEntry.totalCalls) maxCallsEntry = e;
      if (e.estimatedCost > maxBudgetEntry.estimatedCost) maxBudgetEntry = e;
      if (e.avgLatencyMs > 0) {
        totalFleetLatency += e.avgLatencyMs;
        latencyCount++;
      }
    }

    const avgFleetLat = latencyCount > 0 ? Math.round(totalFleetLatency / latencyCount) : 0;

    // Update Spotlight cards
    const spotTokensVal = document.getElementById('spot-tokens-val');
    const spotTokensUser = document.getElementById('spot-tokens-user');
    const spotCallsVal = document.getElementById('spot-calls-val');
    const spotCallsUser = document.getElementById('spot-calls-user');
    const spotBudgetVal = document.getElementById('spot-budget-val');
    const spotBudgetUser = document.getElementById('spot-budget-user');
    const spotLatVal = document.getElementById('spot-latency-val');

    if (spotTokensVal) spotTokensVal.textContent = maxTokensEntry.totalTokens.toLocaleString();
    if (spotTokensUser) spotTokensUser.textContent = maxTokensEntry.name;
    if (spotCallsVal) spotCallsVal.textContent = maxCallsEntry.totalCalls.toLocaleString();
    if (spotCallsUser) spotCallsUser.textContent = maxCallsEntry.name;
    if (spotBudgetVal) spotBudgetVal.textContent = maxBudgetEntry.estimatedCostFormatted;
    if (spotBudgetUser) spotBudgetUser.textContent = maxBudgetEntry.name;
    if (spotLatVal) spotLatVal.textContent = `${avgFleetLat} ms`;

    // Render Table
    tableBody.innerHTML = '';
    entries.forEach((e) => {
      const tr = document.createElement('tr');
      if (e.isCurrent) tr.className = 'current-user-row';

      let medal = `#${e.rank}`;
      if (e.rank === 1) medal = '🥇';
      else if (e.rank === 2) medal = '🥈';
      else if (e.rank === 3) medal = '🥉';

      const initial = (e.name || 'U').charAt(0).toUpperCase();

      tr.innerHTML = `
        <td class="text-center"><span class="rank-badge">${medal}</span></td>
        <td>
          <div class="user-cell">
            <div class="user-cell-avatar">${initial}</div>
            <div>
              <div>${e.name} ${e.isCurrent ? '<span class="you-badge">You</span>' : ''}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${e.email}</div>
            </div>
          </div>
        </td>
        <td><code>${e.consumerKey}</code></td>
        <td><span class="badge ${e.testsCompletedCount >= 5 ? 'badge-proxy' : ''}">${e.testsCompletedCount} / 5</span></td>
        <td><strong>${e.totalCalls}</strong></td>
        <td>
          <strong>${e.totalTokens.toLocaleString()}</strong>
          <div style="font-size: 10px; color: var(--text-muted);">${e.promptTokens || 0} in / ${e.completionTokens || 0} out</div>
        </td>
        <td style="font-family: var(--font-mono); font-weight: 600; color: var(--success);">${e.estimatedCostFormatted}</td>
        <td>${e.avgLatencyMs ? `${e.avgLatencyMs} ms` : '--'}</td>
      `;
      tableBody.appendChild(tr);
    });
  }

  // Update Stepper & Top Progress Bar
  function updateOverallProgress() {
    const total = state.tests.length;
    if (total === 0) return;

    let validatedCount = 0;
    for (const test of state.tests) {
      if (state.testResults[test.name]?.passed) {
        validatedCount++;
      }
    }

    const pct = Math.round((validatedCount / total) * 100);
    const fillEl = document.getElementById('progress-bar-fill');
    const statusTextEl = document.getElementById('progress-status-text');
    const scoreTextEl = document.getElementById('score-text');

    if (fillEl) fillEl.style.width = `${pct}%`;
    if (statusTextEl) {
      statusTextEl.textContent = `${validatedCount} of ${total} Tests Validated (${pct}%)`;
    }
    if (scoreTextEl) {
      scoreTextEl.textContent = `${validatedCount} / ${total} Validated`;
    }

    // Update bottom stepper dots
    const dotsContainer = document.getElementById('stepper-dots-container');
    if (dotsContainer) {
      dotsContainer.innerHTML = '';
      state.tests.forEach((t, idx) => {
        const dot = document.createElement('div');
        dot.className = 'stepper-dot';
        if (idx === state.currentStepIndex) dot.classList.add('active');
        if (state.testResults[t.name]?.passed) dot.classList.add('validated');
        dot.title = `Step ${idx + 1}: ${t.name}`;
        dot.onclick = () => selectStep(idx);
        dotsContainer.appendChild(dot);
      });
    }

    // Update Top Ribbon Buttons
    const ribbon = document.getElementById('test-stepper-ribbon');
    if (ribbon) {
      const buttons = ribbon.querySelectorAll('.step-tab-btn');
      buttons.forEach((btn, idx) => {
        const t = state.tests[idx];
        if (!t) return;
        btn.classList.toggle('active', idx === state.currentStepIndex);
        btn.classList.remove('validated', 'failed');

        const tag = btn.querySelector('.step-status-tag');
        const res = state.testResults[t.name];
        if (res) {
          if (res.passed) {
            btn.classList.add('validated');
            if (tag) tag.textContent = '✓ Validated';
          } else {
            btn.classList.add('failed');
            if (tag) tag.textContent = '✗ Failed';
          }
        } else {
          if (tag) tag.textContent = 'Not Run';
        }
      });
    }

    // Check if ALL tests validated
    if (validatedCount === total && total > 0) {
      // Prompt leaderboard celebration
      const keyShown = `apigee_lab_leaderboard_prompted_${total}`;
      if (!sessionStorage.getItem(keyShown)) {
        sessionStorage.setItem(keyShown, 'true');
        setTimeout(() => {
          showToast('🎉 Congratulations! You validated all deployment tests! Opening Leaderboard...', 'success');
          openLeaderboard();
        }, 1200);
      }
    }

    // Update Footer Next / Prev buttons
    const prevBtn = document.getElementById('btn-prev-test');
    const nextBtn = document.getElementById('btn-next-test');
    if (prevBtn) prevBtn.disabled = state.currentStepIndex === 0;
    if (nextBtn) nextBtn.disabled = state.currentStepIndex === total - 1;
  }

  // Render Stepper Ribbon Buttons
  function renderStepperRibbon() {
    const ribbon = document.getElementById('test-stepper-ribbon');
    if (!ribbon) return;

    ribbon.innerHTML = '';
    state.tests.forEach((t, idx) => {
      const btn = document.createElement('button');
      btn.className = 'step-tab-btn';
      if (idx === state.currentStepIndex) btn.classList.add('active');

      const numPill = document.createElement('span');
      numPill.className = 'step-num-pill';
      numPill.textContent = idx + 1;

      const titleSpan = document.createElement('span');
      titleSpan.textContent = t.proxyDisplayName || t.name;

      const statusTag = document.createElement('span');
      statusTag.className = 'step-status-tag';
      statusTag.textContent = 'Not Run';

      btn.appendChild(numPill);
      btn.appendChild(titleSpan);
      btn.appendChild(statusTag);

      btn.onclick = () => selectStep(idx);
      ribbon.appendChild(btn);
    });

    updateOverallProgress();
  }

  // Select Step by Index
  function selectStep(index) {
    if (index < 0 || index >= state.tests.length) return;
    state.currentStepIndex = index;
    state.editMode = false;
    renderCurrentStep();
    updateOverallProgress();
  }

  // Render Current Step Data
  async function renderCurrentStep() {
    const test = state.tests[state.currentStepIndex];
    if (!test) return;

    const total = state.tests.length;
    const currentKey = state.participant?.consumerKey || 'test-app-key-123';

    // Header badges & titles
    const stepBadge = document.getElementById('step-badge');
    if (stepBadge) stepBadge.textContent = `STEP ${state.currentStepIndex + 1} OF ${total}`;

    const testTitle = document.getElementById('test-title');
    if (testTitle) testTitle.textContent = test.description || test.name;

    const badgeProxy = document.getElementById('badge-proxy');
    if (badgeProxy) badgeProxy.textContent = test.proxyDisplayName || test.proxy;

    const badgeVerb = document.getElementById('badge-verb');
    if (badgeVerb) badgeVerb.textContent = test.verb || test.method || 'POST';

    const badgePath = document.getElementById('badge-path');
    if (badgePath) badgePath.textContent = test.path;

    // Left Pane Tab 1: Documentation & Architecture
    const descTitle = document.getElementById('doc-description-title');
    if (descTitle) descTitle.textContent = `${test.name} (${test.proxy})`;

    const descText = document.getElementById('doc-description-text');
    if (descText) descText.textContent = test.description || 'Validates proxy deployment and routing rules.';

    // Pipeline Diagram
    const flowSteps = document.getElementById('flow-diagram-steps');
    if (flowSteps) {
      const nodes = getPipelineNodes(test.proxy);
      flowSteps.innerHTML = '';
      nodes.forEach((n, idx) => {
        const nodeDiv = document.createElement('div');
        nodeDiv.className = `flow-node ${n.type}`;
        nodeDiv.textContent = n.label;
        flowSteps.appendChild(nodeDiv);

        if (idx < nodes.length - 1) {
          const arrow = document.createElement('span');
          arrow.className = 'flow-arrow';
          arrow.textContent = '→';
          flowSteps.appendChild(arrow);
        }
      });
    }

    // Markdown Doc Content
    const mdContainer = document.getElementById('markdown-doc-content');
    if (mdContainer) {
      mdContainer.innerHTML = renderMarkdown(test.documentation);
    }

    // Expected Assertions List
    const assertionsList = document.getElementById('assertions-expected-list');
    if (assertionsList) {
      assertionsList.innerHTML = '';
      const assertions = test.assertions && test.assertions.length > 0 ? test.assertions : ['response.status == 200'];
      for (const a of assertions) {
        const li = document.createElement('li');
        li.innerHTML = `<span>✓</span> <code>${a}</code>`;
        assertionsList.appendChild(li);
      }
    }

    // Left Pane Tab 2: Test YAML Snippet
    const yamlCodeEl = document.getElementById('test-yaml-code');
    if (yamlCodeEl) {
      yamlCodeEl.querySelector('code').textContent = formatTestAsYaml(test);
    }

    // Left Pane Tab 3: Proxy Configuration YAML
    loadProxyYaml(test.proxy);

    // Right Pane: Request Summary Card
    const reqMethodTag = document.getElementById('req-method-tag');
    if (reqMethodTag) reqMethodTag.textContent = test.verb || test.method || 'POST';

    const reqUrlText = document.getElementById('req-url-text');
    if (reqUrlText) reqUrlText.textContent = `http://localhost:8998${test.path}`;

    // Request Headers Preview (with participant key substituted)
    const reqHeadersPreview = document.getElementById('req-headers-preview');
    if (reqHeadersPreview) {
      reqHeadersPreview.innerHTML = '';
      const headers = { ...(test.headers || {}) };
      if (headers['x-api-key']) {
        headers['x-api-key'] = currentKey;
      }

      for (const [k, v] of Object.entries(headers)) {
        const pill = document.createElement('div');
        const isUserKey = k.toLowerCase() === 'x-api-key';
        pill.className = `header-pill ${isUserKey ? 'user-key' : ''}`;
        pill.innerHTML = `<strong>${k}:</strong> <span>${v}</span> ${isUserKey ? '<span style="font-size: 9px; opacity: 0.8;">(Your Key)</span>' : ''}`;
        reqHeadersPreview.appendChild(pill);
      }
      if (Object.keys(headers).length === 0) {
        const pill = document.createElement('div');
        pill.className = 'header-pill text-muted';
        pill.textContent = 'No custom headers (default product authentication)';
        reqHeadersPreview.appendChild(pill);
      }
    }

    // Request Body Preview
    const reqBodyCode = document.getElementById('req-body-code');
    if (reqBodyCode) {
      reqBodyCode.textContent = test.body ? test.body.trim() : '(Empty body)';
    }

    // Form inputs for edit mode
    const editHeaders = document.getElementById('edit-req-headers');
    if (editHeaders) {
      const activeHeaders = { ...(test.headers || {}) };
      if (activeHeaders['x-api-key']) activeHeaders['x-api-key'] = currentKey;
      editHeaders.value = JSON.stringify(activeHeaders, null, 2);
    }

    const editBody = document.getElementById('edit-req-body');
    if (editBody) editBody.value = test.body ? test.body.trim() : '';

    updateEditModeUI();

    // Render Past Results if Available
    const pastResult = state.testResults[test.name];
    renderExecutionResult(pastResult);
  }

  // Load and cache Proxy YAML definition
  async function loadProxyYaml(proxyName) {
    const codeEl = document.getElementById('proxy-yaml-code');
    const sourceTag = document.getElementById('proxy-yaml-source-tag');
    if (!codeEl) return;

    if (state.proxyYamlCache[proxyName]) {
      codeEl.querySelector('code').textContent = state.proxyYamlCache[proxyName].yaml;
      if (sourceTag) sourceTag.textContent = `Source: ${state.proxyYamlCache[proxyName].source || proxyName}`;
      return;
    }

    codeEl.querySelector('code').textContent = `Loading proxy definition for ${proxyName}...`;
    try {
      const resp = await fetch(`/api/proxy/yaml?name=${encodeURIComponent(proxyName)}`);
      const data = await resp.json();
      if (data && data.yaml) {
        state.proxyYamlCache[proxyName] = data;
        codeEl.querySelector('code').textContent = data.yaml;
        if (sourceTag) sourceTag.textContent = `Source: ${data.source}`;
      } else {
        codeEl.querySelector('code').textContent = `# No external proxy YAML found for ${proxyName}`;
      }
    } catch {
      codeEl.querySelector('code').textContent = `# Error fetching proxy YAML for ${proxyName}`;
    }
  }

  // Toggle Edit Mode
  function toggleEditMode() {
    state.editMode = !state.editMode;
    updateEditModeUI();
  }

  function updateEditModeUI() {
    const previewSection = document.getElementById('request-preview-section');
    const editSection = document.getElementById('request-edit-section');
    const label = document.getElementById('edit-mode-label');

    if (previewSection && editSection) {
      if (state.editMode) {
        previewSection.style.display = 'none';
        editSection.style.display = 'flex';
        if (label) label.textContent = 'View Preview';
      } else {
        previewSection.style.display = 'block';
        editSection.style.display = 'none';
        if (label) label.textContent = 'Edit Request';
      }
    }
  }

  // Reset Edit Request to Default Test Definition
  function resetEditRequest() {
    const test = state.tests[state.currentStepIndex];
    if (!test) return;

    const currentKey = state.participant?.consumerKey || 'test-app-key-123';
    const activeHeaders = { ...(test.headers || {}) };
    if (activeHeaders['x-api-key']) activeHeaders['x-api-key'] = currentKey;

    const editHeaders = document.getElementById('edit-req-headers');
    if (editHeaders) editHeaders.value = JSON.stringify(activeHeaders, null, 2);

    const editBody = document.getElementById('edit-req-body');
    if (editBody) editBody.value = test.body ? test.body.trim() : '';

    showToast('Request reset to default values', 'info');
  }

  // Render Result / Execution Status
  function renderExecutionResult(result) {
    const banner = document.getElementById('validation-banner');
    const icon = document.getElementById('validation-icon');
    const heading = document.getElementById('validation-heading');
    const subtext = document.getElementById('validation-subtext');
    const metrics = document.getElementById('validation-metrics');
    const statusCodeEl = document.getElementById('val-status-code');
    const totalTimeEl = document.getElementById('val-total-time');
    const targetTimeEl = document.getElementById('val-target-time');
    const tokensEl = document.getElementById('val-tokens');
    const assertionsCount = document.getElementById('assertions-count');
    const assertionsList = document.getElementById('assertions-results-list');
    const nextPrompt = document.getElementById('next-step-prompt');
    const responsePill = document.getElementById('response-status-pill');
    const responseCode = document.getElementById('response-body-code');
    const headersTableBody = document.getElementById('headers-table-body');
    const headerCountBadge = document.getElementById('header-count-badge');
    const traceSessionId = document.getElementById('trace-session-id');
    const downloadTraceBtn = document.getElementById('btn-download-trace');
    const traceRawContainer = document.getElementById('trace-raw-container');
    const traceRawCode = document.getElementById('trace-raw-code');

    if (!result) {
      if (banner) banner.className = 'validation-status-banner not-run';
      if (icon) icon.textContent = '⏳';
      if (heading) heading.textContent = 'Step Not Yet Run';
      if (subtext) subtext.textContent = 'Click "Run Test & Trace" to execute the request against the Apigee Emulator runtime.';
      if (metrics) metrics.style.display = 'none';
      if (assertionsCount) assertionsCount.textContent = '0 / 0 Passed';
      if (assertionsList) assertionsList.innerHTML = '<div class="assertion-placeholder">Run test to evaluate assertions.</div>';
      if (nextPrompt) nextPrompt.style.display = 'none';
      if (responsePill) responsePill.textContent = 'No Response Yet';
      if (responseCode) responseCode.querySelector('code').textContent = 'Run the test to see the live model response from the Apigee Emulator runtime.';
      if (headersTableBody) headersTableBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No response headers captured yet.</td></tr>';
      if (headerCountBadge) headerCountBadge.textContent = '0';
      if (traceSessionId) traceSessionId.textContent = 'None';
      if (downloadTraceBtn) downloadTraceBtn.style.display = 'none';
      if (traceRawContainer) traceRawContainer.style.display = 'none';
      return;
    }

    if (metrics) metrics.style.display = 'flex';
    if (statusCodeEl) statusCodeEl.textContent = result.statusCode || (result.passed ? '200' : '500');
    if (totalTimeEl) totalTimeEl.textContent = `${result.durationMs || 0} ms`;
    if (targetTimeEl) targetTimeEl.textContent = `${result.targetLatencyMs || Math.round((result.durationMs || 0) * 0.9)} ms`;
    if (tokensEl) {
      const tok = result.usage?.tokens || 0;
      tokensEl.textContent = tok > 0 ? tok.toLocaleString() : '--';
    }

    if (result.passed) {
      if (banner) banner.className = 'validation-status-banner passed';
      if (icon) icon.textContent = '✓';
      if (heading) heading.textContent = 'Step Validated Successfully!';
      if (subtext) subtext.textContent = 'All assertion criteria passed. Apigee policies executed correctly.';
      if (nextPrompt) nextPrompt.style.display = 'flex';
    } else {
      if (banner) banner.className = 'validation-status-banner failed';
      if (icon) icon.textContent = '✗';
      if (heading) heading.textContent = 'Validation Failed';
      if (subtext) subtext.textContent = result.error || 'One or more assertions did not match the expected runtime behavior.';
      if (nextPrompt) nextPrompt.style.display = 'none';
    }

    // Assertions Checklist
    if (assertionsList && result.assertions) {
      assertionsList.innerHTML = '';
      let passedCount = 0;
      for (const a of result.assertions) {
        if (a.passed) passedCount++;
        const item = document.createElement('div');
        item.className = `assertion-item ${a.passed ? 'passed' : 'failed'}`;
        item.innerHTML = `
          <div>
            <code>${a.assertion}</code>
            ${a.error ? `<div style="color: var(--danger); font-size: 11px;">${a.error}</div>` : ''}
          </div>
          <span class="assertion-state-badge ${a.passed ? 'pass' : 'fail'}">${a.passed ? 'PASS' : 'FAIL'}</span>
        `;
        assertionsList.appendChild(item);
      }
      if (assertionsCount) {
        assertionsCount.textContent = `${passedCount} / ${result.assertions.length} Passed`;
      }
    }

    // Response Body
    if (responsePill) {
      responsePill.textContent = `${result.statusCode || 200} ${result.statusText || 'OK'}`;
      responsePill.className = `response-status-badge ${result.passed ? 'text-success' : 'text-danger'}`;
    }

    if (responseCode) {
      let formatted = result.responseData;
      if (typeof formatted === 'object') {
        formatted = JSON.stringify(formatted, null, 2);
      } else if (typeof formatted === 'string') {
        try {
          formatted = JSON.stringify(JSON.parse(formatted), null, 2);
        } catch {
          // keep as string
        }
      }
      responseCode.querySelector('code').textContent = formatted || '(Empty Response)';
    }

    // Headers Table
    if (headersTableBody && result.headers) {
      headersTableBody.innerHTML = '';
      const entries = Object.entries(result.headers);
      if (headerCountBadge) headerCountBadge.textContent = entries.length;

      for (const [key, val] of entries) {
        const lowerKey = key.toLowerCase();
        const role = HEADER_DESCRIPTIONS[lowerKey] || 'Standard HTTP transport header';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${key}</td>
          <td>${val}</td>
          <td>${role}</td>
        `;
        headersTableBody.appendChild(tr);
      }
    }

    // Trace Information
    if (traceSessionId) {
      traceSessionId.textContent = result.traceSessionId || 'Captured inline';
    }

    if (downloadTraceBtn && result.traceData) {
      downloadTraceBtn.style.display = 'inline-flex';
      downloadTraceBtn.onclick = () => {
        const blob = new Blob([JSON.stringify(result.traceData, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `apigee_trace_${test.name}.json`;
        a.click();
      };
    }

    if (traceRawContainer && result.traceData) {
      traceRawContainer.style.display = 'block';
      if (traceRawCode) {
        traceRawCode.textContent = JSON.stringify(result.traceData, null, 2);
      }
    }
  }

  // Execute Test Request with User's Provisioned Key
  async function runCurrentTest() {
    const test = state.tests[state.currentStepIndex];
    if (!test) return;

    if (!state.participant) {
      promptOnboarding(true);
      return;
    }

    const currentKey = state.participant.consumerKey;
    const btnRun = document.getElementById('btn-run-test');
    const btnRunText = document.getElementById('btn-run-text');
    const banner = document.getElementById('validation-banner');
    const icon = document.getElementById('validation-icon');
    const heading = document.getElementById('validation-heading');
    const subtext = document.getElementById('validation-subtext');

    if (btnRun) btnRun.disabled = true;
    if (btnRunText) btnRunText.textContent = 'Executing...';

    if (banner) banner.className = 'validation-status-banner running';
    if (icon) icon.textContent = '⚡';
    if (heading) heading.textContent = 'Executing via Apigee Emulator...';
    if (subtext) subtext.textContent = `Evaluating Cassandra credentials (${currentKey}) and upstream model response.`;

    let headers = { ...(test.headers || {}) };
    if (headers['x-api-key']) headers['x-api-key'] = currentKey;
    let body = test.body;

    if (state.editMode) {
      try {
        const editH = document.getElementById('edit-req-headers').value;
        if (editH) headers = JSON.parse(editH);
      } catch {
        showToast('Invalid JSON in custom headers', 'danger');
        if (btnRun) btnRun.disabled = false;
        if (btnRunText) btnRunText.textContent = 'Run Test & Trace';
        return;
      }
      body = document.getElementById('edit-req-body').value;
    }

    const payload = {
      testName: test.name,
      proxy: test.proxy,
      method: test.verb || test.method || 'POST',
      path: test.path,
      headers: headers,
      body: body,
      recordTrace: true,
      assertions: test.assertions && test.assertions.length > 0 ? test.assertions : ['response.status == 200'],
    };

    try {
      const resp = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await resp.json();

      const resultObj = {
        passed: Boolean(data.passed),
        statusCode: data.statusCode || resp.status,
        statusText: data.statusText || 'OK',
        durationMs: data.durationMs || 0,
        targetLatencyMs: data.targetLatencyMs || Math.round((data.durationMs || 0) * 0.9),
        assertions: data.assertions || [],
        responseData: data.body || data,
        headers: data.headers || {},
        traceSessionId: data.traceSessionId,
        traceData: data.traceData,
        error: data.error,
        usage: data.usage || null,
      };

      state.testResults[test.name] = resultObj;
      saveProgress();

      renderExecutionResult(resultObj);
      updateOverallProgress();

      if (resultObj.passed) {
        showToast(`✓ Step ${state.currentStepIndex + 1} (${test.name}) Validated!`, 'success');
      } else {
        showToast(`Validation failed for ${test.name}`, 'warning');
      }
    } catch (err) {
      const errObj = {
        passed: false,
        statusCode: 500,
        statusText: 'Network / Emulator Error',
        durationMs: 0,
        assertions: [],
        responseData: String(err),
        headers: {},
        error: String(err),
      };
      state.testResults[test.name] = errObj;
      saveProgress();
      renderExecutionResult(errObj);
      updateOverallProgress();
      showToast('Error connecting to emulator service', 'danger');
    } finally {
      if (btnRun) btnRun.disabled = false;
      if (btnRunText) btnRunText.textContent = 'Run Test & Trace';
    }
  }

  // Copy helpers
  function setupCopyButtons() {
    const copyTestYamlBtn = document.getElementById('btn-copy-test-yaml');
    if (copyTestYamlBtn) {
      copyTestYamlBtn.onclick = () => {
        const text = document.getElementById('test-yaml-code')?.querySelector('code')?.textContent || '';
        navigator.clipboard.writeText(text);
        showToast('Test YAML copied to clipboard!', 'info');
      };
    }

    const copyProxyYamlBtn = document.getElementById('btn-copy-proxy-yaml');
    if (copyProxyYamlBtn) {
      copyProxyYamlBtn.onclick = () => {
        const text = document.getElementById('proxy-yaml-code')?.querySelector('code')?.textContent || '';
        navigator.clipboard.writeText(text);
        showToast('Proxy YAML copied to clipboard!', 'info');
      };
    }

    const copyResponseBtn = document.getElementById('btn-copy-response');
    if (copyResponseBtn) {
      copyResponseBtn.onclick = () => {
        const text = document.getElementById('response-body-code')?.querySelector('code')?.textContent || '';
        navigator.clipboard.writeText(text);
        showToast('Response JSON copied to clipboard!', 'info');
      };
    }
  }

  // Setup Tabs in Left and Right Panes
  function setupTabs() {
    const leftTabs = document.querySelectorAll('.pane-nav-tab');
    leftTabs.forEach((tab) => {
      tab.onclick = () => {
        leftTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        document.querySelectorAll('.pane-scroll-content > .pane-tab-view').forEach((v) => {
          v.classList.remove('active');
        });
        const view = document.getElementById(`view-${target}`);
        if (view) view.classList.add('active');
      };
    });

    const rightTabs = document.querySelectorAll('.result-tab');
    rightTabs.forEach((tab) => {
      tab.onclick = () => {
        rightTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.rtab;
        document.querySelectorAll('.result-tab-view').forEach((v) => {
          v.classList.remove('active');
        });
        const view = document.getElementById(`view-result-${target}`);
        if (view) view.classList.add('active');
      };
    });
  }

  // Setup Theme Toggle
  function setupTheme() {
    const btn = document.getElementById('btn-theme-toggle');
    const saved = localStorage.getItem('apigee_lab_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);

    if (btn) {
      btn.onclick = () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('apigee_lab_theme', next);
      };
    }
  }

  // Setup Event Listeners
  function setupEvents() {
    const btnRun = document.getElementById('btn-run-test');
    if (btnRun) btnRun.onclick = runCurrentTest;

    const btnEditToggle = document.getElementById('btn-toggle-edit-mode');
    if (btnEditToggle) btnEditToggle.onclick = toggleEditMode;

    const btnResetEdit = document.getElementById('btn-reset-req-edit');
    if (btnResetEdit) btnResetEdit.onclick = resetEditRequest;

    const btnPrev = document.getElementById('btn-prev-test');
    if (btnPrev) btnPrev.onclick = () => selectStep(state.currentStepIndex - 1);

    const btnNext = document.getElementById('btn-next-test');
    if (btnNext) btnNext.onclick = () => selectStep(state.currentStepIndex + 1);

    const btnContinue = document.getElementById('btn-continue-next');
    if (btnContinue) btnContinue.onclick = () => selectStep(state.currentStepIndex + 1);

    // Onboarding Form & Close
    const onboardingForm = document.getElementById('form-onboarding');
    if (onboardingForm) onboardingForm.onsubmit = handleOnboardingSubmit;

    const btnCloseOnboarding = document.getElementById('btn-close-onboarding');
    if (btnCloseOnboarding) btnCloseOnboarding.onclick = closeOnboarding;

    // Participant Chip click
    const chip = document.getElementById('participant-chip');
    if (chip) {
      chip.onclick = () => {
        if (state.participant) openParticipantProfile();
        else promptOnboarding(true);
      };
    }

    // Participant Profile Modal
    const btnCloseProfile = document.getElementById('btn-close-profile-modal');
    if (btnCloseProfile) btnCloseProfile.onclick = closeParticipantProfile;

    const btnCopyProfileKey = document.getElementById('btn-copy-profile-key');
    if (btnCopyProfileKey) {
      btnCopyProfileKey.onclick = () => {
        if (state.participant?.consumerKey) {
          navigator.clipboard.writeText(state.participant.consumerKey);
          showToast('API Key copied to clipboard!', 'info');
        }
      };
    }

    const btnOpenDelAccount = document.getElementById('btn-open-delete-account');
    if (btnOpenDelAccount) btnOpenDelAccount.onclick = openDeleteConfirm;

    const btnSwitchAccount = document.getElementById('btn-switch-account');
    if (btnSwitchAccount) {
      btnSwitchAccount.onclick = () => {
        closeParticipantProfile();
        promptOnboarding(true);
      };
    }

    // Delete Account Confirmation Modal
    const btnCloseDelModal = document.getElementById('btn-close-delete-modal');
    if (btnCloseDelModal) btnCloseDelModal.onclick = closeDeleteConfirm;

    const btnCancelDelModal = document.getElementById('btn-cancel-delete');
    if (btnCancelDelModal) btnCancelDelModal.onclick = closeDeleteConfirm;

    const btnConfirmDelModal = document.getElementById('btn-confirm-delete');
    if (btnConfirmDelModal) btnConfirmDelModal.onclick = handleAccountDelete;

    // Leaderboard Modal Triggers
    const btnOpenLb = document.getElementById('btn-open-leaderboard');
    if (btnOpenLb) btnOpenLb.onclick = openLeaderboard;

    const btnCloseLb = document.getElementById('btn-close-leaderboard');
    if (btnCloseLb) btnCloseLb.onclick = closeLeaderboard;

    const btnCloseLbFooter = document.getElementById('btn-close-leaderboard-footer');
    if (btnCloseLbFooter) btnCloseLbFooter.onclick = closeLeaderboard;

    const btnRefreshLb = document.getElementById('btn-refresh-leaderboard');
    if (btnRefreshLb) btnRefreshLb.onclick = refreshLeaderboard;

    // Reset Labs Triggers
    const btnResetLabs = document.getElementById('btn-reset-labs');
    if (btnResetLabs) btnResetLabs.onclick = openResetModal;

    const btnCloseResetModal = document.getElementById('btn-close-reset-modal');
    if (btnCloseResetModal) btnCloseResetModal.onclick = closeResetModal;

    const btnCancelReset = document.getElementById('btn-cancel-reset');
    if (btnCancelReset) btnCancelReset.onclick = closeResetModal;

    const btnConfirmReset = document.getElementById('btn-confirm-reset');
    if (btnConfirmReset) btnConfirmReset.onclick = handleResetConfirm;
  }

  // Initialize Application
  async function init() {
    setupTheme();
    setupTabs();
    setupCopyButtons();
    setupEvents();
    loadSavedState();

    try {
      const resp = await fetch('/api/tests');
      const tests = await resp.json();
      if (Array.isArray(tests) && tests.length > 0) {
        state.tests = tests;
        renderStepperRibbon();
        selectStep(0);
      } else {
        showToast('No deployment tests loaded from server', 'warning');
      }
    } catch {
      showToast('Error loading deployment tests from /api/tests', 'danger');
    }

    // Prompt participant onboarding if first visit
    if (!state.participant) {
      setTimeout(() => promptOnboarding(false), 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
