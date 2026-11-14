// Settings window script. Talks to the main process only through window.jarvisSettings;
// the main process validates everything it receives. Text is set with textContent only.
(() => {
  const api = window.jarvisSettings;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const HEX = /^#[0-9a-f]{6}$/;

  const ACCENTS = [
    ['Blue', '#2a6df4'],
    ['Teal', '#0f9d9a'],
    ['Violet', '#7c5cff'],
    ['Green', '#2f9e44'],
    ['Orange', '#e8590c'],
    ['Pink', '#d6336c'],
  ];
  const GLOWS = [
    ['Cyan', '#2bb8f0'],
    ['Mint', '#3ccf91'],
    ['Amber', '#f5b13d'],
    ['Rose', '#ff6b8b'],
    ['Lilac', '#b197fc'],
    ['White', '#e8ecf3'],
  ];

  let appearance = null;
  let core = null;
  let live = new Set();
  let coreConnected = false;
  let coreStatus = 'stopped';

  // ---------- toast ----------
  let toastTimer;
  function toast(text, error = false) {
    const t = $('toast');
    clearTimeout(toastTimer);
    t.textContent = text;
    t.classList.toggle('error', error);
    t.classList.add('show');
    toastTimer = setTimeout(() => t.classList.remove('show'), error ? 6000 : 1800);
  }

  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(tab, focus = false) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
    if (tab.id === 'tab-voice') loadVoices();
    if (tab.id === 'tab-usage') loadUsage();
  }
  for (const t of tabs) {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(t);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        selectTab(tabs[(i + 1) % tabs.length], true);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTab(tabs[(i - 1 + tabs.length) % tabs.length], true);
      }
    });
  }

  // ---------- this window follows the pet's theme and colors ----------
  function paint() {
    root.dataset.theme = appearance.theme;
    for (const [name, value] of [
      ['--accent', appearance.accent],
      ['--glow', appearance.glow],
    ]) {
      if (value && HEX.test(value)) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
    if (appearance.accent) root.style.setProperty('--accent-ink', inkFor(appearance.accent));
    else root.style.removeProperty('--accent-ink');
  }
  function inkFor(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return l > 0.4 ? '#0d1118' : '#ffffff';
  }

  // ---------- appearance ----------
  async function saveAppearance(patch) {
    try {
      appearance = await api.saveAppearance(patch);
      paint();
      showAppearance();
    } catch {
      toast('Could not save that change.', true);
    }
  }

  function buildSwatches(container, name, presets, key) {
    container.replaceChildren();
    const add = (label, value, extraClass) => {
      const wrap = document.createElement('label');
      wrap.className = `swatch ${extraClass || ''}`;
      wrap.title = label;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = value;
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => saveAppearance({ [key]: value || null }));
      const dot = document.createElement('span');
      if (value) dot.style.background = value;
      else dot.textContent = 'Auto';
      wrap.append(input, dot);
      container.append(wrap);
    };
    add('Theme default', '', 'default');
    for (const [label, value] of presets) add(label, value);
    const custom = document.createElement('label');
    custom.className = 'custom-color';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.dataset.key = key;
    picker.setAttribute('aria-label', `Custom ${name} color`);
    let pickTimer;
    picker.addEventListener('input', () => {
      clearTimeout(pickTimer);
      pickTimer = setTimeout(() => saveAppearance({ [key]: picker.value }), 150);
    });
    custom.append(picker, 'Custom');
    container.append(custom);
  }

  function showAppearance() {
    for (const input of document.querySelectorAll('input[name="look"]')) {
      input.checked = input.value === appearance.look;
    }
    for (const input of document.querySelectorAll('input[name="theme"]')) {
      input.checked = input.value === appearance.theme;
    }
    for (const [name, key] of [
      ['accent', 'accent'],
      ['glow', 'glow'],
    ]) {
      const value = appearance[key] || '';
      let matched = false;
      for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
        input.checked = input.value === value;
        matched ||= input.checked;
      }
      const picker = document.querySelector(`input[type="color"][data-key="${key}"]`);
      if (picker && value) picker.value = value;
      picker?.closest('.custom-color')?.classList.toggle('on', !matched);
    }
    $('size').value = appearance.size;
    $('sizeOut').textContent = `${appearance.size}%`;
    $('logoInTray').checked = appearance.logoInTray;
  }

  function showLogo(logo) {
    const has = typeof logo === 'string' && logo.startsWith('data:image/png;base64,');
    $('logoImg').hidden = !has;
    if (has) $('logoImg').src = logo;
    else $('logoImg').removeAttribute('src');
    $('logoEmpty').hidden = has;
    $('removeLogo').hidden = !has;
    $('lookLogo').dataset.has = has ? '1' : '';
  }

  for (const input of document.querySelectorAll('input[name="look"]')) {
    input.addEventListener('change', () => {
      if (input.value === 'logo' && !$('lookLogo').dataset.has) {
        showAppearance(); // keep the current look until an image is picked
        $('logoFile').click();
        return;
      }
      saveAppearance({ look: input.value });
    });
  }
  for (const input of document.querySelectorAll('input[name="theme"]')) {
    input.addEventListener('change', () => saveAppearance({ theme: input.value }));
  }
  $('size').addEventListener('input', () => {
    $('sizeOut').textContent = `${$('size').value}%`;
  });
  $('size').addEventListener('change', () => saveAppearance({ size: Number($('size').value) }));
  $('logoInTray').addEventListener('change', () =>
    saveAppearance({ logoInTray: $('logoInTray').checked }),
  );

  $('pickLogo').addEventListener('click', () => $('logoFile').click());
  $('logoFile').addEventListener('change', () => {
    const file = $('logoFile').files?.[0];
    $('logoFile').value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast('Pick a PNG or JPEG image.', true);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast('That image is over 2 MB. Pick a smaller one.', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const result = await api.setLogo(reader.result);
      if (!result.ok) {
        toast(result.error, true);
        return;
      }
      showLogo(result.logo);
      await saveAppearance({ look: 'logo' });
      toast('Logo saved');
    };
    reader.onerror = () => toast('That file could not be read.', true);
    reader.readAsDataURL(file);
  });
  $('removeLogo').addEventListener('click', async () => {
    await api.clearLogo();
    showLogo(null);
    appearance = { ...appearance, look: appearance.look === 'logo' ? 'robot' : appearance.look };
    showAppearance();
    toast('Logo removed');
  });

  // ---------- jarvis.yaml settings (voice, listening, learning) ----------
  let pending = {};
  let coreTimer;
  function saveCore(patch, delay = 350) {
    pending = { ...pending, ...patch };
    clearTimeout(coreTimer);
    coreTimer = setTimeout(async () => {
      const send = pending;
      pending = {};
      const result = await api.saveCore(send);
      if (!result.ok) {
        toast(`Not saved: ${result.problems.join('; ')}`, true);
        return;
      }
      core = { ...core, ...send };
      const allLive = Object.keys(send).every((k) => live.has(k));
      if (!coreConnected) toast('Saved. Used the next time Jarvis starts.');
      else toast(allLive ? 'Saved. Jarvis is using it now.' : 'Saved. Restart Jarvis to use it.');
    }, delay);
  }

  function showTags() {
    for (const tag of document.querySelectorAll('.tag[data-for]')) {
      const isLive = live.has(tag.dataset.for);
      tag.textContent = isLive ? 'applies now' : 'after restart';
      tag.className = `tag ${isLive ? 'live' : 'restart'}`;
    }
  }

  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  function showCore() {
    if (!core) return;
    $('voiceRate').value = core['voice.rate'];
    $('voiceRateOut').textContent = rateLabel(core['voice.rate']);
    $('wakeProvider').value = core['keywords.provider'];
    $('minConfidence').value = core['keywords.minConfidence'];
    $('minConfidenceOut').textContent = Number(core['keywords.minConfidence']).toFixed(2);
    $('silenceMs').value = core['listening.silenceMs'];
    $('silenceMsOut').textContent = seconds(core['listening.silenceMs']);
    $('followUp').value = core['listening.followUpSeconds'];
    $('followUpOut').textContent = `${core['listening.followUpSeconds']} s`;
    $('bargeIn').checked = core['listening.bargeIn'];
    $('learning').checked = core['learning.enabled'];
    const strictOff = core['keywords.provider'] !== 'windows';
    $('minConfidence').disabled = strictOff;
  }
  function rateLabel(r) {
    const n = Number(r);
    return n === 0 ? 'Normal' : n > 0 ? `+${n}` : String(n);
  }

  function bindRange(id, key, format, toValue = Number) {
    const el = $(id);
    el.addEventListener('input', () => {
      $(`${id}Out`).textContent = format(el.value);
    });
    el.addEventListener('change', () => saveCore({ [key]: toValue(el.value) }));
  }
  bindRange('voiceRate', 'voice.rate', rateLabel);
  bindRange('minConfidence', 'keywords.minConfidence', (v) => Number(v).toFixed(2));
  bindRange('silenceMs', 'listening.silenceMs', (v) => seconds(Number(v)));
  bindRange('followUp', 'listening.followUpSeconds', (v) => `${v} s`);
  $('wakeProvider').addEventListener('change', () => {
    saveCore({ 'keywords.provider': $('wakeProvider').value }, 0);
    $('minConfidence').disabled = $('wakeProvider').value !== 'windows';
  });
  $('bargeIn').addEventListener('change', () =>
    saveCore({ 'listening.bargeIn': $('bargeIn').checked }, 0),
  );
  $('learning').addEventListener('change', () =>
    saveCore({ 'learning.enabled': $('learning').checked }, 0),
  );
  $('voiceName').addEventListener('change', () =>
    saveCore({ 'voice.voice': $('voiceName').value || null }, 0),
  );

  // ---------- voices and preview ----------
  let voicesLoaded = false;
  async function loadVoices() {
    if (voicesLoaded) return;
    voicesLoaded = true;
    const select = $('voiceName');
    let list = [];
    try {
      list = await api.voices();
    } catch {
      toast('Could not list the Windows voices.', true);
    }
    const current = core?.['voice.voice'] ?? null;
    const opts = [['', 'Windows default']];
    for (const name of list) opts.push([name, name.replace(/^Microsoft /, '')]);
    if (current && !list.includes(current)) opts.push([current, `${current} (not installed)`]);
    select.replaceChildren(
      ...opts.map(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        return o;
      }),
    );
    select.value = current ?? '';
  }

  let audioCtx;
  let playing;
  $('playPreview').addEventListener('click', async () => {
    const btn = $('playPreview');
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const audio = await api.preview(
        $('voiceName').value,
        Number($('voiceRate').value),
        $('previewText').value,
      );
      const bytes = new Uint8Array(audio.pcm);
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
      audioCtx ??= new AudioContext();
      const buffer = audioCtx.createBuffer(1, pcm.length || 1, audio.sampleRate);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      playing?.stop();
      playing = audioCtx.createBufferSource();
      playing.buffer = buffer;
      playing.connect(audioCtx.destination);
      playing.start();
    } catch {
      toast('That voice could not speak. Try another one.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Play';
    }
  });
  $('previewText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('playPreview').click();
  });

  // ---------- pet behavior ----------
  async function saveBehavior(patch) {
    const b = await api.saveBehavior(patch);
    showBehavior(b);
  }
  function showBehavior(b) {
    $('hideWhenIdle').checked = b.hideWhenIdle;
    $('idleSeconds').value = b.idleSeconds;
    $('idleSecondsOut').textContent = `${b.idleSeconds} s`;
    $('idleSeconds').disabled = !b.hideWhenIdle;
    $('startWithWindows').checked = b.startWithWindows;
  }
  $('hideWhenIdle').addEventListener('change', () =>
    saveBehavior({ hideWhenIdle: $('hideWhenIdle').checked }),
  );
  $('idleSeconds').addEventListener('input', () => {
    $('idleSecondsOut').textContent = `${$('idleSeconds').value} s`;
  });
  $('idleSeconds').addEventListener('change', () =>
    saveBehavior({ idleSeconds: Number($('idleSeconds').value) }),
  );
  $('startWithWindows').addEventListener('change', () =>
    saveBehavior({ startWithWindows: $('startWithWindows').checked }),
  );

  $('openConfig').addEventListener('click', () => api.openConfigFolder());

  // ---------- usage ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MODEL_NAMES = [
    ['simple', 'Haiku', 'H'],
    ['standard', 'Sonnet', 'S'],
    ['complex', 'Opus', 'O'],
  ];
  const fmt = new Intl.NumberFormat();
  const compact = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  function svg(tag, attrs, text) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  async function loadUsage() {
    const period = Number(document.querySelector('input[name="period"]:checked')?.value || 7);
    let days = [];
    try {
      days = await api.usage(period);
    } catch {
      toast('Could not read usage.', true);
      return;
    }
    const sum = (f) => days.reduce((n, d) => n + f(d), 0);
    const requests = sum((d) => d.requests);
    const input = sum((d) => d.inputTokens);
    const output = sum((d) => d.outputTokens);
    const words = sum((d) => d.firstWordCount);
    const commands = sum((d) => d.commands);
    const escalations = sum((d) => d.escalations);
    $('uRequests').textContent = fmt.format(requests);
    $('uCommands').textContent = commands ? `+ ${fmt.format(commands)} spoken commands` : '';
    $('uTokens').textContent = compact.format(input + output);
    $('uTokensSplit').textContent = `${compact.format(input)} in · ${compact.format(output)} out`;
    $('uFirstWord').textContent = words
      ? `${(sum((d) => d.firstWordMsTotal) / words / 1000).toFixed(1)} s`
      : '–';
    $('uTools').textContent = fmt.format(sum((d) => d.toolCalls));
    $('uEscalations').textContent = escalations ? `${escalations} moved to a bigger model` : '';

    // Chart (hidden for a single day)
    $('uChartCard').hidden = days.length < 2;
    drawChart(days);

    // By model
    const total = input + output || 1;
    $('uByModel').replaceChildren(
      ...MODEL_NAMES.map(([tier, name, letter]) => {
        const t = sum((d) => d.byTier[tier].inputTokens + d.byTier[tier].outputTokens);
        const tr = document.createElement('tr');
        const c1 = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'model-letter';
        badge.textContent = letter;
        c1.append(badge, name);
        const c2 = document.createElement('td');
        c2.textContent = fmt.format(sum((d) => d.byTier[tier].requests));
        const c3 = document.createElement('td');
        c3.textContent = fmt.format(t);
        const c4 = document.createElement('td');
        const share = document.createElement('span');
        share.className = 'share';
        const track = document.createElement('span');
        track.className = 'share-track';
        const fill = document.createElement('span');
        fill.className = 'share-fill';
        fill.style.width = `${Math.round((t / total) * 100)}%`;
        track.append(fill);
        share.append(track, `${Math.round((t / total) * 100)}%`);
        c4.append(share);
        tr.append(c1, c2, c3, c4);
        return tr;
      }),
    );
  }

  function drawChart(days) {
    const box = $('uChart');
    const values = days.map((d) => d.inputTokens + d.outputTokens);
    const max = Math.max(...values);
    if (max === 0) {
      const empty = document.createElement('p');
      empty.className = 'chart-empty';
      empty.textContent = 'No requests in this period yet. Say "Jarvis" and ask something.';
      box.replaceChildren(empty);
      box.removeAttribute('aria-label');
      return;
    }
    const W = 600;
    const H = 170;
    const left = 44;
    const bottom = 22;
    const plotH = H - bottom - 8;
    const step = (W - left) / days.length;
    const barW = Math.max(3, Math.min(28, step * 0.62));
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    for (const f of [0, 0.5, 1]) {
      const y = 8 + plotH * (1 - f);
      chart.append(svg('line', { class: 'grid', x1: left, x2: W, y1: y, y2: y }));
      chart.append(
        svg('text', { x: left - 8, y: y + 4, 'text-anchor': 'end' }, compact.format(max * f)),
      );
    }
    const labelEvery = days.length > 14 ? 5 : days.length > 7 ? 2 : 1;
    days.forEach((d, i) => {
      const h = values[i] > 0 ? Math.max(2, (values[i] / max) * plotH) : 0;
      const x = left + i * step + (step - barW) / 2;
      const bar = svg('rect', { class: 'bar', x, y: 8 + plotH - h, width: barW, height: h, rx: 3 });
      bar.append(
        svg('title', {}, `${d.date}: ${fmt.format(values[i])} tokens, ${d.requests} requests`),
      );
      chart.append(bar);
      if (i % labelEvery === 0 || i === days.length - 1) {
        const label = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        });
        chart.append(svg('text', { x: x + barW / 2, y: H - 4, 'text-anchor': 'middle' }, label));
      }
    });
    box.replaceChildren(chart);
    box.setAttribute(
      'aria-label',
      `Tokens per day, highest ${fmt.format(max)}, total ${fmt.format(values.reduce((a, b) => a + b, 0))}`,
    );
  }

  for (const input of document.querySelectorAll('input[name="period"]')) {
    input.addEventListener('change', loadUsage);
  }

  // ---------- start and stop Jarvis ----------
  const STATUS_TEXT = {
    running: 'Running',
    starting: 'Starting…',
    restarting: 'Restarting…',
    stopped: 'Not running',
  };
  function showStatus(status) {
    coreStatus = STATUS_TEXT[status] ? status : 'stopped';
    coreConnected = coreStatus === 'running';
    $('status').classList.toggle('up', coreConnected);
    $('statusText').textContent = STATUS_TEXT[coreStatus];
    const power = $('power');
    const busy = coreStatus === 'starting' || coreStatus === 'restarting';
    power.disabled = busy;
    power.textContent =
      coreStatus === 'running' ? 'Stop Jarvis' : busy ? STATUS_TEXT[coreStatus] : 'Start Jarvis';
    const restart = $('restart');
    restart.hidden = coreStatus !== 'running';
    restart.disabled = busy;
    power.classList.toggle('start', coreStatus === 'stopped');
    power.classList.toggle('stop', coreStatus === 'running');
  }
  let wasStarting = false;
  api.onStatus((status) => {
    if (wasStarting && status === 'running' && restartAsked) {
      restartAsked = false;
      toast('Jarvis restarted.');
    }
    if (wasStarting && status === 'stopped') {
      toast('Jarvis did not start. Run npm start in a terminal to see why.', true);
    }
    wasStarting = status === 'starting' || status === 'restarting';
    showStatus(status);
  });
  let restartAsked = false;
  $('restart').addEventListener('click', async () => {
    restartAsked = true;
    wasStarting = true;
    showStatus(await api.restartCore());
  });
  $('power').addEventListener('click', async () => {
    if (coreStatus === 'running') {
      $('power').disabled = true;
      await api.stopCore();
      toast('Stopping Jarvis…');
    } else {
      wasStarting = true;
      showStatus(await api.startCore());
    }
  });

  // ---------- start ----------
  async function start() {
    const s = await api.load();
    appearance = s.appearance;
    core = s.core;
    live = new Set(s.live);
    showStatus(s.coreStatus);
    buildSwatches($('accentSwatches'), 'accent', ACCENTS, 'accent');
    buildSwatches($('glowSwatches'), 'glow', GLOWS, 'glow');
    paint();
    showAppearance();
    showLogo(s.logo);
    showBehavior(s.behavior);
    showTags();
    showCore();
    $('configDir').textContent = s.configDir;
    if (s.coreError) {
      toast(`jarvis.yaml could not be read: ${s.coreError}`, true);
      for (const id of ['voice', 'listening']) {
        for (const el of $(id).querySelectorAll('input, select, button')) el.disabled = true;
      }
      $('learning').disabled = true;
    }
  }
  start();
})();
