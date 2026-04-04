const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const previews = new Map();
const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_FILES_SIZE = 10 * 1024 * 1024; // 10 MB

app.use(cors({ origin: true, credentials: true, optionsSuccessStatus: 200 }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of previews.entries()) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  }
}, 30 * 60 * 1000);

// ----------------------------------------------------------------------
// API endpoint: store files and return preview URL
app.post('/api/preview', (req, res) => {
  try {
    let { html, files } = req.body;
    if (typeof html === 'string') {
      files = { 'index.html': html };
    }
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ error: 'Missing "html" or "files"' });
    }
    let totalSize = 0;
    for (const content of Object.values(files)) {
      totalSize += Buffer.byteLength(content, 'utf8');
      if (totalSize > MAX_FILES_SIZE) {
        return res.status(413).json({ error: 'Total files size exceeds 10MB limit' });
      }
    }
    const id = generateId();
    previews.set(id, { files, createdAt: Date.now() });
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id });
  } catch (err) {
    console.error(err);
    const id = generateId();
    const fallbackFiles = { 'index.html': `<!DOCTYPE html><html><body><h1>Error</h1><p>${err.message}</p></body></html>` };
    previews.set(id, { files: fallbackFiles, createdAt: Date.now() });
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id, error: err.message });
  }
});

// ----------------------------------------------------------------------
// Serve preview page with Nodepod sandbox
app.get('/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = previews.get(id);
  if (!entry) {
    return res.status(404).send(`<!DOCTYPE html><html><body><h2>Preview not found</h2></body></html>`);
  }

  const files = entry.files;
  const filesJson = JSON.stringify(files).replace(/</g, '\\u003c');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nodepod Sandbox Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html { width: 100%; height: 100%; overflow: hidden; font-family: system-ui, 'Segoe UI', monospace; }
    #toolbar {
      background: #1e1e2f;
      color: white;
      padding: 10px 20px;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #333;
    }
    #run-btn {
      background: #0a5;
      border: none;
      color: white;
      padding: 6px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    #run-btn:hover { background: #0a7; }
    #container { height: calc(100% - 50px); }
    #preview-frame {
      width: 100%;
      height: 100%;
      border: none;
      background: white;
    }
    #error-overlay {
      position: fixed;
      bottom: 20px;
      left: 20px;
      right: 20px;
      background: #ff4444cc;
      backdrop-filter: blur(8px);
      color: white;
      padding: 12px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 13px;
      z-index: 1000;
      display: none;
      max-height: 200px;
      overflow: auto;
      border-left: 4px solid #ff0000;
    }
    .loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.7);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      font-size: 14px;
      z-index: 200;
    }
  </style>
  <!-- Import map for Nodepod -->
  <script type="importmap">
    {
      "imports": {
        "@scelar/nodepod": "https://esm.sh/@scelar/nodepod@0.2.3"
      }
    }
  </script>
</head>
<body>
<div id="toolbar">
  <span>⚡ Nodepod Sandbox (npm install + dev server)</span>
  <button id="run-btn">▶ Run Preview</button>
</div>
<div id="container">
  <iframe id="preview-frame" title="preview" sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"></iframe>
</div>
<div id="error-overlay"></div>

<script type="module">
  import { Nodepod } from '@scelar/nodepod';

  const files = ${filesJson};
  const iframe = document.getElementById('preview-frame');
  const errorDiv = document.getElementById('error-overlay');
  const runBtn = document.getElementById('run-btn');

  async function runSandbox() {
    errorDiv.style.display = 'none';
    iframe.srcdoc = '<div class="loading">⏳ Booting Nodepod...</div>';

    try {
      // 1. Boot Nodepod with the user's files
      const nodepod = await Nodepod.boot({ files });

      // 2. Install npm dependencies if package.json exists
      if (files['package.json']) {
        iframe.srcdoc = '<div class="loading">📦 Installing dependencies (npm install)...</div>';
        await nodepod.install();
      }

      // 3. Detect and start the dev server
      iframe.srcdoc = '<div class="loading">🚀 Starting dev server...</div>';
      let proc;

      // Check for common dev server commands
      if (files['vite.config.js'] || files['vite.config.ts']) {
        proc = await nodepod.spawn('npx', ['vite', '--port', '5173', '--host']);
      } else if (files['next.config.js']) {
        proc = await nodepod.spawn('npx', ['next', 'dev', '--port', '3000']);
      } else if (files['package.json']) {
        const pkg = JSON.parse(files['package.json']);
        if (pkg.scripts && pkg.scripts.dev) {
          proc = await nodepod.spawn('npm', ['run', 'dev']);
        } else if (pkg.scripts && pkg.scripts.start) {
          proc = await nodepod.spawn('npm', ['run', 'start']);
        } else {
          proc = await nodepod.spawn('node', ['index.js']);
        }
      } else {
        // Fallback: serve index.html directly
        const htmlContent = files['index.html'] || '<h1>No index.html found</h1>';
        iframe.srcdoc = htmlContent;
        return;
      }

      // 4. Capture the server URL from stdout
      proc.on('output', (data) => {
        console.log('[Nodepod]', data);
        const match = data.match(/https?:\/\/localhost:\d+/);
        if (match) {
          iframe.src = match[0];
        }
      });

      proc.on('exit', (code) => {
        if (code !== 0) {
          errorDiv.textContent = '❌ Dev server exited with code ' + code;
          errorDiv.style.display = 'block';
        }
      });
    } catch (err) {
      console.error(err);
      errorDiv.textContent = '❌ Sandbox error: ' + err.message;
      errorDiv.style.display = 'block';
      iframe.srcdoc = '<div class="loading">⚠️ Failed to start sandbox</div>';
    }
  }

  runBtn.addEventListener('click', runSandbox);
  runSandbox();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activePreviews: previews.size, uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`🚀 Nodepod Sandbox Preview Engine running on port ${PORT}`);
  console.log(`   Uses Nodepod (browser-native Node.js) for full sandbox`);
  console.log(`   Supports npm install, dev servers, instant previews`);
});