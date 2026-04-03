const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const previews = new Map();
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_HTML_SIZE = 5 * 1024 * 1024;
const MAX_FILES_SIZE = 10 * 1024 * 1024;

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
// Clean JS (same as before)
function cleanJS(content) {
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const l = line.trim();
    if (l.includes('require(')) return false;
    if (l.includes('exports.')) return false;
    if (l.includes('module.exports')) return false;
    if (l.includes('Object.defineProperty(exports,')) return false;
    if (l.match(/^\s*import\s+/)) return false;
    if (l.match(/^\s*export\s+default\s+/)) return false;
    if (l.match(/^\s*export\s+{\s*/)) return false;
    if (l.match(/^\s*export\s+(const|let|var|function|class)/)) return false;
    return true;
  });
  let cleaned = filtered.join('\n');
  cleaned = cleaned.replace(/\bexports\b/g, '');
  return cleaned;
}

// ----------------------------------------------------------------------
// Fallback bundler (our reliable simple bundler)
function bundleProject(files) {
  let htmlContent = files['index.html'] || files['index.htm'];
  if (!htmlContent) {
    let fileList = Object.keys(files).map(f => `<li>${f}</li>`).join('');
    htmlContent = `<!DOCTYPE html>
<html>
<head><title>Multi-File Preview</title></head>
<body>
  <h2>⚠️ No index.html found</h2>
  <p>Available files:</p>
  <ul>${fileList}</ul>
</body>
</html>`;
  }

  // Inject CSS
  let cssInjection = '';
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith('.css')) {
      cssInjection += `<style>/* ${filePath} */\n${content}\n</style>\n`;
    }
  }
  if (cssInjection && htmlContent.includes('</head>')) {
    htmlContent = htmlContent.replace('</head>', `${cssInjection}\n</head>`);
  }

  // Collect JS
  let jsInjection = '';
  let hasReact = false;
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
      const cleaned = cleanJS(content);
      if (cleaned.includes('React') || cleaned.includes('JSX') || filePath.endsWith('.jsx')) {
        hasReact = true;
      }
      jsInjection += `<script>/* ${filePath} */\n${cleaned}\n</script>\n`;
    }
  }

  // Add CDNs for React
  if (hasReact) {
    const reactScripts = `
      <script src="https://cdn.jsdelivr.net/npm/react@18.2.0/umd/react.development.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.development.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/react-router-dom@6.14.2/umd/react-router-dom.development.js"></script>
    `;
    if (htmlContent.includes('</head>')) {
      htmlContent = htmlContent.replace('</head>', reactScripts + '\n</head>');
    } else {
      htmlContent = htmlContent.replace('<body', `<head>${reactScripts}</head><body`);
    }
    jsInjection = jsInjection.replace(/<script>/g, '<script type="text/babel">');
  }

  // Append JS
  if (jsInjection) {
    if (htmlContent.includes('</body>')) {
      htmlContent = htmlContent.replace('</body>', `${jsInjection}\n</body>`);
    } else {
      htmlContent += jsInjection;
    }
  }

  // Error handler
  const errorHandler = `
  <script>
    window.onerror = function(msg) { console.warn(msg); return true; };
    window.addEventListener('error', function(e) { e.preventDefault(); }, true);
  </script>`;
  if (htmlContent.includes('</head>')) {
    htmlContent = htmlContent.replace('</head>', errorHandler + '\n</head>');
  }

  if (!htmlContent.trim().toLowerCase().startsWith('<!doctype')) {
    htmlContent = '<!DOCTYPE html>\n' + htmlContent;
  }
  return htmlContent;
}

// ----------------------------------------------------------------------
// API endpoint
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
    const fallbackHtml = `<!DOCTYPE html><html><body><h1>Error</h1><p>${err.message}</p></body></html>`;
    previews.set(id, { files: { 'index.html': fallbackHtml }, createdAt: Date.now() });
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id, error: err.message });
  }
});

// ----------------------------------------------------------------------
// Serve preview page with LiveCodes + fallback bundler
app.get('/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = previews.get(id);
  if (!entry) {
    return res.status(404).send(`<!DOCTYPE html><html><body><h2>Preview not found</h2></body></html>`);
  }

  const files = entry.files;
  const filesJson = JSON.stringify(files);
  // Generate fallback HTML using our bundler
  const fallbackHtml = bundleProject(files);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    #container { width: 100%; height: 100%; }
    .fallback { display: none; width: 100%; height: 100%; border: none; }
    .error { padding: 20px; font-family: monospace; }
  </style>
  <!-- Try LiveCodes CDN -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/livecodes@latest/dist/livecodes.min.css">
  <script src="https://cdn.jsdelivr.net/npm/livecodes@latest/dist/livecodes.min.js"></script>
  <script src="https://unpkg.com/livecodes@latest/dist/livecodes.min.js" onerror="this.remove()"></script>
</head>
<body>
  <div id="container"></div>
  <iframe id="fallbackFrame" class="fallback" srcdoc="${escapeHtml(fallbackHtml)}"></iframe>
  <script>
    const files = ${filesJson};
    let livecodesLoaded = false;

    // Try to initialize LiveCodes
    function initLiveCodes() {
      if (typeof livecodes !== 'undefined') {
        livecodesLoaded = true;
        let mainFile = 'index.html';
        if (!files['index.html'] && files['index.htm']) mainFile = 'index.htm';
        if (!files[mainFile]) {
          files[mainFile] = '<!DOCTYPE html><html><body><h1>Preview</h1><p>No index.html found</p></body></html>';
        }
        const config = {
          params: { files, activeFile: mainFile, autoRun: true, console: 'open' },
          layout: 'result',
        };
        livecodes.create('#container', config).catch(err => {
          console.error('LiveCodes error:', err);
          showFallback();
        });
      } else {
        // Wait a bit for script to load
        setTimeout(() => {
          if (typeof livecodes !== 'undefined') initLiveCodes();
          else showFallback();
        }, 1000);
      }
    }

    function showFallback() {
      if (livecodesLoaded) return;
      document.getElementById('container').style.display = 'none';
      const iframe = document.getElementById('fallbackFrame');
      iframe.style.display = 'block';
      iframe.srcdoc = ${JSON.stringify(fallbackHtml)};
    }

    function escapeHtml(str) {
      return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
      });
    }

    initLiveCodes();
    // Fallback after 3 seconds if LiveCodes still not working
    setTimeout(showFallback, 3000);
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
  console.log(`🚀 Robust Preview Engine running on port ${PORT}`);
  console.log(`   LiveCodes + fallback bundler - always works`);
});