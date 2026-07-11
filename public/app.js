const socket = io();

// DOM Cache
const projectsContainer = document.getElementById('projects-container');
const chatStreamContainer = document.getElementById('chat-stream-container');
const terminalOutput = document.getElementById('terminal-output');
const filesContainer = document.getElementById('files-container');
const screenshotHolder = document.getElementById('screenshot-holder');
const iframeHolder = document.getElementById('iframe-holder');
const activeProjectName = document.getElementById('active-project-name');
const statusBadge = document.getElementById('status-badge');
const promptInput = document.getElementById('prompt-input');
const charCounter = document.getElementById('char-counter');
const btnSubmit = document.getElementById('btn-submit');
const btnCancel = document.getElementById('btn-cancel');
const btnSnapshot = document.getElementById('btn-snapshot');
const btnReloadDashboard = document.getElementById('btn-reload-dashboard');
const btnStopBrowser = document.getElementById('btn-stop-browser');
const btnStartInstance = document.getElementById('btn-start-instance');

let activeProjectIndex = null;
let currentProjectList = [];
let activeObserverBubble = null;

// Tab Switcher
window.switchTab = function(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tabName));
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabName}`);
  });
};

// Insert Preset Prompts
window.insertPrompt = function(text) {
  promptInput.value = text;
  charCounter.textContent = `${text.length} characters`;
  promptInput.focus();
};

// Socket Connect logic
socket.on('connect', () => {
  console.log('[WebSocket] Connected.');
  socket.emit('get-projects');
});

// Update Workspaces list
socket.on('projects-list', (projects) => {
  currentProjectList = projects;
  projectsContainer.innerHTML = '';
  
  if (projects.length === 0) {
    projectsContainer.innerHTML = '<div class="loading-spinner">No active workspaces. Click sync.</div>';
    return;
  }

  projects.forEach((proj, idx) => {
    const card = document.createElement('div');
    card.className = `project-card ${activeProjectIndex === idx ? 'active' : ''}`;
    card.onclick = () => selectProject(idx);
    card.innerHTML = `
      <h3>${escapeHtml(proj.name)}</h3>
      <span>${escapeHtml(proj.url.split('/').pop())}</span>
    `;
    projectsContainer.appendChild(card);
  });
});

// Restore state from socket on reconnect/refresh
socket.on('session-state', (data) => {
  console.log('[WebSocket] Session state synced:', data);
  if (data.activeProject) {
    activeProjectName.textContent = data.activeProject;
    statusBadge.className = 'status-indicator active';
    statusBadge.innerHTML = '<span class="dot"></span> Connected';
    btnSubmit.disabled = false;
    
    // Find index by name and highlight card
    const idx = currentProjectList.findIndex(p => p.name === data.activeProject);
    if (idx !== -1) {
      activeProjectIndex = idx;
      document.querySelectorAll('.project-card').forEach((el, cardIdx) => {
        el.classList.toggle('active', cardIdx === idx);
      });
    }
  }
  
  if (data.isProcessing) {
    setLoading(true);
  }
});

// Activate selected project
function selectProject(index) {
  activeProjectIndex = index;
  const project = currentProjectList[index];
  
  document.querySelectorAll('.project-card').forEach((el, idx) => {
    el.classList.toggle('active', idx === index);
  });

  activeProjectName.textContent = project.name;
  statusBadge.className = 'status-indicator active';
  statusBadge.innerHTML = '<span class="dot"></span> Connected';
  btnSubmit.disabled = false;

  addChatBubble(`🔄 Activating project workspace: ${project.name}...`, 'system');
  socket.emit('select-project', { index, url: project.url });
}

// Project Selection Callback
socket.on('project-activated', (data) => {
  addChatBubble(`✅ Workspace "${data.name}" loaded successfully. Ready to build!`, 'system');
  // Load initial placeholder preview or screenshot
  socket.emit('capture-snapshot');
});

// Real-time observer logs builder stream
socket.on('build-update', (data) => {
  // If we don't have an active build/observer bubble, create one
  if (!activeObserverBubble) {
    activeObserverBubble = document.createElement('div');
    activeObserverBubble.className = 'observer-bubble';
    activeObserverBubble.innerHTML = `
      <div class="title">🔨 Lovable is building changes...</div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      <div class="observer-status-text">Starting build steps...</div>
    `;
    chatStreamContainer.appendChild(activeObserverBubble);
    chatStreamContainer.scrollTop = chatStreamContainer.scrollHeight;
  }

  // Update observer details
  const statusEl = activeObserverBubble.querySelector('.observer-status-text');
  if (statusEl && data.status) {
    statusEl.innerHTML = `<b>Status:</b> ${escapeHtml(data.status)}`;
  }

  // Update Changed Files tab
  if (data.files && data.files.length > 0) {
    filesContainer.innerHTML = '';
    data.files.forEach(file => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const icon = file.op === 'create' ? '🆕' : (file.op === 'delete' ? '🗑️' : '✏️');
      card.innerHTML = `
        <div class="file-meta">
          <span>${icon}</span>
          <span>${escapeHtml(file.path)}</span>
        </div>
        <span class="op-badge ${file.op}">${file.op}</span>
      `;
      filesContainer.appendChild(card);
    });
  }

  // Stream terminal logs
  if (data.terminalLogs) {
    terminalOutput.innerHTML = '';
    data.terminalLogs.split('\n').forEach(line => {
      const l = document.createElement('div');
      l.className = 'term-line';
      l.textContent = line;
      terminalOutput.appendChild(l);
    });
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }
});

// Question from Lovable Action Callback
socket.on('build-question', (data) => {
  // Remove loading bar from active bubble
  if (activeObserverBubble) {
    const bar = activeObserverBubble.querySelector('.progress-bar');
    if (bar) bar.remove();
  }

  const qBubble = document.createElement('div');
  qBubble.className = 'observer-bubble';
  qBubble.innerHTML = `
    <div class="title" style="color: var(--accent-red)">❓ Lovable requires confirmation</div>
    <p style="margin-bottom: 10px;">${escapeHtml(data.question)}</p>
    <div class="question-options-holder"></div>
  `;

  const holder = qBubble.querySelector('.question-options-holder');
  data.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-small';
    btn.style.margin = '4px 4px 0 0';
    btn.textContent = opt.text;
    btn.onclick = () => {
      addChatBubble(`Selected: ${opt.text}`, 'user');
      socket.emit('submit-question-choice', { text: opt.text });
      qBubble.remove();
      activeObserverBubble = null; // reset build state
    };
    holder.appendChild(btn);
  });

  chatStreamContainer.appendChild(qBubble);
  chatStreamContainer.scrollTop = chatStreamContainer.scrollHeight;
});

// Build Completion Panel Callback
socket.on('build-finished', (data) => {
  // Remove loading indicator bubble
  if (activeObserverBubble) {
    activeObserverBubble.remove();
    activeObserverBubble = null;
  }

  addChatBubble('🎉 Build completed successfully! Preview compiled.', 'system');

  // Embed Live URL directly inside the Iframe view (Just like Lovable!)
  if (data.url) {
    iframeHolder.innerHTML = `<iframe src="${data.url}"></iframe>`;
    // Force active tab focus on the Live App iframe
    switchTab('app');
  }

  setLoading(false);
});

// Capture snapshot
socket.on('snapshot-capture', (data) => {
  screenshotHolder.innerHTML = `<img src="${data.img}" alt="Screenshot viewport">`;
});

// Error handling
socket.on('operation-failed', (data) => {
  if (activeObserverBubble) {
    activeObserverBubble.remove();
    activeObserverBubble = null;
  }
  addChatBubble(`❌ Build failed: ${data.error}`, 'system');
  setLoading(false);
});

// UI Actions Click Handlers
btnSubmit.onclick = () => {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  setLoading(true);
  addChatBubble(prompt, 'user');
  promptInput.value = '';
  charCounter.textContent = '0 characters';
  
  socket.emit('submit-prompt', { prompt });
};

btnCancel.onclick = () => {
  socket.emit('cancel-build');
  addChatBubble('❌ Cancel command sent.', 'system');
  setLoading(false);
};

btnSnapshot.onclick = () => {
  socket.emit('capture-snapshot');
};

btnReloadDashboard.onclick = () => {
  addChatBubble('🔄 Synchronizing workspaces list...', 'system');
  socket.emit('get-projects');
};

btnStopBrowser.onclick = () => {
  socket.emit('stop-session');
  addChatBubble('🛑 Terminating Chromium backend connection...', 'system');
  setLoading(false);
};

btnStartInstance.onclick = () => {
  addChatBubble('🟢 Starting browser instance...', 'system');
  socket.emit('start-session');
};

socket.on('session-started', (data) => {
  addChatBubble('✅ Chromium backend instance started successfully.', 'system');
  statusBadge.className = 'status-indicator active';
  statusBadge.innerHTML = '<span class="dot"></span> Connected';
});

// Input event listener
promptInput.oninput = () => {
  charCounter.textContent = `${promptInput.value.length} characters`;
};
promptInput.onkeydown = (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    btnSubmit.click();
  }
};

// Chat rendering helper
function addChatBubble(text, sender) {
  const bubble = document.createElement('div');
  bubble.className = `${sender}-bubble`;
  bubble.textContent = text;
  chatStreamContainer.appendChild(bubble);
  chatStreamContainer.scrollTop = chatStreamContainer.scrollHeight;
}

function setLoading(isLoading) {
  btnSubmit.disabled = isLoading;
  btnCancel.disabled = !isLoading;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
