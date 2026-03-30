const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for previews
const previews = new Map();

// TTL: previews expire after 60 minutes
const PREVIEW_TTL_MS = 60 * 60 * 1000;

// Max HTML size (5 MB) – for single HTML strings
const MAX_HTML_SIZE = 5 * 1024 * 1024;
// Max total size for multi‑file projects (10 MB)
const MAX_FILES_SIZE = 10 * 1024 * 1024;

// Cleanup interval
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

// Middleware
app.use(express.json({ limit: '10mb' })); // increased for multi‑file
app.use(express.static(path.join(__dirname, 'public')));

// Helper: generate random ID
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// Background cleanup
function cleanupPreviews() {
  const now = Date.now();
  let removed = 0;
  for (const [id, entry] of previews.entries()) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) {
      previews.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`🧹 Cleaned up ${removed} expired preview(s). Active: ${previews.size}`);
  }
}
setInterval(cleanupPreviews, CLEANUP_INTERVAL_MS);
cleanupPreviews();

// ----------------------------------------------------------------------
// Multi‑file bundler: takes a `files` object and returns a single HTML string
function bundleMultiFile(files) {
  // 1. Find the main HTML file
  let htmlContent = files['index.html'] || files['index.htm'];
  if (!htmlContent) {
    // No index file: create a fallback page listing all files
    const fileList = Object.keys(files).map(f => `<li>${f}</li>`).join('');
    htmlContent = `<!DOCTYPE html>
<html>
<head><title>Multi‑File Preview</title></head>
<body>
  <h2>⚠️ No index.html found</h2>
  <p>Available files:</p>
  <ul>${fileList}</ul>
</body>
</html>`;
  }

  // 2. Collect CSS and JS files
  let cssInjection = '';
  let jsInjection = '';
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith('.css')) {
      cssInjection += `<style>/* ${filePath} */\n${content}\n</style>\n`;
    } else if (filePath.endsWith('.js')) {
      jsInjection += `<script>/* ${filePath} */\n${content}\n</script>\n`;
    }
  }

  // 3. Inject CSS and JS into the HTML
  if (cssInjection || jsInjection) {
    if (htmlContent.includes('</head>')) {
      htmlContent = htmlContent.replace('</head>', `${cssInjection}\n${jsInjection}\n</head>`);
    } else if (htmlContent.includes('<body')) {
      htmlContent = htmlContent.replace('<body', `<head>${cssInjection}\n${jsInjection}</head><body`);
    } else {
      // Very minimal HTML – wrap everything
      htmlContent = `<!DOCTYPE html><html><head>${cssInjection}\n${jsInjection}</head><body>${htmlContent}</body></html>`;
    }
  }

  return htmlContent;
}

// ----------------------------------------------------------------------
// API: create a new preview
app.post('/api/preview', (req, res) => {
  try {
    let { html, files } = req.body;

    // Handle multi‑file project
    if (files && typeof files === 'object') {
      // Enforce size limit
      let totalSize = 0;
      for (const content of Object.values(files)) {
        totalSize += Buffer.byteLength(content, 'utf8');
        if (totalSize > MAX_FILES_SIZE) {
          return res.status(413).json({ error: 'Total files size exceeds 10MB limit' });
        }
      }
      html = bundleMultiFile(files);
    }

    // Single HTML string (or after bundling)
    if (typeof html !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "html" field (must be a string).' });
    }

    // Truncate overly large payload
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_SIZE) {
      html = html.slice(0, MAX_HTML_SIZE);
      console.warn(`⚠️  Preview truncated to ${MAX_HTML_SIZE} bytes`);
    }

    const id = generateId();
    previews.set(id, {
      html,
      createdAt: Date.now(),
    });

    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id });
  } catch (err) {
    console.error('Error creating preview:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------------
// Serve a preview
app.get('/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = previews.get(id);

  if (!entry) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Preview Not Found</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 3rem;">
        <h2>🔍 Preview expired or does not exist</h2>
        <p>Previews are automatically removed after 60 minutes.</p>
        <p><a href="/">← Back to demo</a></p>
      </body>
      </html>
    `);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox allow-same-origin allow-scripts allow-popups allow-forms");
  res.send(entry.html);
});

// ----------------------------------------------------------------------
// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activePreviews: previews.size,
    uptime: process.uptime(),
  });
});

// ----------------------------------------------------------------------
// Start server
app.listen(PORT, () => {
  console.log(`🚀 Sandbox Preview Engine (multi‑file ready) running on port ${PORT}`);
  console.log(`   Demo UI: http://localhost:${PORT}`);
  console.log(`   API: POST /api/preview (accepts "html" or "files")`);
  console.log(`   Preview: GET /preview/:id`);
});
