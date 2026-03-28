const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for previews: { id: { html, createdAt } }
const previews = new Map();

// TTL: previews expire after 60 minutes (3600000 ms)
const PREVIEW_TTL_MS = 60 * 60 * 1000;

// Max HTML size (5 MB) – prevents memory abuse
const MAX_HTML_SIZE = 5 * 1024 * 1024;

// Cleanup interval: run every 30 minutes
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------
// Helper: generate a short random ID (like "abc123def")
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// ----------------------------------------------------------------------
// Background cleanup: remove expired previews
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

// Run cleanup on startup and periodically
setInterval(cleanupPreviews, CLEANUP_INTERVAL_MS);
cleanupPreviews(); // initial call

// ----------------------------------------------------------------------
// API: create a new preview
app.post('/api/preview', (req, res) => {
  try {
    let { html } = req.body;

    // Validate input
    if (typeof html !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "html" field (must be a string).' });
    }

    // Truncate overly large payload (prevent memory exhaustion)
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_SIZE) {
      html = html.slice(0, MAX_HTML_SIZE);
      console.warn(`⚠️  Preview truncated to ${MAX_HTML_SIZE} bytes`);
    }

    // Generate unique ID and store
    const id = generateId();
    previews.set(id, {
      html,
      createdAt: Date.now(),
    });

    // Return preview URL
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id });
  } catch (err) {
    console.error('Error creating preview:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------------
// Serve a preview (raw HTML)
app.get('/preview/:id', (req, res) => {
  const { id } = req.params;
  const entry = previews.get(id);

  if (!entry) {
    // If not found, show a friendly 404 page instead of raw error
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

  // Update last access time (optional, to keep alive? We'll just keep TTL fixed)
  // Directly serve the HTML with proper headers
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Optional: add sandbox headers (allows scripts but restricts top navigation)
  // This is a good practice for isolation
  res.setHeader('Content-Security-Policy', "sandbox allow-same-origin allow-scripts allow-popups allow-forms");

  res.send(entry.html);
});

// ----------------------------------------------------------------------
// Health check (for uptime monitors)
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
  console.log(`🚀 Sandbox Preview Engine running on port ${PORT}`);
  console.log(`   Demo UI: http://localhost:${PORT}`);
  console.log(`   API: POST /api/preview`);
  console.log(`   Preview: GET /preview/:id`);
});
