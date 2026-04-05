const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const { Sandbox } = require('@e2b/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const sandboxes = new Map();
const PREVIEW_TTL_MS = 60 * 60 * 1000;

// Get API key from environment
const E2B_API_KEY = process.env.E2B_API_KEY;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sandboxes.entries()) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) {
      entry.sandbox?.close();
      sandboxes.delete(id);
    }
  }
}, 30 * 60 * 1000);

app.post('/api/preview', async (req, res) => {
  try {
    let { html, files } = req.body;
    if (typeof html === 'string') {
      files = { 'index.html': html };
    }
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ error: 'Missing "html" or "files"' });
    }

    // Create sandbox with explicit API key
    const sandbox = await Sandbox.create({ apiKey: E2B_API_KEY });
    
    for (const [filePath, content] of Object.entries(files)) {
      await sandbox.files.write(filePath, content);
    }

    // Run npm install
    const installProc = await sandbox.process.exec('npm install');
    await installProc.wait();

    // Start dev server
    const devProc = await sandbox.process.exec('npm run dev', { background: true });
    
    // Wait for port 5173
    await sandbox.waitForPort(5173, { timeout: 60000 });
    const url = sandbox.getHostname(5173);
    
    const id = generateId();
    sandboxes.set(id, { sandbox, url, createdAt: Date.now() });
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = sandboxes.get(id);
  if (!entry) {
    return res.status(404).send(`<!DOCTYPE html><html><body><h2>Preview not found or expired</h2></body></html>`);
  }
  const sandboxUrl = entry.url;
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html { width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; background: white; }
    .loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: #0f1117;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 16px;
      z-index: 100;
      font-family: system-ui, sans-serif;
      transition: opacity 0.3s ease;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(99,102,241,0.3);
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { color: #8b9bb0; font-size: 14px; }
  </style>
</head>
<body>
  <div id="loading" class="loading-overlay">
    <div class="spinner"></div>
    <div class="loading-text">⏳ Preparing preview (npm install & dev server)...</div>
  </div>
  <iframe id="preview-frame" src="${sandboxUrl}" sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals" onload="document.getElementById('loading').style.display='none'"></iframe>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activePreviews: sandboxes.size });
});

app.listen(PORT, () => {
  console.log(`🚀 E2B Sandbox Preview Engine running on port ${PORT}`);
});
