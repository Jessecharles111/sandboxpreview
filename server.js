const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const previews = new Map();
const PREVIEW_TTL_MS = 60 * 60 * 1000;
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
// Serve preview page with esbuild-wasm + iframe
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
  <title>Preview Sandbox</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html { width: 100%; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, 'Segoe UI', monospace; }
    #toolbar {
      background: #1e1e2f;
      color: white;
      padding: 8px 16px;
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
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    #run-btn:hover { background: #0a7; }
    #container { height: calc(100% - 45px); }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: white;
    }
    #error {
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
  <script src="https://cdn.jsdelivr.net/npm/esbuild-wasm@0.20.2/esbuild.wasm.js"></script>
</head>
<body>
<div id="toolbar">
  <span>⚡ esbuild + iframe sandbox</span>
  <button id="run-btn">▶ Run</button>
</div>
<div id="container">
  <iframe id="preview-frame" title="preview" sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"></iframe>
</div>
<div id="error"></div>

<script>
  const files = ${filesJson};
  const fileMap = new Map(Object.entries(files));
  const iframe = document.getElementById('preview-frame');
  const errorDiv = document.getElementById('error');

  // Helper: rewrite import specifiers to esm.sh CDN
  function rewriteImports(code) {
    return code.replace(/import\\s+.*?from\\s+['"]([^'"]+)['"]/g, (match, specifier) => {
      if (specifier.startsWith('.') || specifier.startsWith('/')) return match;
      return match.replace(specifier, 'https://esm.sh/' + specifier);
    }).replace(/import\\(['"]([^'"]+)['"]\\)/g, (match, specifier) => {
      if (specifier.startsWith('.') || specifier.startsWith('/')) return match;
      return match.replace(specifier, 'https://esm.sh/' + specifier);
    });
  }

  async function bundleAndRun() {
    errorDiv.style.display = 'none';
    iframe.srcdoc = '<div class="loading">⏳ Bundling with esbuild...</div>';

    if (!window.esbuild) {
      errorDiv.textContent = '❌ esbuild failed to load. Check your internet.';
      errorDiv.style.display = 'block';
      iframe.srcdoc = '<div class="loading">⚠️ Failed to load bundler</div>';
      return;
    }

    try {
      await window.esbuild.initialize({
        wasmURL: 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.20.2/esbuild.wasm',
      });
    } catch (err) {
      errorDiv.textContent = '❌ esbuild init error: ' + err.message;
      errorDiv.style.display = 'block';
      return;
    }

    // Determine entry point
    let entryFile = '/index.js';
    if (fileMap.has('/src/index.js')) entryFile = '/src/index.js';
    if (fileMap.has('/src/index.tsx')) entryFile = '/src/index.tsx';
    if (fileMap.has('/index.html')) {
      // Pure HTML: just serve it
      const htmlContent = fileMap.get('/index.html');
      iframe.srcdoc = htmlContent;
      return;
    }

    // Rewrite imports in JS/JSX files
    const rewritten = new Map();
    for (const [path, content] of fileMap.entries()) {
      if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.ts') || path.endsWith('.tsx')) {
        rewritten.set(path, rewriteImports(content));
      } else {
        rewritten.set(path, content);
      }
    }

    // Virtual file system plugin for esbuild
    const fsPlugin = {
      name: 'fs',
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path.startsWith('.') || args.path.startsWith('/')) {
            return { path: args.path, namespace: 'file' };
          }
          return { external: true };
        });
        build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
          const content = rewritten.get(args.path);
          if (content) return { contents: content, loader: 'jsx' };
          return null;
        });
      }
    };

    try {
      const result = await window.esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'SandboxModule',
        platform: 'browser',
        plugins: [fsPlugin],
        loader: { '.js': 'jsx', '.ts': 'tsx', '.tsx': 'tsx' },
        define: { 'process.env.NODE_ENV': '"development"' },
      });

      const bundledCode = result.outputFiles[0].text;

      // Build final iframe HTML with React CDNs (if needed)
      const reactCDNs = `
        <script src="https://cdn.jsdelivr.net/npm/react@18.2.0/umd/react.development.js"><\\/script>
        <script src="https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.development.js"><\\/script>
        <script src="https://cdn.jsdelivr.net/npm/react-router-dom@6.14.2/umd/react-router-dom.development.js"><\\/script>
      `;
      const iframeHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preview</title>${reactCDNs}</head><body><div id="root"></div><script>
        window.onerror = function(msg,url,line,col,error){ parent.postMessage({type:"error",error:msg},"*"); return true; };
        try { ${bundledCode} if (typeof SandboxModule !== "undefined" && SandboxModule.default) { const root = ReactDOM.createRoot(document.getElementById("root")); root.render(React.createElement(SandboxModule.default)); } } catch(err) { parent.postMessage({type:"error",error:err.message},"*"); }
      <\\/script></body></html>`;
      iframe.srcdoc = iframeHtml;
    } catch (err) {
      errorDiv.textContent = '❌ Build error: ' + err.message;
      errorDiv.style.display = 'block';
      iframe.srcdoc = '<div class="loading">⚠️ Build failed</div>';
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'error') {
      errorDiv.textContent = '❌ Runtime Error: ' + event.data.error;
      errorDiv.style.display = 'block';
      setTimeout(() => { errorDiv.style.display = 'none'; }, 8000);
    }
  });

  document.getElementById('run-btn').addEventListener('click', bundleAndRun);
  bundleAndRun();
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
  console.log(`🚀 Reliable esbuild Sandbox running on port ${PORT}`);
});