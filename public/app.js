/**
 * Cloud Automation Dashboard — app.js
 * Socket.io client + simulation engine + real WebSocket integration points
 */

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║ PRODUCTION WEBSOCKET HOOK                                                  ║
// ║ To connect a real-time binary screencast feed from the remote browser,     ║
// ║ uncomment and bind this section:                                           ║
// ╚════════════════════════════════════════════════════════════════════════════╝
/*
const remoteScreencastWS = new WebSocket("ws://" + location.host + "/screencast");

remoteScreencastWS.onopen = () => {
  appendLog('SYSTEM', 'Screencast WebSocket channel established.');
};

remoteScreencastWS.onmessage = (event) => {
  const imgElement = document.getElementById("stream-img");
  // If the server sends raw base64 data:
  imgElement.src = "data:image/jpeg;base64," + event.data;
  
  // If the server sends binary blob / ArrayBuffer:
  // const blob = new Blob([event.data], { type: 'image/jpeg' });
  // imgElement.src = URL.createObjectURL(blob);
  
  showStreamImg();
};

remoteScreencastWS.onerror = (error) => {
  appendLog('ERROR', 'Screencast WS error: ' + error.message, true);
};

remoteScreencastWS.onclose = () => {
  appendLog('SYSTEM', 'Screencast WebSocket connection closed.');
};
*/

// Initialize standard dashboard Socket.io client connection
const socket = io();

// ── DOM References ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const projectsContainer = $('projects-container');
const promptInput       = $('prompt-input');
const quickPrompt       = $('quick-prompt');
const charCounter       = $('char-counter');
const btnLaunch         = $('btn-launch');
const btnSubmit         = $('btn-submit');
const launchLabel       = $('launch-label');
const launchIcon        = $('launch-icon');
const logsPanel         = $('tab-logs');
const chatPanel         = $('tab-chat');
const filesPanel        = $('tab-files');
const streamIdle        = $('stream-idle');
const streamMock        = $('stream-mock');
const streamImg         = $('stream-img');
const previewIframe     = $('preview-iframe');
const streamMeta        = $('stream-meta');
const activeProjectName = $('active-project-name');
const streamStatusBadge = $('stream-status-badge');
const streamDot         = $('stream-dot');
const buildFilesCount   = $('build-files-count');
const buildProgressText = $('build-progress-text');
const fileOpsTicker     = $('file-ops-ticker');
const logCountEl        = $('log-count');
const mockProgressBar   = $('mock-progress-bar');
const mockCodeStream    = $('mock-code-stream');
const lastSnapshotTime  = $('last-snapshot-time');

// ── State variables ──────────────────────────────────────────────────────────
let activeProjectIndex = null;
let currentProjectList = [];
let logCount = 0;
let isLaunching = false;
let isProcessing = false;
let simulationInterval = null;
let mockProgressValue = 15;

// ── Status configurations ────────────────────────────────────────────────────
const STATUSES = {
  disconnected: { label: 'Disconnected',              color: 'text-white/40 border-brand-border bg-brand-black/40',         dot: 'bg-brand-red', progress: 0   },
  initializing: { label: 'Initializing Cloud Container',   color: 'text-brand-amber border-brand-amber/35 bg-brand-amber/10 shadow-glow-amber',     dot: 'bg-brand-amber animate-pulse', progress: 25  },
  booting:      { label: 'Chrome Booting',           color: 'text-brand-orange border-brand-orange/35 bg-brand-orange/10 shadow-glow-orange',    dot: 'bg-brand-orange animate-pulse', progress: 55  },
  syncing:      { label: 'Active Sync',        color: 'text-brand-blue border-brand-blue/35 bg-brand-blue/10',      dot: 'bg-brand-blue animate-pulse', progress: 75  },
  active:       { label: 'Active Sync',               color: 'text-brand-green border-brand-green/35 bg-brand-green/10 shadow-glow-green',     dot: 'bg-brand-green',       progress: 100 },
  error:        { label: 'Connection Error',          color: 'text-brand-red border-brand-red/35 bg-brand-red/10',       dot: 'bg-brand-red', progress: 0   },
};

