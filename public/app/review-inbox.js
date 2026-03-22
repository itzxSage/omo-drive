function createTag(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function formatLabel(value) {
  if (!value) {
    return 'Unknown';
  }

  return String(value)
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatActionLabel(action) {
  if (action === 'approve') {
    return 'Approve';
  }
  if (action === 'continue') {
    return 'Continue';
  }
  return 'Snooze';
}

function badgeClass(status) {
  return `review-badge review-badge-${String(status || 'unknown').replace(/_/g, '-')}`;
}

function readPrimaryHandoff(detail) {
  return detail.primaryHandoff || detail.handoffs[0] || null;
}

export function createReviewInbox(elements, state, trustBoot) {
  let inboxItems = [];
  let selectedReviewId = null;
  let selectedDetail = null;

  function setStatusCopy(text) {
    elements.reviewStatusCopy.textContent = text;
  }

  function setCountText(text) {
    elements.reviewCount.textContent = text;
  }

  function setLoading(isLoading) {
    elements.reviewRefresh.disabled = isLoading;
    const actionButtons = elements.reviewActions.querySelectorAll('button');
    actionButtons.forEach((button) => {
      button.disabled = isLoading;
    });
  }

  function showListView() {
    selectedReviewId = null;
    selectedDetail = null;
    elements.reviewBack.hidden = true;
    elements.reviewListView.hidden = false;
    elements.reviewDetailView.hidden = true;
    renderInbox();
  }

  function showDetailView() {
    elements.reviewBack.hidden = false;
    elements.reviewListView.hidden = true;
    elements.reviewDetailView.hidden = false;
  }

  function openOverlay() {
    elements.reviewOverlay.classList.add('visible');
    void refreshInbox();
  }

  function closeOverlay() {
    elements.reviewOverlay.classList.remove('visible');
    showListView();
  }

  function renderInbox() {
    elements.reviewList.replaceChildren();

    if (inboxItems.length === 0) {
      elements.reviewEmpty.hidden = false;
      setCountText('No items');
      return;
    }

    elements.reviewEmpty.hidden = true;
    setCountText(`${inboxItems.length} item${inboxItems.length === 1 ? '' : 's'}`);

    for (const item of inboxItems) {
      const card = createTag('button', 'review-card review-list-card');
      card.type = 'button';
      card.dataset.reviewId = item.reviewItem.reviewItemId;

      const topRow = createTag('div', 'review-card-top');
      topRow.append(
        createTag('span', badgeClass(item.subject.status), formatLabel(item.subject.status)),
        createTag('span', 'review-card-time', formatLabel(item.reviewItem.status))
      );

      const title = createTag('h3', 'review-card-title', item.reviewItem.title);
      const summary = createTag('p', 'review-card-summary', item.voicemail.textSummary);

      const footer = createTag('div', 'review-card-footer');
      footer.append(
        createTag('span', 'review-card-context', formatLabel(item.subject.type)),
        createTag('span', 'review-card-context', item.availableActions.map(formatActionLabel).join(' / '))
      );

      card.append(topRow, title, summary, footer);
      elements.reviewList.append(card);
    }
  }

  function renderContext(detail) {
    elements.reviewDetailContext.replaceChildren();
    const primaryHandoff = readPrimaryHandoff(detail);
    const nextAction = primaryHandoff?.package?.nextActions?.[0] || null;

    const fragments = [
      ['Subject', `${formatLabel(detail.subject.type)} ${detail.subject.id}`],
      ['Work Status', formatLabel(detail.subject.status)],
    ];

    if (detail.linkedContext.opencodeRefs?.sessionId) {
      fragments.push(['Session', detail.linkedContext.opencodeRefs.sessionId]);
    }

    if (detail.linkedContext.opencodeRefs?.messageId) {
      fragments.push(['Message', detail.linkedContext.opencodeRefs.messageId]);
    }

    if (primaryHandoff) {
      const handoff = primaryHandoff;
      fragments.push(['Handoff', handoff.summary || `${handoff.toType} ${handoff.toId}`]);
      if (handoff.path) {
        fragments.push(['Package Path', handoff.path]);
      }
    }

    if (nextAction) {
      fragments.push(['Next Step', nextAction]);
    }

    if (detail.linkedContext.handoffPath) {
      fragments.push(['Audit Trail', detail.linkedContext.handoffPath]);
    }

    for (const [label, value] of fragments) {
      const row = createTag('div', 'review-context-row');
      row.append(
        createTag('span', 'review-context-label', label),
        createTag('span', 'review-context-value', value)
      );
      elements.reviewDetailContext.append(row);
    }
  }

  function renderTimeline(detail) {
    elements.reviewDetailTimeline.replaceChildren();
    const timeline = Array.isArray(detail.timeline) ? detail.timeline : detail.auditEvents;

    if (!timeline.length) {
      elements.reviewDetailTimeline.append(createTag('p', 'review-timeline-empty', 'No review timeline yet.'));
      return;
    }

    for (const event of timeline) {
      const item = createTag('div', 'review-timeline-item');
      const status = event.status || event.metadata?.status || 'updated';
      const title = event.title || formatLabel(event.action);
      const detailCopy = event.detail || `${formatLabel(event.entityType || 'review item')} ${event.entityId || ''}`.trim();
      item.append(
        createTag('span', 'review-timeline-event', title),
        createTag('span', 'review-timeline-status', formatLabel(status)),
        createTag('span', 'review-timeline-copy', detailCopy)
      );
      elements.reviewDetailTimeline.append(item);
    }
  }

  function renderActions(detail) {
    elements.reviewActions.replaceChildren();

    for (const action of detail.availableActions) {
      const button = createTag('button', 'review-action-btn');
      button.type = 'button';
      button.dataset.action = action;
      button.textContent = formatActionLabel(action);
      if (action === 'continue' || action === 'approve') {
        button.classList.add('is-primary');
      }
      elements.reviewActions.append(button);
    }
  }

  function renderDetail() {
    if (!selectedDetail) {
      return;
    }

    showDetailView();
    setCountText(formatLabel(selectedDetail.reviewItem.status));
    setStatusCopy('Review what happened, then choose the next step.');
    elements.reviewDetailStatus.className = badgeClass(selectedDetail.subject.status);
    elements.reviewDetailStatus.textContent = formatLabel(selectedDetail.subject.status);
    elements.reviewDetailTitle.textContent = selectedDetail.reviewItem.title;
    elements.reviewDetailSummary.textContent = selectedDetail.voicemail.textSummary;
    elements.reviewDetailTranscript.textContent = selectedDetail.voicemail.transcriptText || 'No voicemail transcript yet.';
    renderContext(selectedDetail);
    renderTimeline(selectedDetail);
    renderActions(selectedDetail);
  }

  function syncInboxItem(updatedReviewItem) {
    inboxItems = inboxItems.map((item) => {
      if (item.reviewItem.reviewItemId !== updatedReviewItem.reviewItemId) {
        return item;
      }

      return {
        ...item,
        reviewItem: updatedReviewItem,
      };
    });
  }

  async function ensureTrusted() {
    const trustStatus = await trustBoot.fetchTrustStatus();
    if (!trustStatus.trusted) {
      inboxItems = [];
      elements.reviewList.replaceChildren();
      elements.reviewActions.replaceChildren();
      elements.reviewEmpty.hidden = false;
      setCountText('Pair required');
      setStatusCopy('Pair this device to open review and voicemail items.');
      showListView();
      return false;
    }

    return true;
  }

  async function refreshInbox(options = {}) {
    if (!(await ensureTrusted())) {
      return;
    }

    setLoading(true);
    setStatusCopy('Loading review items...');

    try {
      const response = await fetch('/api/product/review/items?limit=12', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Review inbox failed to load');
      }

      const body = await response.json();
      inboxItems = Array.isArray(body.items) ? body.items : [];
      renderInbox();

      if (options.keepSelection && selectedReviewId) {
        await openReviewItem(selectedReviewId, { skipStatusTransition: true });
        return;
      }

      setStatusCopy(inboxItems.length > 0 ? 'Blocked and completed work waits here.' : 'No review or voicemail items yet.');
    } catch (error) {
      state.showError(error instanceof Error ? error.message : String(error));
      setStatusCopy('Unable to load review inbox right now.');
    } finally {
      setLoading(false);
    }
  }

  async function openReviewItem(reviewItemId, options = {}) {
    if (!(await ensureTrusted())) {
      return;
    }

    selectedReviewId = reviewItemId;
    setLoading(true);

    try {
      const currentItem = inboxItems.find((item) => item.reviewItem.reviewItemId === reviewItemId);
      const currentStatus = currentItem?.reviewItem?.status;

      if (!options.skipStatusTransition && (currentStatus === 'pending_review' || currentStatus === 'snoozed')) {
        const openResponse = await fetch(`/api/product/review/items/${reviewItemId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'in_review' })
        });

        if (!openResponse.ok) {
          throw new Error('Review item failed to open');
        }

        const openBody = await openResponse.json();
        syncInboxItem(openBody.reviewItem);
      }

      const response = await fetch(`/api/product/review/items/${reviewItemId}/detail`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Review detail failed to load');
      }

      const body = await response.json();
      selectedDetail = body.detail;
      renderInbox();
      renderDetail();
    } catch (error) {
      state.showError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(action) {
    if (!selectedDetail) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`/api/product/review/items/${selectedDetail.reviewItem.reviewItemId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });

      if (!response.ok) {
        throw new Error('Review action failed');
      }

      const body = await response.json();
      if (body.reviewItem) {
        syncInboxItem(body.reviewItem);
      }
      if (body.detail) {
        selectedDetail = body.detail;
      }

      setStatusCopy(action === 'snooze' ? 'Item snoozed for later.' : 'Decision saved to the product layer.');
      await refreshInbox({ keepSelection: true });
    } catch (error) {
      state.showError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  elements.reviewList.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const card = target.closest('[data-review-id]');
    if (!(card instanceof HTMLElement)) {
      return;
    }

    void openReviewItem(card.dataset.reviewId);
  });

  elements.reviewActions.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest('[data-action]');
    if (!(button instanceof HTMLElement)) {
      return;
    }

    void handleAction(button.dataset.action);
  });

  return {
    openOverlay,
    closeOverlay,
    showListView,
    refreshInbox,
  };
}
