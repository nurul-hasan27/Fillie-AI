import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FillieOverlay } from '../../src/content/overlay';

describe('FillieOverlay floating window', () => {
  let overlay: FillieOverlay;

  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    overlay = new FillieOverlay({
      onStart: () => {},
      onFillNow: () => {},
      onOpenQuestion: () => {},
      onBackFromResolve: () => {},
      onGenerate: () => {},
      onAccept: () => {},
      onSkip: () => {},
      onRegenerate: () => {},
      onFocusField: () => {},
      onOpenSettings: () => {},
      onDismiss: () => {},
      onMinimise: () => {},
    });
  });

  afterEach(() => {
    overlay.unmount();
    document.querySelectorAll('[data-fillie="ui"]').forEach((el) => el.remove());
  });

  it('mounts with fixed positioning so it does not scroll with page', () => {
    overlay.mount();
    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    expect(host).not.toBeNull();
    expect(host?.style.position).toBe('fixed');
    expect(host?.style.bottom).toBe('20px');
    expect(host?.style.right).toBe('20px');
    expect(host?.style.zIndex).toBe('2147483600');
  });

  it('mounts with default light theme background', () => {
    overlay.mount();
    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    expect(host).not.toBeNull();
    expect(host?.getAttribute('data-theme')).toBe('light');
  });

  it('contains shadow root with .panel element inside', () => {
    overlay.mount();
    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    expect(host?.shadowRoot).not.toBeNull();
    const panel = host?.shadowRoot?.querySelector('.panel');
    expect(panel).not.toBeNull();
  });

  it('renders a minimize button when expanded and hides body when minimized', async () => {
    let minimizedTriggered = false;
    overlay = new FillieOverlay({
      onStart: () => {},
      onFillNow: () => {},
      onOpenQuestion: () => {},
      onBackFromResolve: () => {},
      onGenerate: () => {},
      onAccept: () => {},
      onSkip: () => {},
      onRegenerate: () => {},
      onFocusField: () => {},
      onOpenSettings: () => {},
      onDismiss: () => {},
      onMinimise: () => {
        minimizedTriggered = true;
      },
    });

    overlay.mount();
    overlay.render({ kind: 'idle' });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();

    // In expanded state:
    expect(overlay.isCollapsed()).toBe(false);
    const minimizeBtn = shadow?.querySelector<HTMLButtonElement>('button[aria-label="Minimize Fillie"]');
    expect(minimizeBtn).not.toBeNull();
    expect(shadow?.querySelector('.body')).not.toBeNull();

    // Click minimize button
    minimizeBtn?.click();
    await Promise.resolve();

    expect(minimizedTriggered).toBe(true);
    expect(overlay.isCollapsed()).toBe(true);
    const panel = shadow?.querySelector('.panel');
    expect(panel?.getAttribute('data-collapsed')).toBe('true');
    expect(shadow?.querySelector('.body')).toBeNull();

    // Now in collapsed state, a maximize button should exist
    const maximizeBtn = shadow?.querySelector<HTMLButtonElement>('button[aria-label="Maximize Fillie"]');
    expect(maximizeBtn).not.toBeNull();
  });

  it('clicking maximize button or collapsed header restores the expanded panel', async () => {
    overlay.mount();
    overlay.render({ kind: 'idle' });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;

    // Minimize via setCollapsed
    overlay.setCollapsed(true);
    await Promise.resolve();
    expect(overlay.isCollapsed()).toBe(true);
    expect(shadow?.querySelector('.body')).toBeNull();

    // Maximize via clicking maximize button
    const maximizeBtn = shadow?.querySelector<HTMLButtonElement>('button[aria-label="Maximize Fillie"]');
    expect(maximizeBtn).not.toBeNull();
    maximizeBtn?.click();
    await Promise.resolve();

    expect(overlay.isCollapsed()).toBe(false);
    expect(shadow?.querySelector('.body')).not.toBeNull();
    expect(shadow?.querySelector('button[aria-label="Minimize Fillie"]')).not.toBeNull();

    // Minimize again
    overlay.setCollapsed(true);
    await Promise.resolve();

    // Click header (outside of buttons) to expand
    const head = shadow?.querySelector<HTMLElement>('.head');
    expect(head).not.toBeNull();
    head?.click();
    await Promise.resolve();

    expect(overlay.isCollapsed()).toBe(false);
    expect(shadow?.querySelector('.body')).not.toBeNull();
  });

  it('renders clickable stats and filter tabs that filter tasks and review rows', async () => {
    let openedQuestion: any = null;
    let openedEdit: any = null;
    overlay = new FillieOverlay({
      onStart: () => {},
      onFillNow: () => {},
      onOpenQuestion: (plan) => {
        openedQuestion = plan;
      },
      onBackFromResolve: () => {},
      onGenerate: () => {},
      onAccept: () => {},
      onSkip: () => {},
      onRegenerate: () => {},
      onFocusField: () => {},
      onOpenSettings: () => {},
      onDismiss: () => {},
      onMinimise: () => {},
      onOpenEdit: (plan) => {
        openedEdit = plan;
      },
    });

    overlay.mount();
    const plan1: any = {
      field: { id: 'f1', kind: 'text', label: 'Full Name', required: true, disabled: false, visible: true, source: 'native', fingerprint: 'fp1' },
      status: 'ready',
      source: 'profile',
      answer: 'Ada Lovelace',
      confidence: 1.0,
      sources: [],
    };
    const plan2: any = {
      field: { id: 'f2', kind: 'textarea', label: 'Why this role?', required: true, disabled: false, visible: true, source: 'native', fingerprint: 'fp2' },
      status: 'needs-attention',
      confidence: 0,
      sources: [],
      interview: {
        reason: 'Fillie needs details',
        questions: [{ id: 'q1', label: 'What excites you?', type: 'text', required: true }],
      },
    };

    overlay.render({
      kind: 'tasks',
      plans: [plan1, plan2],
      stats: { total: 2, filledFromProfile: 1, filledFromMemory: 0, generated: 0, fromUser: 0, needsAttention: 1, manual: 0, skipped: 0, verified: 1 },
    });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;

    // 3 summary stats with role="button"
    const stats = shadow?.querySelectorAll('.stat');
    expect(stats?.length).toBe(3);
    expect(stats?.[0].getAttribute('role')).toBe('button');
    expect(stats?.[1].getAttribute('role')).toBe('button');
    expect(stats?.[2].getAttribute('role')).toBe('button');

    // 5 filter tabs: All, Answered, Doubtful, Need attention, Unanswered
    const tabs = shadow?.querySelectorAll('.filter-tab-btn');
    expect(tabs?.length).toBe(5);

    // Initial 'all' view shows both needs attention and filled automatically
    expect(shadow?.querySelector('.tasks')).not.toBeNull();
    expect(shadow?.querySelector('.review-list')).not.toBeNull();

    // Click "Answered" tab
    const answeredTab = shadow?.querySelector<HTMLButtonElement>('.filter-tab-btn[data-filter="answered"]');
    answeredTab?.click();
    await Promise.resolve();

    expect(overlay.getFilter()).toBe('answered');
    expect(shadow?.querySelector('.inbox-title')?.textContent).toBe('Answered questions');
    expect(shadow?.querySelectorAll('.review-row').length).toBe(1);

    // Test copy button on review row
    const copyBtn = shadow?.querySelector<HTMLButtonElement>('.review-copy-btn[data-fillie-copy="f1"]');
    expect(copyBtn).not.toBeNull();
    copyBtn?.click();
    expect(copyBtn?.classList.contains('copied')).toBe(true);

    // Click pencil edit button
    const editBtn = shadow?.querySelector<HTMLButtonElement>('.review-edit-btn[data-fillie-edit="f1"]');
    expect(editBtn).not.toBeNull();
    editBtn?.click();
    expect(openedEdit).toBe(plan1);

    // Click "Need attention" stat
    const attentionStat = shadow?.querySelectorAll<HTMLElement>('.stat')?.[1];
    attentionStat?.click();
    await Promise.resolve();

    expect(overlay.getFilter()).toBe('needs-attention');
    expect(shadow?.querySelector('.inbox-title')?.textContent).toBe('Needs your attention');
    const taskBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-task="f2"]');
    expect(taskBtn).not.toBeNull();
    taskBtn?.click();
    expect(openedQuestion).toBe(plan2);
  });

  it('renders edit drawer with input, Yes/No buttons, copy button, and calls onEdit on save', async () => {
    let editedPlan: any = null;
    let editedValue = '';
    let editedSave = false;

    overlay = new FillieOverlay({
      onStart: () => {},
      onFillNow: () => {},
      onOpenQuestion: () => {},
      onBackFromResolve: () => {},
      onGenerate: () => {},
      onAccept: () => {},
      onSkip: () => {},
      onRegenerate: () => {},
      onFocusField: () => {},
      onOpenSettings: () => {},
      onDismiss: () => {},
      onMinimise: () => {},
      onEdit: (plan, val, save) => {
        editedPlan = plan;
        editedValue = val;
        editedSave = save;
      },
    });

    overlay.mount();
    const plan: any = {
      field: { id: 'f1', kind: 'text', label: 'Full Name', required: true, disabled: false, visible: true, source: 'native', fingerprint: 'fp1' },
      status: 'ready',
      answer: 'Ada Lovelace',
      confidence: 1.0,
      sources: [],
    };

    overlay.render({ kind: 'edit', plan });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;

    // Test copy button in edit drawer
    const copyEditBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-copy-edit="f1"]');
    expect(copyEditBtn).not.toBeNull();
    copyEditBtn?.click();
    expect(copyEditBtn?.classList.contains('copied')).toBe(true);

    const input = shadow?.querySelector<HTMLInputElement>('[data-fillie-edit-input="f1"]');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Ada Lovelace');
    if (input) input.value = 'Ada King';

    const yesBtn = shadow?.querySelector<HTMLButtonElement>('[data-save-fillie="yes"]');
    const noBtn = shadow?.querySelector<HTMLButtonElement>('[data-save-fillie="no"]');
    expect(yesBtn).not.toBeNull();
    expect(noBtn).not.toBeNull();
    expect(yesBtn?.classList.contains('active')).toBe(true);

    // Switch to "No, this form only"
    noBtn?.click();
    expect(noBtn?.classList.contains('active')).toBe(true);
    expect(yesBtn?.classList.contains('active')).toBe(false);

    // Save
    const saveBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-save-edit="f1"]');
    saveBtn?.click();

    expect(editedPlan).toBe(plan);
    expect(editedValue).toBe('Ada King');
    expect(editedSave).toBe(false);
  });

  it('renders interview drawer with additional notes and skip button', async () => {
    let skipped = false;
    let generatedAnswers: any = null;

    overlay = new FillieOverlay({
      onStart: () => {},
      onFillNow: () => {},
      onOpenQuestion: () => {},
      onBackFromResolve: () => {},
      onGenerate: (_plan, answers) => {
        generatedAnswers = answers;
      },
      onAccept: () => {},
      onSkip: () => {
        skipped = true;
      },
      onRegenerate: () => {},
      onFocusField: () => {},
      onOpenSettings: () => {},
      onDismiss: () => {},
      onMinimise: () => {},
    });

    overlay.mount();
    const plan: any = {
      field: { id: 'f2', kind: 'textarea', label: 'Describe a challenge', required: true, disabled: false, visible: true, source: 'native', fingerprint: 'fp2' },
      status: 'needs-attention',
      confidence: 0,
      sources: [],
      interview: {
        reason: 'Fillie needs details',
        questions: [{ id: 'q1', label: 'Which challenge?', type: 'text', required: true }],
      },
    };

    overlay.render({
      kind: 'resolve',
      plan,
      draft: { text: '', generating: false, sources: [], notes: [], generic: true, usedAI: false },
    });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;

    const extraNotes = shadow?.querySelector<HTMLTextAreaElement>('[data-fillie-extra-notes="f2"]');
    expect(extraNotes).not.toBeNull();

    const skipBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-skip-interview="f2"]');
    expect(skipBtn).not.toBeNull();
    skipBtn?.click();
    expect(skipped).toBe(true);

    // Test typing into extra notes enables generate button
    const generateBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-generate="f2"]');
    expect(generateBtn?.disabled).toBe(true);

    if (extraNotes) {
      extraNotes.value = 'Led backend migration to PostgreSQL';
      extraNotes.dispatchEvent(new Event('input'));
    }
    expect(generateBtn?.disabled).toBe(false);

    generateBtn?.click();
    expect(generatedAnswers?.['__extra_notes__']).toBe('Led backend migration to PostgreSQL');
  });

  it('renders Yes/No buttons and copy button in draft resolve state', async () => {
    let acceptedRemember = false;

    overlay = new FillieOverlay({
      onStart: () => {},
      onFillNow: () => {},
      onOpenQuestion: () => {},
      onBackFromResolve: () => {},
      onGenerate: () => {},
      onAccept: (_plan, _text, _generic, remember) => {
        acceptedRemember = remember;
      },
      onSkip: () => {},
      onRegenerate: () => {},
      onFocusField: () => {},
      onOpenSettings: () => {},
      onDismiss: () => {},
      onMinimise: () => {},
    });

    overlay.mount();
    const plan: any = {
      field: { id: 'f2', kind: 'textarea', label: 'Challenge', required: true, disabled: false, visible: true, source: 'native', fingerprint: 'fp2' },
      status: 'needs-attention',
      confidence: 0,
      sources: [],
    };

    overlay.render({
      kind: 'resolve',
      plan,
      draft: { text: 'Draft answer text', generating: false, sources: [], notes: [], generic: true, usedAI: true },
    });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;

    // Test copy button on draft
    const copyDraftBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-copy-draft="f2"]');
    expect(copyDraftBtn).not.toBeNull();
    copyDraftBtn?.click();
    expect(copyDraftBtn?.classList.contains('copied')).toBe(true);

    const rememberBox = shadow?.querySelector<HTMLInputElement>('[data-fillie-remember="f2"]');
    const yesBtn = shadow?.querySelector<HTMLButtonElement>('[data-save-fillie="yes"]');
    const noBtn = shadow?.querySelector<HTMLButtonElement>('[data-save-fillie="no"]');

    expect(rememberBox).not.toBeNull();
    expect(rememberBox?.checked).toBe(true);
    expect(yesBtn?.classList.contains('active')).toBe(true);

    // Click No button
    noBtn?.click();
    expect(rememberBox?.checked).toBe(false);
    expect(noBtn?.classList.contains('active')).toBe(true);
    expect(yesBtn?.classList.contains('active')).toBe(false);

    // Click accept
    const acceptBtn = shadow?.querySelector<HTMLButtonElement>('[data-fillie-accept="f2"]');
    acceptBtn?.click();
    expect(acceptedRemember).toBe(false);
  });

  it('renders scrollable answered questions list with review items when answered filter is selected', async () => {
    overlay.mount();
    const plans: any[] = Array.from({ length: 15 }, (_, i) => ({
      field: { id: `f${i}`, kind: 'text', label: `Question ${i + 1}`, required: false, disabled: false, visible: true, source: 'native', fingerprint: `fp${i}` },
      status: 'ready',
      answer: `Answer ${i + 1}`,
      confidence: 0.95,
      sources: [],
    }));

    overlay.render({
      kind: 'tasks',
      plans,
      stats: { total: 15, filledFromProfile: 15, filledFromMemory: 0, generated: 0, fromUser: 0, needsAttention: 0, manual: 0, skipped: 0, verified: 15 },
    });
    await Promise.resolve();

    const host = document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]');
    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();

    // Body is the scroll container
    const body = shadow?.querySelector<HTMLElement>('.body');
    expect(body).not.toBeNull();

    // Switch to answered tab
    overlay.setFilter('answered');
    await Promise.resolve();

    expect(shadow?.querySelector('.inbox-title')?.textContent).toBe('Answered questions');
    const countPill = shadow?.querySelector('.count-pill');
    expect(countPill?.textContent).toBe('15');

    const reviewItems = shadow?.querySelectorAll('.review-item');
    expect(reviewItems?.length).toBe(15);

    const reviewList = shadow?.querySelector('.review-list');
    expect(reviewList).not.toBeNull();
  });
});