function setStatus(key) {
  const s = STATUSES[key] || STATUSES.disconnected;
  $('status-text').textContent = s.label;
  $('status-badge').className = `flex items-center gap-2 px-2.5 py-1 rounded-full border text-[10px] font-mono status-badge ${s.color}`;
  
  $('status-dot').className = `w-2 h-2 rounded-full ${s.dot}`;
  $('status-progress').style.width = s.progress + '%';
  
  $('status-progress').className = `h-full rounded-full transition-all duration-700 ${
    key === 'active' ? 'bg-brand-green' : key === 'error' ? 'bg-brand-red' : 'bg-brand-purple'
  }`;

  // Update step indicators
  const steps = ['step-connect', 'step-init', 'step-chrome', 'step-sync'];
  const thresholds = [25, 55, 75, 100];
  steps.forEach((id, i) => {
    const bar = $(id).querySelector('div');
    const active = s.progress >= thresholds[i];
    bar.className = `h-1 rounded transition-all duration-500 ${
      active ? (key === 'active' ? 'bg-brand-green' : 'bg-brand-purple') : 'bg-brand-border/40'
    }`;
    $(id).querySelector('span').className = `text-[9px] ${active ? 'text-white/50' : 'text-white/25'}`;
  });

  // Keep screen dot in sync
  streamDot.className = `w-2.5 h-2.5 rounded-full ${s.dot}`;
}

// ── Real-time simulated logs array ───────────────────────────────────────────
const SIM_LOGS = [
  { tag: 'SYSTEM',     text: 'Establishing WebSocket connection to Tencent Cloud CVM Node backend...', delay: 200 },
  { tag: 'WS',         text: 'WebSocket connection handshaking complete. Protocol level initialized.', delay: 700 },
  { tag: 'CHROME',     text: 'Browser instance spawned with flags: --no-sandbox --headless=new', delay: 1400 },
  { tag: 'EXTENSION',  text: 'Loading custom chrome extension from target system directory...', delay: 2100 },
  { tag: 'AUTH',       text: 'Session storage token successfully injected. Injecting target project URL...', delay: 2800 },
  { tag: 'STREAM',     text: 'Visual screencast pipeline bound at 60% JPEG canvas quality.', delay: 3500 },
  { tag: 'AUTOMATION', text: 'Dispatching user prompt payload to Lovable engine...', delay: 4200 },
  { tag: 'LOVABLE',    text: 'Workspace sync handshake validated. Active status reported.', delay: 4900 }
];

const TAG_COLORS = {
  SYSTEM:     'text-white/40',
  WS:         'text-cyan-400/80',
  CONTAINER:  'text-purple-400/80',
  CHROME:     'text-brand-orange',
  EXTENSION:  'text-brand-blue',
  AUTH:       'text-brand-amber',
  PAGE:       'text-indigo-400/80',
  FLOATUI:    'text-brand-purple',
  STREAM:     'text-teal-400/80',
  AUTOMATION: 'text-brand-green',
  LOVABLE:    'text-pink-400/80',
  BUILD:      'text-brand-green',
  ERROR:      'text-brand-red',
  INFO:       'text-white/50',
};

function appendLog(tag, text, isError = false) {
  const el = document.createElement('div');
  el.className = 'terminal-line flex gap-2.5 py-0.5 leading-relaxed font-mono text-[10px]';
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const colorClass = isError ? TAG_COLORS.ERROR : (TAG_COLORS[tag] || 'text-white/55');
  
  el.innerHTML = `
    <span class="text-white/20 flex-shrink-0 select-none">${ts}</span>
    <span class="${colorClass} flex-shrink-0 font-bold min-w-[76px]">[${tag}]</span>
    <span class="text-white/60">${escapeHtml(text)}</span>
  `;

  // Remove idle label if present
  const placeholder = logsPanel.querySelector('.text-center');
  if (placeholder) placeholder.remove();
  
  logsPanel.appendChild(el);
  logsPanel.scrollTop = logsPanel.scrollHeight;
  logCount++;
  logCountEl.textContent = `${logCount} events`;
}

