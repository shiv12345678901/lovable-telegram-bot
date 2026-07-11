const socket = io();

// DOM Cache
const projectsContainer = document.getElementById('projects-container');
const terminalOutput = document.getElementById('terminal-output');
const progressIndicator = document.getElementById('progress-indicator');
const promptInput = document.getElementById('prompt-input');
const charCounter = document.getElementById('char-counter');
const screenshotContainer = document.getElementById('screenshot-container');
const filesContainer = document.getElementById('files-container');
const btnSubmit = document.getElementById('btn-submit');
const btnCancel = document.getElementById('btn-cancel');
const btnSnapshot = document.getElementById('btn-snapshot');
const btnReloadDashboard = document.getElementById('btn-reload-dashboard');
const btnStopBrowser = document.getElementById('btn-stop-browser');

let activeProjectIndex = null;
let currentProjectList = [];

// Socket Connection Handler
socket.on('connect', () => {
  console.log('Connected to server websocket.');
  appendTerminalLine('System connected to web UI controller.', 'system-msg');
  // Load dashboard on startup
  socket.emit('get-projects');
});

// Update Workspaces list
socket.on('projects-list', (projects) => {
  currentProjectList = projects;
  projectsContainer.innerHTML = '';
  
  if (projects.length === 0) {
    projectsContainer.innerHTML = '<div class="loading-state">No workspaces active. Reload to connect.</div>';
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

// Select active workspace project
function selectProject(index) {
  activeProjectIndex = index;
  const project = currentProjectList[index];
  
  // Update visual state
  document.querySelectorAll('.project-card').forEach((el, idx) => {
    el.classList.toggle('active', idx === index);
  });

  appendTerminalLine(`Activating project workspace: ${project.name}...`, 'system-msg');
  socket.emit('select-project', { index, url: project.url });
}

// System selection complete callback
socket.on('project-activated', (data) => {
  appendTerminalLine(`✅ Project activated: ${data.name}. Ready for prompts!`, 'system-msg');
});

// Live Build Logs Stream Handler
socket.on('build-update', (data) => {
  if (data.status) {
    appendTerminalLine(`🔧 ${data.status}`);
  }
  if (data.progress) {
    progressIndicator.textContent = data.progress;
  }
  
  // Update changed files
  if (data.files && data.files.length > 0) {
    filesContainer.innerHTML = '';
    data.files.forEach(file => {
      const row = document.createElement('div');
      row.className = 'file-row';
      const icon = file.op === 'create' ? '🆕' : (file.op === 'delete' ? '🗑️' : '✏️');
      row.innerHTML = `
        <div class="file-info">
          <span>${icon}</span>
          <span>${escapeHtml(file.path)}</span>
        </div>
        <span class="file-op ${file.op}">${file.op}</span>
      `;
      filesContainer.appendChild(row);
    });
  }

  // Update terminal logs
  if (data.terminalLogs) {
    terminalOutput.innerHTML = '';
    const lines = data.terminalLogs.split('\n');
    lines.forEach(line => {
      appendTerminalLine(line);
    });
  }
});

// Action callback when build finishes
socket.on('build-finished', (data) => {
  appendTerminalLine(`🎉 Build succeeded! Live Preview URL available at:`, 'system-msg');
  
  const linkLine = document.createElement('div');
  linkLine.className = 'terminal-line';
  linkLine.innerHTML = `<a href="${data.url}" target="_blank" style="color: var(--accent-purple); font-weight: bold;">🌐 Open Live App Preview</a>`;
  terminalOutput.appendChild(linkLine);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
  
  setLoading(false);
});

// Interactive questions handler
socket.on('build-question', (data) => {
  appendTerminalLine(`❓ Action Required: ${data.question}`, 'system-msg');
  // Populate options directly in terminal as click targets
  data.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-small';
    btn.style.margin = '4px';
    btn.textContent = opt.text;
    btn.onclick = () => {
      appendTerminalLine(`Submitting choice: ${opt.text}...`, 'system-msg');
      socket.emit('submit-question-choice', { text: opt.text });
      btn.disabled = true;
    };
    terminalOutput.appendChild(btn);
  });
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
});

// Capture snapshot viewport update
socket.on('snapshot-capture', (data) => {
  screenshotContainer.innerHTML = `<img src="${data.img}" alt="Viewport screen preview">`;
});

// Error notifications
socket.on('operation-failed', (data) => {
  appendTerminalLine(`❌ Failure: ${data.error}`, 'error-msg');
  setLoading(false);
});

// UI Actions Interaction Handling
btnSubmit.onclick = () => {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  setLoading(true);
  appendTerminalLine(`🚀 Deploying prompt to active workspace...`, 'system-msg');
  socket.emit('submit-prompt', { prompt });
};

btnCancel.onclick = () => {
  socket.emit('cancel-build');
  appendTerminalLine('❌ Cancel command submitted.', 'system-msg');
};

btnSnapshot.onclick = () => {
  socket.emit('capture-snapshot');
};

btnReloadDashboard.onclick = () => {
  appendTerminalLine('🔄 Rescraping Lovable projects dashboard...', 'system-msg');
  socket.emit('get-projects');
};

btnStopBrowser.onclick = () => {
  socket.emit('stop-session');
  appendTerminalLine('🛑 Chromium termination signal sent. Browser context closed.', 'system-msg');
};

// Input character limit helper
promptInput.oninput = () => {
  charCounter.textContent = `${promptInput.value.length} chars`;
};

promptInput.onkeydown = (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    btnSubmit.click();
  }
};

function insertPrompt(text) {
  promptInput.value = text;
  charCounter.textContent = `${text.length} chars`;
  promptInput.focus();
}

function appendTerminalLine(text, className = '') {
  const line = document.createElement('div');
  line.className = `terminal-line ${className}`;
  line.textContent = text;
  terminalOutput.appendChild(line);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function setLoading(isLoading) {
  btnSubmit.disabled = isLoading;
  btnCancel.disabled = !isLoading;
  progressIndicator.textContent = isLoading ? 'Processing' : 'Idle';
  progressIndicator.className = `build-step ${isLoading ? 'active' : ''}`;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
