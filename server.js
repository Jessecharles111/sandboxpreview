const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');
const ts = require('typescript');

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
// Vanilla bundler (unchanged)
function bundleVanillaProject(files) {
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

  let cssInjection = '';
  let jsInjection = '';
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith('.css')) {
      cssInjection += `<style>/* ${filePath} */\n${content}\n</style>\n`;
    } else if (filePath.endsWith('.js')) {
      jsInjection += `<script>/* ${filePath} */\n${content}\n</script>\n`;
    }
  }

  if (cssInjection || jsInjection) {
    if (htmlContent.includes('</head>')) {
      htmlContent = htmlContent.replace('</head>', `${cssInjection}\n${jsInjection}\n</head>`);
    } else if (htmlContent.includes('<body')) {
      htmlContent = htmlContent.replace('<body', `<head>${cssInjection}\n${jsInjection}</head><body`);
    } else {
      htmlContent = `<!DOCTYPE html><html><head>${cssInjection}\n${jsInjection}</head><body>${htmlContent}</body></html>`;
    }
  }
  return htmlContent;
}

// ----------------------------------------------------------------------
// React bundler – now with bulletproof exports stripping
function bundleReactProject(files) {
  let originalHtml = files['index.html'] || files['index.htm'] || '';

  let headContent = '<meta charset="UTF-8"><title>React Preview</title>';
  if (originalHtml) {
    const titleMatch = originalHtml.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) headContent = `<title>${titleMatch[1]}</title>`;
    const metaMatches = originalHtml.match(/<meta[^>]+>/g);
    if (metaMatches) {
      headContent = metaMatches.join('\n') + '\n' + headContent;
    }
  }

  let allJsCode = '';
  let defaultExportName = null;

  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith('.js') || filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      let cleaned = content;

      if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        // Compile TypeScript
        const compiled = ts.transpileModule(content, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
            jsx: ts.JsxEmit.React,
            strict: false,
            esModuleInterop: false,      // avoid extra helpers
            allowSyntheticDefaultImports: false,
          },
        });
        cleaned = compiled.outputText;

        // 💥 Aggressively remove any line that contains 'exports' or '__esModule'
        const lines = cleaned.split('\n');
        const filtered = lines.filter(line => {
          const l = line.trim();
          if (l.startsWith('Object.defineProperty(exports,')) return false;
          if (l.includes('exports.__esModule')) return false;
          if (l.includes('exports.default')) return false;
          if (l.includes('exports =')) return false;
          if (l.match(/^\s*exports\.\w+\s*=/)) return false;
          if (l.match(/^\s*__esModule\s*=/)) return false;
          if (l.match(/^\s*export\s*{/)) return false;  // named exports
          return true;
        });
        cleaned = filtered.join('\n');
      }

      // Remove import lines
      cleaned = cleaned.replace(/^\s*import\s+.*?from\s+['"].*?['"]\s*;?\s*$/gm, '');

      // Capture default export identifier
      const defaultMatch = cleaned.match(/^\s*export\s+default\s+(\w+)\s*;?\s*$/m);
      if (defaultMatch) {
        defaultExportName = defaultMatch[1];
        cleaned = cleaned.replace(/^\s*export\s+default\s+\w+\s*;?\s*$/m, '');
      } else {
        const inlineMatch = cleaned.match(/^\s*export\s+default\s+(function|class)\s+(\w+)\s*/);
        if (inlineMatch) {
          defaultExportName = inlineMatch[2];
          cleaned = cleaned.replace(/^\s*export\s+default\s+/, '');
        }
      }

      // Convert named exports to normal variables
      cleaned = cleaned.replace(/^\s*export\s+(const|let|var|function|class)\s+/, '$1 ');
      cleaned = cleaned.replace(/^\s*export\s+/, '');

      allJsCode += `/* ${filePath} */\n${cleaned}\n\n`;
    }
  }

  // Remove any stray 'exports' from the combined code (last resort)
  allJsCode = allJsCode.replace(/\bexports\b/g, '');

  // Make default export available as window.App
  if (defaultExportName) {
    allJsCode += `\n// Ensure the default export is available as window.App\n`;
    allJsCode += `if (typeof ${defaultExportName} !== 'undefined' && typeof window.App === 'undefined') {\n`;
    allJsCode += `  window.App = ${defaultExportName};\n`;
    allJsCode += `}\n`;
  }

  // Auto‑detect component if still missing
  if (!allJsCode.includes('window.App') && !allJsCode.includes('function App(') && !allJsCode.includes('class App')) {
    const appMatch = allJsCode.match(/(?:function|class|const)\s+(\w+)\s*(?:\(|extends|{)/);
    if (appMatch && !allJsCode.includes(`window.App = ${appMatch[1]}`)) {
      allJsCode += `\n// Auto-detected component: ${appMatch[1]}\n`;
      allJsCode += `if (typeof ${appMatch[1]} !== 'undefined' && typeof window.App === 'undefined') {\n`;
      allJsCode += `  window.App = ${appMatch[1]};\n`;
      allJsCode += `}\n`;
    } else {
      allJsCode += `\nfunction App() { return <h1>No React component found. Please export a component.</h1> }\n`;
      allJsCode += `window.App = App;\n`;
    }
  }

  // Inject React hooks into global scope
  const hookSetup = `const { useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer, useImperativeHandle, useLayoutEffect, useDebugValue } = React;\n`;

  let finalHtml = `<!DOCTYPE html>
<html>
<head>
  ${headContent}
  <script src="https://cdn.jsdelivr.net/npm/react@18.2.0/umd/react.development.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.development.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    // Make React hooks available
    ${hookSetup}
    // Combined React code (TypeScript already compiled on server):
    ${allJsCode}
    // Render the component
    if (typeof window.App !== 'undefined') {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(window.App));
    } else {
      document.getElementById('root').innerHTML = '<p style="color:red;">⚠️ No React component found. Define a component named "App".</p>';
    }
  </script>
</body>
</html>`;

  // Inject any CSS from files into the head
  let cssInjection = '';
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith('.css')) {
      cssInjection += `<style>/* ${filePath} */\n${content}\n</style>\n`;
    }
  }
  if (cssInjection) {
    finalHtml = finalHtml.replace('</head>', `${cssInjection}\n</head>`);
  }
  return finalHtml;
}