function addChatBubble(text, sender) {
  const placeholder = chatPanel.querySelector('.text-center');
  if (placeholder) placeholder.remove();
  const el = document.createElement('div');
  
  if (sender === 'user') {
    el.className = 'flex justify-end';
    el.innerHTML = `<div class="max-w-[85%] bg-brand-purple/15 border border-brand-purple/25 rounded-xl rounded-br-sm px-3.5 py-2 text-[10px] text-white/70 font-mono">${escapeHtml(text)}</div>`;
  } else {
    el.className = 'flex justify-start';
    el.innerHTML = `<div class="max-w-[85%] bg-brand-card border border-brand-border rounded-xl rounded-bl-sm px-3.5 py-2 text-[10px] text-white/50">${escapeHtml(text)}</div>`;
  }
  chatPanel.appendChild(el);
  chatPanel.scrollTop = chatPanel.scrollHeight;
}

function addFileOp(path, op) {
  const placeholder = filesPanel.querySelector('.text-center');
  if (placeholder) placeholder.remove();
  const colors = { create: 'text-brand-green', edit: 'text-brand-blue', delete: 'text-brand-red' };
  const icons  = { create: '✦', edit: '◈', delete: '✕' };
  
  const el = document.createElement('div');
  el.className = 'flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-brand-card border border-brand-border text-[9px] font-mono terminal-line';
  el.innerHTML = `
    <span class="text-white/50 truncate flex-1">${escapeHtml(path)}</span>
    <span class="ml-2 flex-shrink-0 ${colors[op] || 'text-white/30'} font-semibold">${icons[op] || '·'} ${op}</span>
  `;
  filesPanel.appendChild(el);
  filesPanel.scrollTop = filesPanel.scrollHeight;

  // File ticker additions
  const badge = document.createElement('span');
  badge.className = `text-[8px] px-2 py-0.5 rounded bg-brand-card border border-brand-border font-mono ${colors[op] || 'text-white/30'} flex-shrink-0`;
  badge.textContent = path.split('/').pop();
  if (fileOpsTicker.children.length > 3) fileOpsTicker.firstChild.remove();
  fileOpsTicker.appendChild(badge);
}

// ── Screen display states switcher ───────────────────────────────────────────
function showStreamIdle() {
  streamIdle.classList.remove('hidden');
  streamMock.classList.add('hidden');
  streamImg.classList.add('hidden');
  previewIframe.classList.add('hidden');
  streamMeta.textContent = 'No signal detected';
  $('stream-status-badge').innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-brand-border" id="stream-dot"></span><span class="ml-1.5 text-[9px] font-mono text-white/30">Offline</span>`;
}

function showStreamMock() {
  streamIdle.classList.add('hidden');
  streamMock.classList.remove('hidden');
  streamImg.classList.add('hidden');
  previewIframe.classList.add('hidden');
  streamMeta.textContent = 'Active Simulated screencast pipeline';
  $('stream-status-badge').innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-brand-green" id="stream-dot"></span><span class="ml-1.5 text-[9px] font-mono text-brand-green">Active Sync</span>`;
}

function showStreamImg() {
  streamIdle.classList.add('hidden');
  streamMock.classList.add('hidden');
  streamImg.classList.remove('hidden');
  previewIframe.classList.add('hidden');
  const now = new Date().toLocaleTimeString();
  streamMeta.textContent = `Frame buffer at ${now}`;
  lastSnapshotTime.textContent = `Snapshot: ${now}`;
  $('stream-status-badge').innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-brand-green shadow-glow-green" id="stream-dot"></span><span class="ml-1.5 text-[9px] font-mono text-brand-green">Live Feed</span>`;
}

function showPreviewIframe(url) {
  streamIdle.classList.add('hidden');
  streamMock.classList.add('hidden');
  streamImg.classList.add('hidden');
  previewIframe.src = url;
  previewIframe.classList.remove('hidden');
  streamMeta.textContent = 'Live preview domain: ' + url.replace('https://', '');
}

