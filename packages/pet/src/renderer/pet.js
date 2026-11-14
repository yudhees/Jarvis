// Pet window script. It only displays events (already validated by the main
// process) and reports pointer activity. Event text is always set with
// textContent, never as HTML.
(() => {
  const api = window.jarvisPet;
  const $ = (id) => document.getElementById(id);
  const pet = $('pet');
  const ring = $('ring');
  const mouth = $('mouth');
  const held = $('held');
  const modelTag = $('modelTag');
  const bubble = $('bubble');
  const bubbleWho = $('bubbleWho');
  const bubbleText = $('bubbleText');
  const bubbleBadge = $('bubbleBadge');
  const bubbleSay = $('bubbleSay');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SVG = 'http://www.w3.org/2000/svg';
  /** Small icons the pet holds while a tool runs. Static shapes, no event data. */
  const ICONS = {
    jira: [
      ['rect', { x: -12, y: -12, width: 24, height: 24, rx: 6, fill: 'var(--accent)' }],
      [
        'path',
        {
          d: 'M-5 -4 h10 M-5 1 h10 M-5 6 h6',
          stroke: 'var(--accent-ink)',
          'stroke-width': 2,
          'stroke-linecap': 'round',
        },
      ],
    ],
    slack: [
      ['rect', { x: -12, y: -12, width: 24, height: 20, rx: 7, fill: 'var(--glow)' }],
      ['path', { d: 'M-6 8 l-3 6 l8 -6', fill: 'var(--glow)' }],
      ['circle', { cx: -4, cy: -2, r: 2, fill: 'var(--visor)' }],
      ['circle', { cx: 4, cy: -2, r: 2, fill: 'var(--visor)' }],
    ],
    web: [
      ['circle', { r: 12, fill: 'var(--glow)' }],
      [
        'path',
        {
          d: 'M-12 0 h24 M0 -12 c6 6 6 18 0 24 c-6 -6 -6 -18 0 -24',
          stroke: 'var(--visor)',
          'stroke-width': 1.6,
          fill: 'none',
        },
      ],
    ],
    db: [
      ['path', { d: 'M-11 -7 v14 a11 4 0 0 0 22 0 v-14', fill: '#1f9d6b' }],
      ['ellipse', { cx: 0, cy: -7, rx: 11, ry: 4, fill: '#3ccf91' }],
    ],
    github: [
      ['circle', { r: 12, fill: 'var(--ink)' }],
      [
        'path',
        {
          d: 'M-4 -3 v8 M4 -3 v8 M-4 1 h8',
          stroke: 'var(--bubble)',
          'stroke-width': 2,
          'stroke-linecap': 'round',
        },
      ],
    ],
    other: [
      ['circle', { r: 12, fill: 'var(--accent)' }],
      ['circle', { r: 4, fill: 'var(--accent-ink)' }],
    ],
  };

  function iconFor(tool) {
    const t = tool.toLowerCase();
    if (/jira|atlassian|confluence/.test(t)) return 'jira';
    if (/slack/.test(t)) return 'slack';
    if (/github/.test(t)) return 'github';
    if (/mongo|database|sql/.test(t)) return 'db';
    if (/browser|web|search|fetch/.test(t)) return 'web';
    return 'other';
  }

  function setHeld(tool) {
    held.replaceChildren();
    for (const [tag, attrs] of ICONS[iconFor(tool)]) {
      const el = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      held.append(el);
    }
  }

  // ---------- bubble ----------
  let hideTimer;
  let typeTimer;
  let approvalOpen = false;

  function showBubble(who, text, { badge, approval = false, typed = false } = {}) {
    clearTimeout(hideTimer);
    clearTimeout(typeTimer);
    bubbleWho.textContent = who;
    bubbleBadge.hidden = !badge;
    bubbleBadge.textContent = badge || '';
    bubble.classList.toggle('approval', approval);
    bubble.classList.remove('asking');
    bubbleSay.hidden = true;
    if (!asking) askForm.hidden = true;
    bubble.classList.remove('hidden');
    if (!typed || reducedMotion) {
      bubbleText.textContent = text;
      return;
    }
    let i = 0;
    const step = () => {
      i += 2;
      bubbleText.textContent = text.slice(0, i);
      if (i < text.length) typeTimer = setTimeout(step, 30);
    };
    step();
  }

  function hideBubble(after = 6000) {
    clearTimeout(hideTimer);
    // Approval text and open questions stay until answered (CLAUDE.md 11).
    if (approvalOpen || asking) return;
    hideTimer = setTimeout(() => bubble.classList.add('hidden'), after);
  }

  // ---------- questions: answer by clicking, typing, or just saying it ----------
  const askForm = $('ask');
  const choices = $('choices');
  const typed = $('typed');
  const answerInput = $('answer');
  let asking = null; // id of the open question

  function showQuestion(e) {
    asking = e.id;
    showBubble('Question', e.question);
    bubble.classList.add('asking');
    choices.replaceChildren();
    const isChoice = e.mode === 'choice';
    choices.hidden = !isChoice;
    typed.hidden = isChoice;
    if (isChoice) {
      for (const option of e.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = option;
        b.addEventListener('click', () => answer(option));
        choices.append(b);
      }
    } else {
      answerInput.value = '';
      answerInput.placeholder = e.placeholder || 'Type your answer';
    }
    askForm.hidden = false;
  }

  function closeQuestion() {
    asking = null;
    askForm.hidden = true;
    bubble.classList.remove('asking');
    hideBubble(1500);
  }

  function answer(value) {
    if (!asking || !value.trim()) return;
    const id = asking;
    closeQuestion();
    showBubble('You', value);
    hideBubble(4000);
    api.reply(id, value);
  }

  askForm.addEventListener('submit', (e) => {
    e.preventDefault();
    answer(answerInput.value);
  });
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('skip').click();
  });
  $('skip').addEventListener('click', () => {
    if (!asking) return;
    const id = asking;
    closeQuestion();
    api.cancelInput(id);
  });

  function showApproval(e) {
    approvalOpen = true;
    showBubble('Needs your OK', e.sentence, {
      badge: e.code ? 'tier 3' : 'tier 2',
      approval: true,
    });
    bubbleSay.replaceChildren();
    bubbleSay.append('✋ Say ');
    if (e.code) {
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = `confirm ${e.code.split('').join(' ')}`;
      bubbleSay.append(code);
    } else {
      const a = document.createElement('b');
      a.textContent = 'approve';
      const c = document.createElement('b');
      c.textContent = 'cancel';
      bubbleSay.append(a, ' or ', c);
    }
    bubbleSay.hidden = false;
  }

  // ---------- events ----------
  let model = '';

  function handle(e) {
    switch (e.type) {
      case 'state': {
        pet.dataset.state = e.state;
        if (e.state !== 'THINKING') pet.dataset.tool = 'off';
        if (e.state === 'SLEEPING' || e.state === 'MUTED')
          hideBubble(e.state === 'MUTED' ? 0 : 6000);
        if (e.state !== 'LISTENING') ring.style.transform = '';
        if (e.state !== 'SPEAKING') mouth.style.transform = '';
        if (e.state === 'ERROR')
          setTimeout(() => {
            if (pet.dataset.state === 'ERROR') pet.dataset.state = 'SLEEPING';
          }, 1800);
        break;
      }
      case 'mic_level':
        ring.style.transform = `scale(${1 + e.level * 0.12})`;
        break;
      case 'speak_level':
        mouth.style.transform = `scaleY(${1 + e.level * 2.6})`;
        break;
      case 'transcript_partial':
        showBubble('You', e.text);
        break;
      case 'transcript_final':
        showBubble('You', e.text);
        hideBubble(8000);
        break;
      case 'reply_text':
        showBubble('Jarvis', e.text, { badge: model, typed: true });
        hideBubble(6000 + e.text.length * 30);
        break;
      case 'tool_start':
        setHeld(e.tool);
        pet.dataset.tool = 'on';
        break;
      case 'tool_end':
        pet.dataset.tool = 'off';
        break;
      case 'approval_request':
        showApproval(e);
        break;
      case 'approval_result':
        approvalOpen = false;
        showBubble(
          'Jarvis',
          e.approved ? 'Approved. Doing it now.' : 'Cancelled. Nothing was changed.',
        );
        hideBubble(3000);
        break;
      case 'model_selected':
        model = e.model;
        modelTag.textContent = e.model.charAt(0).toUpperCase();
        break;
      case 'budget':
        pet.dataset.budget = e.usedFraction >= 0.8 ? 'warn' : 'ok';
        break;
      case 'error':
        showBubble('Jarvis', e.message);
        hideBubble(5000);
        break;
      case 'input_request':
        showQuestion(e);
        break;
      case 'input_closed':
        if (asking === e.id) closeQuestion();
        break;
    }
  }

  api.onEvent(handle);

  // Fade out before the window hides; fade in when it comes back.
  api.onVisibility((visible) => {
    document.body.classList.toggle('faded', !visible);
  });

  // ---------- click-through: only the pet and a visible bubble take the mouse ----------
  let interactive = false;
  function setInteractive(on) {
    if (on === interactive) return;
    interactive = on;
    api.setInteractive(on);
  }
  document.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const target = e.target instanceof Element ? e.target : null;
    setInteractive(!!target?.closest('.pet, .bubble:not(.hidden)'));
  });
  document.addEventListener('mouseleave', () => {
    if (!dragging) setInteractive(false);
  });

  // ---------- drag (main moves the window) and click ----------
  let dragging = false;
  let down = null;
  pet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.screenX, y: e.screenY, t: performance.now() };
    dragging = true;
    pet.classList.add('dragging');
    pet.setPointerCapture(e.pointerId);
    api.dragStart(e.clientX, e.clientY);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    pet.classList.remove('dragging');
    api.dragEnd();
    const moved = down && Math.hypot(e.screenX - down.x, e.screenY - down.y);
    if (down && moved < 4 && performance.now() - down.t < 400) api.clicked();
    down = null;
  };
  pet.addEventListener('pointerup', endDrag);
  pet.addEventListener('pointercancel', endDrag);
})();
