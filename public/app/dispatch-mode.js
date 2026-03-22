import { getModeTrustGuidance, normalizeTrustStatus } from './trust-boot.js';

const TRUSTED_EMPTY_COPY = 'No dispatch requests yet.';

function buildDispatchPayload(elements) {
  const inputSummary = elements.dispatchSummary.value.trim();
  const targetScope = elements.dispatchScope.value;
  const targetLabel = elements.dispatchTarget.value.trim();

  return {
    inputSummary,
    targetScope,
    targetId: targetLabel || (targetScope === 'active_repo' ? 'active_repo' : null),
    targetLabel: targetLabel || (targetScope === 'active_repo' ? 'Active repo' : null),
    followUpPolicy: elements.dispatchFollowUp.value,
    executionActionType: elements.dispatchAction.value,
  };
}

function createRequestCard(request) {
  const card = document.createElement('article');
  card.className = 'dispatch-card';

  const header = document.createElement('div');
  header.className = 'dispatch-card-header';

  const title = document.createElement('h3');
  title.className = 'dispatch-card-title';
  title.textContent = request.inputSummary || request.executionActionType || 'Dispatch request';

  const badge = document.createElement('span');
  badge.className = `dispatch-badge status-${request.status}`;
  badge.textContent = request.status.replaceAll('_', ' ');

  header.append(title, badge);

  const meta = document.createElement('p');
  meta.className = 'dispatch-card-meta';
  meta.textContent = `${request.targetLabel || request.targetId || 'Active repo'} | ${request.decision?.targetScope || 'unknown scope'} | ${request.followUpPolicy || 'no follow-up policy'}`;

  const details = document.createElement('p');
  details.className = 'dispatch-card-detail';
  details.textContent = buildOutcomeSummary(request);

  card.append(header, meta, details);
  return card;
}

function buildOutcomeSummary(request) {
  if (request.latestHandoff?.package?.summary) {
    return `${request.latestHandoff.package.summary} Next: ${request.latestHandoff.package.nextActions?.[0] || 'open the saved package'}`;
  }

  if (request.latestReviewItem) {
    return `Review item ${request.latestReviewItem.status.replaceAll('_', ' ')} for ${request.executionActionType || 'dispatch execution'}.`;
  }

  if (request.latestRun) {
    return `Latest run is ${request.latestRun.status.replaceAll('_', ' ')} for ${request.executionActionType || 'dispatch execution'}.`;
  }

  if (request.executionDecision?.actionClass === 'approval_required') {
    return 'Execution policy requires approval before completion.';
  }

  return 'Dispatch packet is queued with explicit policy context.';
}

async function parseResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || 'Request failed');
  }
  return body;
}

export function createDispatchMode(elements, state, speechOutput) {
  let trustStatus = normalizeTrustStatus({ trusted: false });

  function setStatus(text) {
    elements.dispatchStatus.textContent = text;
  }

  function setBusy(isBusy) {
    elements.dispatchSubmit.disabled = isBusy;
    elements.dispatchRefresh.disabled = isBusy;
  }

  function setBlockedControls() {
    elements.dispatchSubmit.disabled = true;
    elements.dispatchRefresh.disabled = false;
  }

  function renderPlaceholder(copy, className = 'dispatch-empty') {
    const placeholder = document.createElement('p');
    placeholder.className = className;
    placeholder.textContent = copy;
    elements.dispatchList.replaceChildren(placeholder);
  }

  function renderRequests(requests) {
    elements.dispatchList.replaceChildren();

    if (!requests.length) {
      renderPlaceholder(TRUSTED_EMPTY_COPY);
      return;
    }

    const fragment = document.createDocumentFragment();
    requests.forEach((request) => {
      fragment.append(createRequestCard(request));
    });
    elements.dispatchList.append(fragment);
  }

  function applyTrustState(nextTrustStatus) {
    trustStatus = normalizeTrustStatus(nextTrustStatus);

    if (trustStatus.trusted) {
      return;
    }

    const guidance = getModeTrustGuidance('dispatch', trustStatus);
    setBlockedControls();
    setStatus(guidance.status);
    renderPlaceholder(guidance.status, 'dispatch-empty dispatch-empty-blocked');
  }

  async function refreshRequests() {
    const response = await fetch('/api/product/dispatch/requests?limit=6', { cache: 'no-store' });
    const body = await parseResponse(response);
    renderRequests(body.requests || []);
    return body.requests || [];
  }

  async function submitDispatch() {
    const payload = buildDispatchPayload(elements);

    if (!payload.inputSummary) {
      state.showError('Enter a dispatch summary');
      return;
    }

    if (payload.targetScope === 'explicit_repo' && !payload.targetLabel) {
      state.showError('Enter an explicit repo target');
      return;
    }

    setBusy(true);

    try {
      setStatus('Creating dispatch request...');
      const createResponse = await fetch('/api/product/dispatch/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const created = await parseResponse(createResponse);

      setStatus('Dispatch request created. Executing...');
      const executeResponse = await fetch(`/api/product/dispatch/requests/${created.request.requestId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const executed = await parseResponse(executeResponse);

      await refreshRequests();

      if (executed.request.status === 'blocked') {
        setStatus('Dispatch blocked and saved for review.');
        speechOutput.speak('Dispatch blocked for review');
      } else {
        setStatus('Dispatch completed and saved.');
        speechOutput.speak('Dispatch completed');
      }
    } catch (err) {
      console.error('Dispatch error:', err);
      setStatus('Dispatch failed.');
      state.showError(`Dispatch failed: ${err.message}`);
    } finally {
      if (trustStatus.trusted) {
        setBusy(false);
      } else {
        setBlockedControls();
      }
    }
  }

  async function initialize(trustStatus) {
    applyTrustState(trustStatus);

    if (!normalizeTrustStatus(trustStatus).trusted) {
      return;
    }

    renderPlaceholder(TRUSTED_EMPTY_COPY);
    setStatus('Loading saved dispatch requests...');
    setBusy(true);

    try {
      const requests = await refreshRequests();
      setStatus(requests.length ? 'Showing persisted dispatch requests.' : 'Ready to create a dispatch request.');
    } catch (err) {
      setStatus('Dispatch history unavailable.');
    } finally {
      if (trustStatus.trusted) {
        setBusy(false);
      } else {
        setBlockedControls();
      }
    }
  }

  return {
    applyTrustState,
    initialize,
    refreshRequests,
    submitDispatch,
  };
}