// ── Mock workspace code/progress sequence ────────────────────────────────────
function startMockProgress() {
  if (simulationInterval) clearInterval(simulationInterval);
  mockProgressValue = 15;
  const mockCodeLines = [
    '<span class="text-brand-purple">import</span> React <span class="text-brand-purple">from</span> <span class="text-brand-green">\'react\'</span>;',
    '<span class="text-white/60">const navigationLayout = () => {</span>',
    '<span class="text-white/30 pl-4">return (</span>',
    '<span class="text-white/30 pl-8">&lt;div className="glow-accent"&gt;</span>',
    '<span class="text-white/40 pl-12">&lt;Header branding="active" /&gt;</span>',
    '<span class="text-white/30 pl-8">&lt;/div&gt;</span>',
    '<span class="text-white/30 pl-4">);</span>',
    '<span class="text-white/60">};</span>'
  ];
  let lineIndex = 0;
  simulationInterval = setInterval(() => {
    mockProgressValue = Math.min(95, mockProgressValue + Math.random() * 5 + 2);
    if (mockProgressBar) mockProgressBar.style.width = mockProgressValue + '%';
    if (mockCodeStream && lineIndex < mockCodeLines.length) {
      const lineEl = document.createElement('div');
      lineEl.className = 'text-[10px] terminal-line leading-relaxed';
      lineEl.innerHTML = mockCodeLines[lineIndex++];
      mockCodeStream.appendChild(lineEl);
      mockCodeStream.scrollTop = mockCodeStream.scrollHeight;
    }
  }, 900);
}

function stopMockProgress() {
  if (simulationInterval) clearInterval(simulationInterval);
  if (mockProgressBar) mockProgressBar.style.width = '100%';
}

// ── Launch orchestration session triggers ────────────────────────────────────
window.launchSession = function() {
  if (isLaunching) return;
  isLaunching = true;

  // Set visual loading states
  btnLaunch.disabled = true;
  launchLabel.textContent = 'Initializing cloud container...';
  launchIcon.setAttribute('data-lucide', 'loader');
  if (window.lucide) lucide.createIcons();

  // Clear system console
  logsPanel.innerHTML = '';
  logCount = 0;
  logCountEl.textContent = '0 events';
  fileOpsTicker.innerHTML = '';

  // Shift connection status state-by-state over simulated intervals
  setStatus('initializing');

  // Stream each of the specific logs line-by-line using simulated intervals
  SIM_LOGS.forEach(({ tag, text, delay }) => {
    setTimeout(() => appendLog(tag, text), delay);
  });

  // Switch connection status badge dynamically
  setTimeout(() => setStatus('booting'), 1400);
  setTimeout(() => setStatus('syncing'), 2800);
  
  setTimeout(() => {
    setStatus('active');
    showStreamMock();
    startMockProgress();
    
    launchLabel.textContent = 'Session Established';
    launchIcon.setAttribute('data-lucide', 'check-check');
    if (window.lucide) lucide.createIcons();
    
    isLaunching = false;

    // Enable prompt submission once session is fully active
    if (activeProjectIndex !== null) {
      btnSubmit.disabled = false;
    }
  }, 4900);

  // Trigger backend execution connections
  socket.emit('get-projects');
  socket.emit('start-session');
};

// ── Prompt Payload Submission ────────────────────────────────────────────────
window.submitPrompt = function() {
  const promptTextVal = (quickPrompt.value || promptInput.value || '').trim();
  if (!promptTextVal || isProcessing) return;

  isProcessing = true;
  btnSubmit.disabled = true;
  $('submit-label').textContent = 'Dispatching prompt...';

  addChatBubble(promptTextVal, 'user');
  appendLog('AUTOMATION', 'Dispatching user prompt payload to Lovable engine: ' + promptTextVal.substring(0, 50) + (promptTextVal.length > 50 ? '...' : ''));

  socket.emit('submit-prompt', { prompt: promptTextVal });
  quickPrompt.value = '';
  promptInput.value = '';
  charCounter.textContent = '0 chars';
};

