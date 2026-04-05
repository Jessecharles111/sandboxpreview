const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const previews = new Map();
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_FILES_SIZE = 10 * 1024 * 1024;

app.use(cors());
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

app.get('/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = previews.get(id);
  if (!entry) {
    return res.status(404).send('<!DOCTYPE html><html><body><h2>Preview not found or expired</h2></body></html>');
  }
  const filesJson = JSON.stringify(entry.files);
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebContainer Preview</title>
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; }
    .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.7); color: white; padding: 20px; border-radius: 8px; z-index: 1000; }
  </style>
  <script type="importmap">
    {
      "imports": {
        "@webcontainer/api": "https://esm.sh/@webcontainer/api@1.5.0"
      }
    }
  </script>
</head>
<body>
  <iframe id="preview-frame" sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"></iframe>
  <script type="module">
    import { WebContainer } from '@webcontainer/api';
    const previewId = '${id}';
    const iframe = document.getElementById('preview-frame');
    let webcontainer;

    async function main() {
      try {
        iframe.srcdoc = '<div class="loading">⏳ Booting WebContainer...</div>';
        webcontainer = await WebContainer.boot();
        const res = await fetch('/api/preview/' + previewId);
        if (!res.ok) throw new Error('Failed to load files');
        const { files } = await res.json();
        const mountFiles = {};
        for (const [path, content] of Object.entries(files)) {
          mountFiles[path] = { file: { contents: content } };
        }
        await webcontainer.mount(mountFiles);
        if (files['package.json']) {
          iframe.srcdoc = '<div class="loading">📦 Installing dependencies...</div>';
          const installProcess = await webcontainer.spawn('npm', ['install']);
          await installProcess.exit;
        }
        iframe.srcdoc = '<div class="loading">🚀 Starting dev server...</div>';
        let devProcess;
        if (files['vite.config.js']) {
          devProcess = await webcontainer.spawn('npx', ['vite', '--port', '5173', '--host']);
        } else if (files['next.config.js']) {
          devProcess = await webcontainer.spawn('npx', ['next', 'dev', '--port', '3000']);
        } else if (files['package.json']) {
          const pkg = JSON.parse(files['package.json']);
          if (pkg.scripts && pkg.scripts.dev) {
            devProcess = await webcontainer.spawn('npm', ['run', 'dev']);
          } else if (pkg.scripts && pkg.scripts.start) {
            devProcess = await webcontainer.spawn('npm', ['run', 'start']);
          } else {
            devProcess = await webcontainer.spawn('node', ['index.js']);
          }
        } else {
          const htmlContent = files['index.html'] || '<h1>No index.html found</h1>';
          iframe.srcdoc = htmlContent;
          return;
        }
        webcontainer.on('server-ready', (port, url) => {
          iframe.src = url;
        });
        devProcess.output.pipeTo(new WritableStream({
          write(data) { console.log(data); }
        }));
      } catch (err) {
        console.error(err);
        iframe.srcdoc = '<div style="padding:20px;color:red">Error: ' + err.message + '</div>';
      }
    }
    main();
  </script>
</body>
</html>`;
  res.send(html);
});

app.get('/api/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = previews.get(id);
  if (!entry) {
    return res.status(404).json({ error: 'Preview not found' });
  }
  res.json({ files: entry.files });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activePreviews: previews.size });
});

app.listen(PORT, () => {
  console.log(`🚀 WebContainer Preview Engine running on port ${PORT}`);
});
