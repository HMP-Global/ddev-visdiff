#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const cliPath = path.join(projectRoot, 'bin', 'visdiff.mjs');

const liveServer = await startServer();
const localServer = await startServer();

try {
  const workDir = mkdtempSync(path.join(tmpdir(), 'visdiff-smoke-'));
  const configPath = path.join(workDir, '.visdiff.json');
  const reportDir = path.join(workDir, 'reports');

  writeFileSync(configPath, `${JSON.stringify({
    liveBaseUrl: liveServer.url,
    localBaseUrl: localServer.url,
    checks: [
      { name: 'Home', path: '/' },
      { name: 'About', path: '/about' }
    ],
    viewports: [
      { name: 'small', width: 640, height: 480 }
    ],
    threshold: 0,
    waitUntil: 'load',
    fullPage: true
  }, null, 2)}\n`);

  const result = await runCommand(process.execPath, [
    cliPath,
    'run',
    '--config',
    configPath,
    '--report-dir',
    reportDir,
    '--quiet'
  ], {
    cwd: workDir,
    encoding: 'utf8'
  });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
} finally {
  await Promise.all([
    closeServer(liveServer.server),
    closeServer(localServer.server)
  ]);
}

function startServer() {
  const server = http.createServer((request, response) => {
    const title = request.url === '/about' ? 'About' : 'Home';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { margin: 0; font: 16px Arial, sans-serif; color: #20242a; background: #f7f8fa; }
    main { padding: 48px; }
    h1 { margin: 0 0 16px; font-size: 40px; }
    p { margin: 0; max-width: 56ch; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>Stable smoke-test page for visdiff.</p>
  </main>
</body>
</html>`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });

    child.on('error', (error) => {
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}\n` });
    });
  });
}