window.cancelBuild = function() {
  socket.emit('cancel-build');
  appendLog('SYSTEM', 'Cancel workspace compilation instruction dispatched.');
  isProcessing = false;
  btnSubmit.disabled = false;
  $('submit-label').textContent = 'Dispatch Payload';
};

window.stopSession = function() {
  socket.emit('stop-session');
  appendLog('SYSTEM', 'Remote Cloud automation session stopped by operator.');
  setStatus('disconnected');
  showStreamIdle();
  stopMockProgress();
  btnLaunch.disabled = false;
  launchLabel.textContent = 'Launch Automation Session';
  launchIcon.setAttribute('data-lucide', 'rocket');
  if (window.lucide) lucide.createIcons();
  isLaunching = false;
  isProcessing = false;
};

window.requestSnapshot = function() {
  socket.emit('capture-snapshot');
  appendLog('STREAM', 'Manual screencast frame update requested.');
};

window.reloadProjects = function() {
  socket.emit('get-projects');
  appendLog('SYSTEM', 'Dispatching query to sync active workspace list...');
};

window.clearLogs = function() {
  logsPanel.innerHTML = '<div class="text-white/20 text-center py-6 text-[10px]">Console cache cleared.</div>';
  logCount = 0;
  logCountEl.textContent = '0 events';
};

window.insertSuggest = function(text) {
  promptInput.value = text;
  quickPrompt.value = text;
  charCounter.textContent = text.length + ' chars';
};

window.toggleTokenVisibility = function() {
  const input = $('auth-token');
  const btn = $('toggle-token');
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = '<i data-lucide="eye-off" class="w-4 h-4"></i>';
  } else {
    input.type = 'password';
    btn.innerHTML = '<i data-lucide="eye" class="w-4 h-4"></i>';
  }
  if (window.lucide) lucide.createIcons();
};

window.switchLogTab = function(tabName, clickedBtn) {
  document.querySelectorAll('.log-tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('border-brand-purple', 'text-brand-purple');
    btn.classList.add('border-transparent', 'text-white/30');
  });
  
  $('tab-' + tabName).classList.remove('hidden');
  clickedBtn.classList.add('border-brand-purple', 'text-brand-purple');
  clickedBtn.classList.remove('border-transparent', 'text-white/30');
};

// ── Socket Event Handlers ────────────────────────────────────────────────────
socket.on('connect', () => {
  appendLog('WS', 'Local management server handshake verified. sid=' + socket.id);
  socket.emit('get-projects');
});

socket.on('disconnect', () => {
  appendLog('WS', 'Management backend connection dropped.', true);
  setStatus('disconnected');
});

socket.on('projects-list', (projects) => {
  currentProjectList = projects;
  projectsContainer.innerHTML = '';
  if (!projects.length) {
    projectsContainer.innerHTML = '<div class="text-[10px] text-white/20 text-center py-4 font-mono">No active workspaces detected</div>';
    return;
  }
  projects.forEach((proj, idx) => {
    const el = document.createElement('div');
    const isActive = activeProjectIndex === idx;
    el.className = `px-3 py-2 rounded-xl cursor-pointer border transition-all text-[11px] font-mono ${
      isActive
        ? 'bg-brand-purple/10 border-brand-purple/35 text-white'
        : 'bg-brand-card/30 border-brand-border/40 text-white/40 hover:bg-brand-card hover:text-white/70 hover:border-brand-border'
    }`;
    el.onclick = () => selectProject(idx);
    el.innerHTML = `
      <div class="font-medium truncate">${escapeHtml(proj.name)}</div>
      <div class="text-[9px] text-white/25 truncate mt-0.5">${escapeHtml(proj.url.split('/').pop())}</div>
    `;
    projectsContainer.appendChild(el);
  });
});