// ----------------------------------------------------------------------
// Framework wrappers for single HTML strings (unchanged)
function wrapReact(html) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>React Preview</title>
  <script src="https://cdn.jsdelivr.net/npm/react@18.2.0/umd/react.development.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.development.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    ${html}
    if (typeof App !== 'undefined') {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(App));
    } else if (typeof MyComponent !== 'undefined') {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(MyComponent));
    } else {
      document.getElementById('root').innerHTML = '<p style="color:red;">⚠️ No React component found. Define a component named "App" or "MyComponent".</p>';
    }
  </script>
</body>
</html>`;
}

function wrapVue(html) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Vue Preview</title>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
</head>
<body>
  <div id="app"></div>
  <script>
    ${html}
    if (typeof app === 'undefined' && typeof Vue !== 'undefined') {
      const defaultApp = {
        template: \`<div>No Vue component defined. Please define a Vue app or component.</div>\`
      };
      Vue.createApp(defaultApp).mount('#app');
    }
  </script>
</body>
</html>`;
}

function wrapSvelte(html) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Svelte Preview</title>
  <script src="https://unpkg.com/svelte@3.59.2/compiler.js"></script>
  <script src="https://unpkg.com/svelte@3.59.2/internal.js"></script>
</head>
<body>
  <div id="target"></div>
  <script>
    const source = \`${html.replace(/`/g, '\\`')}\`;
    try {
      const compiled = svelte.compile(source, { generate: 'dom', format: 'iife' });
      const Component = new Function('target', compiled.js.code);
      Component({ target: document.getElementById('target') });
    } catch (err) {
      document.getElementById('target').innerHTML = '<pre style="color:red;">Svelte compile error: ' + err.message + '</pre>';
    }
  </script>
</body>
</html>`;
}

function wrapAngular(html) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Angular Preview</title>
  <script src="https://unpkg.com/@angular/core@16.2.0/bundles/core.umd.js"></script>
  <script src="https://unpkg.com/@angular/common@16.2.0/bundles/common.umd.js"></script>
  <script src="https://unpkg.com/@angular/platform-browser@16.2.0/bundles/platform-browser.umd.js"></script>
  <script src="https://unpkg.com/@angular/elements@16.2.0/bundles/elements.umd.js"></script>
  <script src="https://unpkg.com/@angular/compiler@16.2.0/bundles/compiler.umd.js"></script>
</head>
<body>
  <my-app></my-app>
  <script>
    ${html}
    if (typeof AppComponent !== 'undefined') {
      const { platformBrowserDynamic } = require('@angular/platform-browser-dynamic');
      platformBrowserDynamic().bootstrapModule(AppModule);
    } else {
      document.body.innerHTML = '<p style="color:red;">Angular component not found. Define an AppComponent.</p>';
    }
  </script>
</body>
</html>`;
}

// ----------------------------------------------------------------------
// API endpoint
app.post('/api/preview', (req, res) => {
  try {
    let { html, files, framework = 'vanilla' } = req.body;

    if (files && typeof files === 'object') {
      let totalSize = 0;
      for (const content of Object.values(files)) {
        totalSize += Buffer.byteLength(content, 'utf8');
        if (totalSize > MAX_FILES_SIZE) {
          return res.status(413).json({ error: 'Total files size exceeds 10MB limit' });
        }
      }
      if (framework === 'react') {
        html = bundleReactProject(files);
        framework = 'vanilla';
      } else {
        html = bundleVanillaProject(files);
        framework = 'vanilla';
      }
    }

    if (typeof html !== 'string') {
      return res.status(400).json({ error: 'Missing "html" string or "files" object.' });
    }

    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_SIZE) {
      html = html.slice(0, MAX_HTML_SIZE);
      console.warn(`⚠️ Preview truncated to ${MAX_HTML_SIZE} bytes`);
    }

    let finalHtml = html;
    if (framework === 'react') {
      finalHtml = wrapReact(html);
    } else if (framework === 'vue') {
      finalHtml = wrapVue(html);
    } else if (framework === 'svelte') {
      finalHtml = wrapSvelte(html);
    } else if (framework === 'angular') {
      finalHtml = wrapAngular(html);
    }

    const id = generateId();
    previews.set(id, { html: finalHtml, createdAt: Date.now() });
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    res.json({ previewUrl, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve previews
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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activePreviews: previews.size,
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Enhanced Preview Engine running on port ${PORT}`);
  console.log(`   Supports: vanilla, react, vue, svelte, angular`);
  console.log(`   Multi‑file: send { "files": { ... } }`);
  console.log(`   Framework: send { "html": "...", "framework": "react" }`);
  console.log(`   TypeScript (TS/TSX) supported for React multi‑file`);
  console.log(`   CORS enabled for all origins`);
});