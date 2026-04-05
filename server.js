const express = require('express');
const { exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const sandboxes = new Map();

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, data] of sandboxes.entries()) {
    if (now - data.createdAt > 60 * 60 * 1000) {
      if (data.proc) data.proc.kill();
      await fs.rm(data.dir, { recursive: true, force: true });
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

    const id = generateId();
    const dir = path.join('/tmp', id);
    await fs.mkdir(dir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    if (files['package.json']) {
      await new Promise((resolve, reject) => {
        exec('npm install', { cwd: dir }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    const port = 3000 + Math.floor(Math.random() * 1000);
    let devProcess;

    if (files['vite.config.js']) {
      devProcess = exec(`npx vite --port ${port} --host`, { cwd: dir });
    } else if (files['package.json']) {
      const pkg = JSON.parse(files['package.json']);
      if (pkg.scripts && pkg.scripts.dev) {
        devProcess = exec('npm run dev', { cwd: dir });
      } else if (pkg.scripts && pkg.scripts.start) {
        devProcess = exec('npm run start', { cwd: dir });
      } else {
        devProcess = exec('node index.js', { cwd: dir });
      }
    } else {
      const http = require('http');
      const staticServer = http.createServer(async (req, res) => {
        const filePath = path.join(dir, req.url === '/' ? 'index.html' : req.url);
        try {
          const data = await fs.readFile(filePath);
          res.writeHead(200);
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      staticServer.listen(port, () => {
        sandboxes.set(id, { dir, url: `http://localhost:${port}`, createdAt: Date.now(), proc: staticServer });
        res.json({ previewUrl: `${req.protocol}://${req.get('host')}/preview/${id}` });
      });
      return;
    }

    devProcess.stdout?.on('data', (data) => console.log(data.toString()));
    devProcess.stderr?.on('data', (data) => console.error(data.toString()));
    await new Promise(r => setTimeout(r, 2000));

    const url = `http://localhost:${port}`;
    sandboxes.set(id, { dir, url, createdAt: Date.now(), proc: devProcess });
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
    return res.status(404).send('<!DOCTYPE html><html><body><h2>Preview not found or expired</h2></body></html>');
  }
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preview</title><style>body,html{margin:0;padding:0;width:100%;height:100%}iframe{width:100%;height:100%;border:none}</style></head><body><iframe src="${entry.url}"></iframe></body></html>`;
  res.send(html);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activePreviews: sandboxes.size });
});

app.listen(PORT, () => {
  console.log(`🚀 Docker Sandbox Orchestrator running on port ${PORT}`);
});