socket.on('session-state', (data) => {
  if (data.activeProject) {
    activeProjectName.textContent = data.activeProject;
    setStatus('active');
    btnSubmit.disabled = false;
  }
  if (data.isProcessing) {
    isProcessing = true;
    btnSubmit.disabled = true;
    $('submit-label').textContent = 'Orchestrating...';
  }
});

socket.on('project-activated', (data) => {
  appendLog('PAGE', `Workspace context shifted: "${data.name}" is now active.`);
  addChatBubble(`Activated project workspace context: "${data.name}"`, 'system');
  activeProjectName.textContent = data.name;
  socket.emit('capture-snapshot');
});

socket.on('build-update', (data) => {
  if (data.status) appendLog('BUILD', data.status.replace(/\n/g, ' ').substring(0, 150));
  if (data.progress) buildProgressText.textContent = data.progress;
  if (data.files && data.files.length) {
    buildFilesCount.textContent = `${data.files.length} files updated`;
    data.files.forEach(file => addFileOp(file.path, file.op));
  }
  if (data.terminalLogs) {
    data.terminalLogs.split('\n').filter(Boolean).forEach(line => appendLog('CHROME-TERM', line));
  }
});

socket.on('build-question', (data) => {
  appendLog('LOVABLE', 'Question prompted: ' + data.question);
  addChatBubble('Lovable verification requested: ' + data.question, 'system');
});

socket.on('build-finished', (data) => {
  stopMockProgress();
  appendLog('BUILD', 'Deployment successfully completed.' + (data.url ? ' Link: ' + data.url : ''));
  addChatBubble('🎉 Remote build compilation finished successfully!', 'system');
  if (data.response) addChatBubble(data.response.substring(0, 200) + '...', 'system');
  if (data.url) showPreviewIframe(data.url);
  isProcessing = false;
  btnSubmit.disabled = false;
  $('submit-label').textContent = 'Dispatch Payload';
});

socket.on('snapshot-capture', (data) => {
  if (data.img) {
    streamImg.src = data.img;
    showStreamImg();
    appendLog('STREAM', 'Received remote browser framerate update.');
  }
});

socket.on('operation-failed', (data) => {
  appendLog('ERROR', 'Session operation failed: ' + data.error, true);
  addChatBubble('Error: ' + data.error, 'system');
  isProcessing = false;
  btnSubmit.disabled = false;
  $('submit-label').textContent = 'Dispatch Payload';
  stopMockProgress();
});

socket.on('browser-log', (data) => {
  appendLog(data.tag || 'CHROME', data.text);
});

socket.on('session-started', () => {
  appendLog('SYSTEM', 'Chrome process and screencast sync channels activated.');
  setStatus('active');
});

// ── General Helper Scripts ───────────────────────────────────────────────────
function selectProject(idx) {
  activeProjectIndex = idx;
  const proj = currentProjectList[idx];
  
  socket.emit('get-projects'); // Sync and refresh borders
  document.querySelectorAll('#projects-container > div').forEach((el, i) => {
    const isActive = i === idx;
    el.className = `px-3 py-2 rounded-xl cursor-pointer border transition-all text-[11px] font-mono ${
      isActive
        ? 'bg-brand-purple/10 border-brand-purple/35 text-white'
        : 'bg-brand-card/30 border-brand-border/40 text-white/40 hover:bg-brand-card hover:text-white/70 hover:border-brand-border'
    }`;
  });

  activeProjectName.textContent = proj.name;
  appendLog('SYSTEM', 'Setting active workspace environment to: ' + proj.name);
  socket.emit('select-project', { index: idx, url: proj.url });
  btnSubmit.disabled = false;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Character and input counts
promptInput.addEventListener('input', () => {
  charCounter.textContent = promptInput.value.length + ' chars';
});

quickPrompt.addEventListener('input', () => {
  promptInput.value = quickPrompt.value;
  charCounter.textContent = quickPrompt.value.length + ' chars';
});

// Submission key shortcuts
[promptInput, quickPrompt].forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitPrompt();
    }
  });
});

// Launch bind
btnLaunch.addEventListener('click', launchSession);

// Initialize display states
showStreamIdle();
setStatus('disconnected');
