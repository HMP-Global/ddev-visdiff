#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_FILE = '.visdiff.json';
const DEFAULT_REPORT_DIR = '.visdiff/reports';
const HOOK_NAME = 'pre-push';
const LEGACY_HOOK_NAME = 'post-commit';
const HOOK_BEGIN = '# >>> visdiff pre-push >>>';
const HOOK_END = '# <<< visdiff pre-push <<<';
const LEGACY_HOOK_BEGIN = '# >>> visdiff post-commit >>>';
const LEGACY_HOOK_END = '# <<< visdiff post-commit <<<';

let browsers;
let PNG;
let pixelmatch;

const defaultConfig = {
  liveBaseUrl: '',
  localBaseUrl: 'auto:ddev',
  checks: [
    { name: 'Home', path: '/' }
  ],
  viewports: [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 }
  ],
  databaseDump: {
    enabled: false,
    runBeforeCompare: false,
    environment: 'production',
    file: '.visdiff/latest.sql',
    import: true,
    importShell: 'mysql --host=db --user=db --password=db db < {file}',
    shell: ''
  },
  stageFileProxy: {
    enabled: false,
    origin: '',
    originDir: '',
    drush: './vendor/bin/drush',
    cacheRebuild: true
  },
  prepareCommands: [],
  threshold: 0.01,
  waitUntil: 'networkidle',
  fullPage: true,
  waitForMedia: true,
  mediaTimeoutMs: 10000,
  freezeMedia: true,
  failOnMediaError: true,
  hideSelectors: [],
  ignoreSelectors: [],
  headers: {},
  liveHeaders: {},
  localHeaders: {}
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const [command = '--help', ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return;
    case 'init':
      await initConfig(args);
      return;
    case 'prepare':
      await prepareSite(args);
      return;
    case 'run':
      await runVisdiff(args);
      return;
    case 'install-hook':
      await installHook(args);
      return;
    case 'install-ddev':
      await installDdev(args);
      return;
    case 'uninstall-hook':
      await uninstallHook(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\nRun "visdiff --help" for usage.`);
  }
}

function printHelp() {
  const canInstallDdev = process.env.DDEV_VISDIFF_RUNNING !== '1';
  const installDdevUsage = canInstallDdev ? '  visdiff install-ddev\n' : '';
  const installDdevCommand = canInstallDdev
    ? '  install-ddev     Install the DDEV Playwright service and ddev visdiff command.\n'
    : '';

  console.log(`visdiff

Usage:
  visdiff init --live <url> [--config .visdiff.json]
  visdiff prepare [--config .visdiff.json]
  visdiff run [--config .visdiff.json] [--report-dir .visdiff/reports]
  visdiff install-hook [--config .visdiff.json]
${installDdevUsage}  visdiff uninstall-hook

Commands:
  init            Create a starter config in the current repository.
  prepare         Run configured preparation steps, such as a Platform DB dump.
  run             Compare configured local pages against live pages.
  install-hook    Add a managed pre-push hook block for this CLI.
${installDdevCommand}  uninstall-hook  Remove the managed pre-push hook block.

Options:
  --live <url>        Live base URL used by init.
  --config <file>     Config file path. Defaults to .visdiff.json.
  --report-dir <dir>  Report directory. Defaults to .visdiff/reports.
  --prepare           Run configured preparation steps before comparison.
  --ddev              Use "ddev visdiff" when installing the Git hook.
  --quiet             Only print failures and final report path.
`);
}

async function initConfig(args) {
  const configPath = path.resolve(args.config || DEFAULT_CONFIG_FILE);
  if (existsSync(configPath) && !args.force) {
    throw new Error(`${configPath} already exists. Use --force to overwrite it.`);
  }

  const config = {
    ...defaultConfig,
    liveBaseUrl: args.live || ''
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Created ${configPath}`);
  if (!config.liveBaseUrl) {
    console.log('Edit liveBaseUrl before running visdiff.');
  }
}

async function runVisdiff(args) {
  const startedAt = new Date();
  const cwd = process.cwd();
  const configPath = path.resolve(args.config || DEFAULT_CONFIG_FILE);
  const config = await loadConfig(configPath);
  const reportDir = path.resolve(args.reportDir || config.reportDir || DEFAULT_REPORT_DIR);
  const runDir = path.join(reportDir, timestampForPath(startedAt));
  const artifactDir = path.join(runDir, 'artifacts');

  mkdirSync(artifactDir, { recursive: true });

  if (args.prepare || config.databaseDump?.runBeforeCompare) {
    await runPreparation(config, cwd, args);
  }

  const localBaseUrl = await resolveLocalBaseUrl(config, cwd);
  const liveBaseUrl = normalizeBaseUrl(config.liveBaseUrl, 'liveBaseUrl');
  const checks = normalizeChecks(config);
  const viewports = normalizeViewports(config.viewports);
  const threshold = normalizeThreshold(config.threshold);

  if (!args.quiet) {
    console.log(`Live:  ${liveBaseUrl}`);
    console.log(`Local: ${localBaseUrl}`);
    console.log(`Checks: ${checks.length}, viewports: ${viewports.length}`);
  }

  await loadVisualDependencies();

  const browserName = resolveBrowserName(config);
  const launchOptions = {
    headless: config.headless !== false
  };
  if (browserName === 'chromium' && config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }
  const browser = await browsers[browserName].launch(launchOptions);

  const results = [];
  let failed = false;

  try {
    for (const check of checks) {
      for (const viewport of viewports) {
        const id = makeArtifactId(check.name || check.path, viewport.name);
        const liveUrl = joinUrl(liveBaseUrl, check.livePath || check.path);
        const localUrl = joinUrl(localBaseUrl, check.localPath || check.path);
        const livePath = path.join(artifactDir, `${id}.live.png`);
        const localPath = path.join(artifactDir, `${id}.local.png`);
        const diffPath = path.join(artifactDir, `${id}.diff.png`);

        if (!args.quiet) {
          console.log(`Checking ${check.name} at ${viewport.name}`);
        }

        try {
          const liveMeta = await capturePage(browser, liveUrl, livePath, viewport, config, headersFor(config, 'live'));
          const localMeta = await capturePage(browser, localUrl, localPath, viewport, config, headersFor(config, 'local'));
          const diff = compareImages(livePath, localPath, diffPath);
          const badStatus = isBadStatus(liveMeta.status) || isBadStatus(localMeta.status);
          const passed = diff.diffRatio <= threshold && !badStatus;
          failed = failed || !passed;

          results.push({
            name: check.name,
            path: check.path,
            viewport,
            liveUrl,
            localUrl,
            livePath: relativePath(runDir, livePath),
            localPath: relativePath(runDir, localPath),
            diffPath: relativePath(runDir, diffPath),
            passed,
            diffPixels: diff.diffPixels,
            totalPixels: diff.totalPixels,
            diffRatio: diff.diffRatio,
            dimensions: diff.dimensions,
            liveStatus: liveMeta.status,
            localStatus: localMeta.status,
            error: ''
          });
        } catch (error) {
          failed = true;
          results.push({
            name: check.name,
            path: check.path,
            viewport,
            liveUrl,
            localUrl,
            livePath: existsSync(livePath) ? relativePath(runDir, livePath) : '',
            localPath: existsSync(localPath) ? relativePath(runDir, localPath) : '',
            diffPath: existsSync(diffPath) ? relativePath(runDir, diffPath) : '',
            passed: false,
            diffPixels: 0,
            totalPixels: 0,
            diffRatio: 1,
            dimensions: null,
            liveStatus: null,
            localStatus: null,
            error: error.message
          });
          console.error(`Failed ${check.name} at ${viewport.name}: ${error.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  const reportPath = path.join(runDir, 'index.html');
  await writeFile(reportPath, renderReport({
    configPath,
    startedAt,
    finishedAt: new Date(),
    liveBaseUrl,
    localBaseUrl,
    threshold,
    results
  }));

  const summary = summarizeResults(results);
  console.log(`${summary.passed}/${summary.total} checks passed.`);
  console.log(`Report: ${reportPath}`);

  if (failed) {
    process.exitCode = 1;
  }
}

async function prepareSite(args) {
  const cwd = process.cwd();
  const configPath = path.resolve(args.config || DEFAULT_CONFIG_FILE);
  const config = await loadConfig(configPath);
  await runPreparation(config, cwd, args);
}

async function runPreparation(config, cwd, args) {
  const commands = normalizePreparationCommands(config);

  if (!commands.length) {
    if (!args.quiet) {
      console.log('No preparation commands are enabled.');
    }
    return;
  }

  for (const command of commands) {
    if (!args.quiet) {
      console.log(`Preparing: ${command.name}`);
    }

    const result = command.shell
      ? spawnSync('bash', ['-lc', `set -euo pipefail\n${command.shell}`], { cwd, stdio: 'inherit', shell: false })
      : spawnSync(command.command, command.args, { cwd, stdio: 'inherit', shell: false });

    if (result.error) {
      throw new Error(`Preparation failed for "${command.name}": ${result.error.message}`);
    }

    if (result.status !== 0) {
      throw new Error(`Preparation failed for "${command.name}" with exit code ${result.status}.`);
    }
  }
}

async function installHook(args) {
  const gitRoot = getGitRoot();
  const hookPath = path.join(gitRoot, '.git', 'hooks', HOOK_NAME);
  const legacyHookPath = path.join(gitRoot, '.git', 'hooks', LEGACY_HOOK_NAME);
  const config = args.config || DEFAULT_CONFIG_FILE;
  const cliPath = path.resolve(__dirname, 'visdiff.mjs');
  const hookCliPath = pathIsInside(cliPath, gitRoot) ? `./${path.relative(gitRoot, cliPath)}` : cliPath;
  const runCommand = args.ddev
    ? `ddev visdiff run --config ${shellQuote(config)}`
    : `node ${shellQuote(hookCliPath)} run --config ${shellQuote(config)}`;
  const block = [
    HOOK_BEGIN,
    'repo_root=$(git rev-parse --show-toplevel)',
    'cd "$repo_root" || exit 0',
    runCommand,
    HOOK_END,
    ''
  ].join('\n');

  let existing = '';
  if (existsSync(hookPath)) {
    existing = await readFile(hookPath, 'utf8');
    existing = removeManagedHookBlock(existing).trimEnd();
  } else {
    existing = '#!/bin/sh';
  }

  if (existsSync(legacyHookPath)) {
    const legacyExisting = await readFile(legacyHookPath, 'utf8');
    const legacyNext = removeManagedHookBlock(legacyExisting, LEGACY_HOOK_BEGIN, LEGACY_HOOK_END).trimEnd();
    if (legacyNext !== legacyExisting.trimEnd()) {
      await writeFile(legacyHookPath, legacyNext ? `${legacyNext}\n` : '');
    }
  }

  const next = `${existing}\n\n${block}`;
  await writeFile(hookPath, next);
  await chmod(hookPath, 0o755);
  console.log(`Installed visdiff ${HOOK_NAME} hook in ${hookPath}`);
}

async function installDdev(args) {
  const gitRoot = getGitRoot();
  const ddevDir = path.join(gitRoot, '.ddev');
  const configPath = path.join(ddevDir, 'config.yaml');
  const toolRoot = path.resolve(__dirname, '..');

  if (!existsSync(configPath)) {
    throw new Error(`DDEV config not found at ${configPath}. Run this from a configured DDEV project.`);
  }

  if (!pathIsInside(toolRoot, gitRoot)) {
    throw new Error('install-ddev expects this tool to live inside the DDEV project repository.');
  }

  const relativeToolDir = path.relative(gitRoot, toolRoot).split(path.sep).join('/') || '.';
  const composePath = path.join(ddevDir, 'docker-compose.visdiff.yaml');
  const serviceDir = path.join(ddevDir, 'visdiff');
  const dockerfilePath = path.join(serviceDir, 'Dockerfile');
  const commandDir = path.join(ddevDir, 'commands', 'host');
  const commandPath = path.join(commandDir, 'visdiff');

  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(commandDir, { recursive: true });

  await writeManagedFile(
    dockerfilePath,
    await readTemplate(path.join('visdiff', 'Dockerfile')),
    args.force
  );

  await writeManagedFile(
    composePath,
    await readTemplate('docker-compose.visdiff.yaml'),
    args.force
  );

  const commandTemplate = await readTemplate(path.join('commands', 'host', 'visdiff'));
  await writeManagedFile(
    commandPath,
    commandTemplate.replaceAll('__VISDIFF_TOOL_DIR__', relativeToolDir),
    args.force
  );
  await chmod(commandPath, 0o755);

  console.log(`Installed DDEV visdiff image build: ${dockerfilePath}`);
  console.log(`Installed DDEV visdiff service: ${composePath}`);
  console.log(`Installed DDEV command: ${commandPath}`);
  console.log('Run "ddev restart" before using "ddev visdiff".');
}

async function uninstallHook() {
  const gitRoot = getGitRoot();
  const hookPath = path.join(gitRoot, '.git', 'hooks', HOOK_NAME);
  const legacyHookPath = path.join(gitRoot, '.git', 'hooks', LEGACY_HOOK_NAME);
  let removed = false;

  if (!existsSync(hookPath)) {
    console.log(`No ${HOOK_NAME} hook exists.`);
  } else {
    const existing = await readFile(hookPath, 'utf8');
    const next = removeManagedHookBlock(existing).trimEnd();
    if (next !== existing.trimEnd()) {
      await writeFile(hookPath, `${next}\n`);
      console.log(`Removed visdiff hook block from ${hookPath}`);
      removed = true;
    }
  }

  if (existsSync(legacyHookPath)) {
    const legacyExisting = await readFile(legacyHookPath, 'utf8');
    const legacyNext = removeManagedHookBlock(legacyExisting, LEGACY_HOOK_BEGIN, LEGACY_HOOK_END).trimEnd();
    if (legacyNext !== legacyExisting.trimEnd()) {
      await writeFile(legacyHookPath, legacyNext ? `${legacyNext}\n` : '');
      console.log(`Removed legacy visdiff hook block from ${legacyHookPath}`);
      removed = true;
    }
  }

  if (!removed) {
    console.log('No visdiff hook block found.');
  }
}

async function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun "visdiff init --live <url>" first.`);
  }

  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  const parsedDatabaseDump = parsed.databaseDump || {};
  const config = {
    ...defaultConfig,
    ...parsed,
    databaseDump: {
      ...defaultConfig.databaseDump,
      ...parsedDatabaseDump
    },
    stageFileProxy: {
      ...defaultConfig.stageFileProxy,
      ...(parsed.stageFileProxy || {})
    }
  };

  if (
    parsed.databaseDump
    && parsedDatabaseDump.import === undefined
    && (parsedDatabaseDump.shell || parsedDatabaseDump.command || parsedDatabaseDump.args)
  ) {
    config.databaseDump.import = false;
  }

  if (!config.liveBaseUrl) {
    throw new Error('Config must include liveBaseUrl.');
  }

  return config;
}

async function readTemplate(templatePath) {
  return readFile(path.resolve(__dirname, '..', 'templates', 'ddev', templatePath), 'utf8');
}

async function loadVisualDependencies() {
  if (browsers && PNG && pixelmatch) {
    return;
  }

  const [playwrightModule, pngModule, pixelmatchModule] = await Promise.all([
    import('playwright'),
    import('pngjs'),
    import('pixelmatch')
  ]);

  browsers = {
    chromium: playwrightModule.chromium,
    firefox: playwrightModule.firefox,
    webkit: playwrightModule.webkit
  };
  PNG = pngModule.PNG;
  pixelmatch = pixelmatchModule.default;
}

function resolveBrowserName(config) {
  const browserName = config.browser || process.env.DDEV_VISDIFF_BROWSER || 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(browserName)) {
    throw new Error(`Unsupported browser: ${browserName}. Use chromium, firefox, or webkit.`);
  }
  return browserName;
}

async function writeManagedFile(filePath, contents, force = false) {
  if (existsSync(filePath) && !force) {
    throw new Error(`${filePath} already exists. Use --force to overwrite it.`);
  }

  await writeFile(filePath, contents);
}

async function resolveLocalBaseUrl(config, cwd) {
  if (!config.localBaseUrl || config.localBaseUrl === 'auto:ddev') {
    const ddevUrl = firstPresentEnv([
      'DDEV_VISDIFF_LOCAL_URL',
      'DDEV_PRIMARY_URL',
      'DDEV_PRIMARY_URL_WITHOUT_PORT'
    ]);
    if (ddevUrl) {
      return normalizeBaseUrl(ddevUrl, 'DDEV URL');
    }

    if (process.env.DDEV_HOSTNAME) {
      return normalizeBaseUrl(`https://${process.env.DDEV_HOSTNAME}`, 'DDEV hostname');
    }

    if (process.env.DDEV_VISDIFF_RUNNING) {
      return normalizeBaseUrl('http://web', 'DDEV web service URL');
    }

    return resolveDdevUrl(cwd);
  }

  return normalizeBaseUrl(config.localBaseUrl, 'localBaseUrl');
}

function firstPresentEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function resolveDdevUrl(cwd) {
  const result = spawnSync('ddev', ['describe', '-j'], {
    cwd,
    encoding: 'utf8'
  });

  if (result.error) {
    throw new Error(`Unable to run "ddev describe -j": ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Unable to resolve DDEV URL. Is this command running inside a DDEV project?\n${result.stderr || result.stdout}`);
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Unable to parse "ddev describe -j" output as JSON: ${error.message}`);
  }

  const candidate = pickDdevUrl(data);
  if (!candidate) {
    throw new Error('Unable to find a primary URL in DDEV describe output. Set localBaseUrl explicitly.');
  }

  return normalizeBaseUrl(candidate, 'DDEV URL');
}

function pickDdevUrl(data) {
  const directKeys = ['primary_url', 'primaryUrl', 'url', 'http_url', 'https_url'];
  for (const key of directKeys) {
    if (typeof data[key] === 'string' && data[key].startsWith('http')) {
      return data[key];
    }
  }

  const arrays = [
    data.urls,
    data.http_urls,
    data.https_urls,
    data.raw?.urls,
    data.raw?.http_urls,
    data.raw?.https_urls
  ];

  for (const value of arrays) {
    if (!Array.isArray(value)) continue;
    const httpsUrl = value.find((item) => typeof item === 'string' && item.startsWith('https://'));
    const httpUrl = value.find((item) => typeof item === 'string' && item.startsWith('http://'));
    if (httpsUrl || httpUrl) return httpsUrl || httpUrl;
  }

  const webUrls = data.webserver?.urls || data.services?.web?.urls;
  if (Array.isArray(webUrls)) {
    return webUrls.find((item) => typeof item === 'string' && item.startsWith('https://'))
      || webUrls.find((item) => typeof item === 'string' && item.startsWith('http://'));
  }

  const deepUrls = findUrlsDeep(data);
  return deepUrls.find((url) => url.startsWith('https://') && url.includes('.ddev.site'))
    || deepUrls.find((url) => url.startsWith('http://') && url.includes('.ddev.site'))
    || deepUrls.find((url) => url.startsWith('https://'))
    || deepUrls.find((url) => url.startsWith('http://'))
    || null;
}

async function capturePage(browser, url, outputPath, viewport, config, headers = {}) {
  const context = await browser.newContext({
    viewport: {
      width: viewport.width,
      height: viewport.height
    },
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
    ignoreHTTPSErrors: config.ignoreHTTPSErrors !== false,
    extraHTTPHeaders: headers
  });

  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: config.waitUntil || 'networkidle',
      timeout: config.timeoutMs || 45000
    });

    if (config.extraWaitMs) {
      await page.waitForTimeout(config.extraWaitMs);
    }

    await waitForMedia(page, config);
    await hideSelectors(page, config.hideSelectors || []);
    await maskSelectors(page, config.ignoreSelectors || []);

    await screenshotWithRetry(page, {
      path: outputPath,
      fullPage: config.fullPage !== false,
      animations: 'disabled',
      caret: 'hide'
    });

    return {
      status: response?.status?.() || null
    };
  } finally {
    await context.close();
  }
}

async function waitForMedia(page, config) {
  if (config.waitForMedia === false) return;

  const media = await page.evaluate(async ({ timeoutMs, freezeMedia }) => {
    const videos = Array.from(document.querySelectorAll('video'));

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.width > 1
        && rect.height > 1;
    }

    function snapshot(video, state) {
      const rect = video.getBoundingClientRect();
      return {
        state,
        readyState: video.readyState,
        currentTime: Number(video.currentTime.toFixed(3)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        src: video.currentSrc || video.querySelector('source')?.src || '',
        error: video.error ? { code: video.error.code, message: video.error.message } : null
      };
    }

    function waitForReady(video) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        return Promise.resolve(snapshot(video, 'ready'));
      }
      if (video.error) {
        return Promise.resolve(snapshot(video, 'error'));
      }

      return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('loadeddata', onReady);
          video.removeEventListener('canplay', onReady);
          video.removeEventListener('error', onError);
        };
        const settle = (state) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(snapshot(video, state));
        };
        const onReady = () => settle('ready');
        const onError = () => settle('error');
        const timer = setTimeout(() => settle('timeout'), timeoutMs);

        video.addEventListener('loadeddata', onReady, { once: true });
        video.addEventListener('canplay', onReady, { once: true });
        video.addEventListener('error', onError, { once: true });
      });
    }

    async function freeze(video) {
      if (!freezeMedia || video.readyState < HTMLMediaElement.HAVE_METADATA) return;

      video.pause();
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
      const target = Math.min(0.25, Math.max(0, duration - 0.1));
      if (Math.abs(video.currentTime - target) < 0.02) return;

      await new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('seeked', onSeeked);
          video.removeEventListener('error', onDone);
        };
        const onDone = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onSeeked = onDone;
        const timer = setTimeout(onDone, 1000);

        video.addEventListener('seeked', onSeeked, { once: true });
        video.addEventListener('error', onDone, { once: true });

        try {
          video.currentTime = target;
        } catch {
          onDone();
        }
      });
    }

    const visibleVideos = videos.filter(isVisible);
    const results = [];
    for (const video of visibleVideos) {
      const ready = await waitForReady(video);
      if (ready.state === 'ready') {
        await freeze(video);
        results.push(snapshot(video, 'ready'));
      } else {
        results.push(ready);
      }
    }
    return results;
  }, {
    timeoutMs: Number(config.mediaTimeoutMs) || 10000,
    freezeMedia: config.freezeMedia !== false
  });

  const failed = media.filter((item) => item.state !== 'ready');
  if (failed.length && config.failOnMediaError !== false) {
    const details = failed
      .map((item) => `${item.state} readyState=${item.readyState} ${item.src || 'unknown media'}`)
      .join('; ');
    throw new Error(`Visible media did not finish rendering before screenshot: ${details}`);
  }
}

async function hideSelectors(page, selectors) {
  if (!selectors.length) return;

  await page.addStyleTag({
    content: selectors.map((selector) => `${selector} { visibility: hidden !important; }`).join('\n')
  });
}

async function maskSelectors(page, selectors) {
  if (!selectors.length) return;

  await page.addStyleTag({
    content: selectors.map((selector) => `${selector} { background: #000 !important; color: #000 !important; box-shadow: none !important; }`).join('\n')
  });
}

async function screenshotWithRetry(page, options) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.screenshot(options);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(250);
    }
  }

  throw lastError;
}

function compareImages(livePath, localPath, diffPath) {
  const live = PNG.sync.read(readFileSync(livePath));
  const local = PNG.sync.read(readFileSync(localPath));
  const width = Math.max(live.width, local.width);
  const height = Math.max(live.height, local.height);
  const normalizedLive = normalizePng(live, width, height);
  const normalizedLocal = normalizePng(local, width, height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    normalizedLive.data,
    normalizedLocal.data,
    diff.data,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: false
    }
  );

  writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  return {
    diffPixels,
    totalPixels,
    diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    dimensions: { width, height }
  };
}

function normalizePng(source, width, height) {
  if (source.width === width && source.height === height) {
    return source;
  }

  const target = new PNG({ width, height, fill: true });
  PNG.bitblt(source, target, 0, 0, source.width, source.height, 0, 0);
  return target;
}

function renderReport(data) {
  const failed = data.results.filter((result) => !result.passed).length;
  const passed = data.results.length - failed;
  const rows = data.results.map((result) => {
    const ratio = formatPercent(result.diffRatio);
    const statusClass = result.passed ? 'pass' : 'fail';
    const dimensions = result.dimensions ? `${result.dimensions.width} x ${result.dimensions.height}` : 'n/a';
    const liveImage = result.livePath
      ? `<img src="${escapeAttribute(result.livePath)}" alt="Live screenshot for ${escapeAttribute(result.name)}">`
      : '<div class="missing">No screenshot</div>';
    const localImage = result.localPath
      ? `<img src="${escapeAttribute(result.localPath)}" alt="Local screenshot for ${escapeAttribute(result.name)}">`
      : '<div class="missing">No screenshot</div>';
    const diffImage = result.diffPath
      ? `<img src="${escapeAttribute(result.diffPath)}" alt="Diff screenshot for ${escapeAttribute(result.name)}">`
      : '<div class="missing">No diff</div>';
    const errorMarkup = result.error ? `<p class="error">${escapeHtml(result.error)}</p>` : '';
    return `<article class="check ${statusClass}">
      <header>
        <div>
          <h2>${escapeHtml(result.name)} <span>${escapeHtml(result.viewport.name)}</span></h2>
          <p>${escapeHtml(result.liveUrl)}<br>${escapeHtml(result.localUrl)}</p>
          ${errorMarkup}
        </div>
        <strong>${result.passed ? 'PASS' : 'FAIL'} · ${ratio}</strong>
      </header>
      <div class="screens">
        <figure>
          <figcaption>Live</figcaption>
          ${liveImage}
        </figure>
        <figure>
          <figcaption>Local</figcaption>
          ${localImage}
        </figure>
        <figure>
          <figcaption>Diff</figcaption>
          ${diffImage}
        </figure>
      </div>
      <dl>
        <div><dt>Diff pixels</dt><dd>${result.diffPixels.toLocaleString()}</dd></div>
        <div><dt>Total pixels</dt><dd>${result.totalPixels.toLocaleString()}</dd></div>
        <div><dt>Viewport</dt><dd>${result.viewport.width} x ${result.viewport.height}</dd></div>
        <div><dt>Compared size</dt><dd>${dimensions}</dd></div>
        <div><dt>Live status</dt><dd>${result.liveStatus || 'n/a'}</dd></div>
        <div><dt>Local status</dt><dd>${result.localStatus || 'n/a'}</dd></div>
      </dl>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>visdiff report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #5d6875;
      --border: #d9dee7;
      --pass: #087f5b;
      --fail: #c92a2a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.15;
    }
    p { color: var(--muted); margin: 0; }
    .counts {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pill {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 6px;
      padding: 8px 12px;
      font-weight: 650;
    }
    .pill.pass { color: var(--pass); }
    .pill.fail { color: var(--fail); }
    .check {
      background: var(--panel);
      border: 1px solid var(--border);
      border-left: 5px solid var(--pass);
      border-radius: 8px;
      margin: 16px 0;
      overflow: hidden;
    }
    .check.fail { border-left-color: var(--fail); }
    .check header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 18px;
    }
    h2 span {
      color: var(--muted);
      font-weight: 500;
    }
    .check strong {
      white-space: nowrap;
      color: var(--pass);
    }
    .check.fail strong { color: var(--fail); }
    .screens {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      background: var(--border);
      border-bottom: 1px solid var(--border);
    }
    figure {
      margin: 0;
      background: #fff;
      min-width: 0;
    }
    figcaption {
      padding: 8px 10px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      font-weight: 650;
    }
    img {
      display: block;
      width: 100%;
      height: auto;
      background: #fff;
    }
    .missing {
      min-height: 180px;
      display: grid;
      place-items: center;
      color: var(--muted);
      background: #fafbfc;
    }
    .error {
      margin-top: 8px;
      color: var(--fail);
      font-weight: 650;
    }
    dl {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 1px;
      margin: 0;
      background: var(--border);
    }
    dl div {
      background: var(--panel);
      padding: 12px 16px;
    }
    dt {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    dd {
      margin: 0;
      font-weight: 650;
    }
    @media (max-width: 900px) {
      main { padding: 16px; }
      .check header { flex-direction: column; }
      .screens, dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="summary">
      <div>
        <h1>visdiff report</h1>
        <p>${escapeHtml(data.liveBaseUrl)} compared with ${escapeHtml(data.localBaseUrl)}</p>
        <p>Started ${escapeHtml(data.startedAt.toISOString())}; threshold ${formatPercent(data.threshold)}</p>
      </div>
      <div class="counts">
        <span class="pill pass">${passed} passed</span>
        <span class="pill fail">${failed} failed</span>
      </div>
    </section>
    ${rows}
  </main>
</body>
</html>
`;
}

function parseArgs(rawArgs) {
  const args = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (rawArgs[index + 1] && !rawArgs[index + 1].startsWith('--')) {
      args[key] = rawArgs[index + 1];
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
}

function getGitRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error('This command must be run inside a Git repository.');
  }

  return result.stdout.trim();
}

function removeManagedHookBlock(contents, begin = HOOK_BEGIN, end = HOOK_END) {
  const pattern = new RegExp(`\\n?${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'm');
  return contents.replace(pattern, '\n');
}

function normalizeBaseUrl(url, label) {
  if (!url || typeof url !== 'string') {
    throw new Error(`${label} must be a URL.`);
  }

  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`${label} must be a valid URL: ${url}`);
  }
}

function normalizeChecks(config) {
  const rawChecks = Array.isArray(config.checks) && config.checks.length
    ? config.checks
    : config.routes;

  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    throw new Error('checks must be a non-empty array.');
  }

  return rawChecks.map((rawCheck) => {
    if (typeof rawCheck === 'string') {
      const pathValue = normalizePath(rawCheck, 'check path');
      return {
        name: pathValue === '/' ? 'Home' : pathValue,
        path: pathValue
      };
    }

    if (!rawCheck || typeof rawCheck !== 'object') {
      throw new Error('Each check must be a string path or an object.');
    }

    const pathValue = normalizePath(rawCheck.path, 'check path');
    return {
      name: rawCheck.name || pathValue,
      path: pathValue,
      livePath: rawCheck.livePath ? normalizePath(rawCheck.livePath, 'check livePath') : null,
      localPath: rawCheck.localPath ? normalizePath(rawCheck.localPath, 'check localPath') : null
    };
  });
}

function normalizePath(value, label) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.startsWith('/') ? value : `/${value}`;
}

function normalizePreparationCommands(config) {
  const commands = [];
  const databaseDump = config.databaseDump || {};

  if (databaseDump.enabled) {
    const environment = databaseDump.environment || 'production';
    const dumpFile = databaseDump.file || '.visdiff/latest.sql';
    const replacements = { environment, file: dumpFile };
    const shellReplacements = {
      environment: shellQuote(environment),
      file: shellQuote(dumpFile)
    };

    if (databaseDump.shell) {
      commands.push({
        name: databaseDump.name || `Platform DB dump (${environment})`,
        shell: interpolate(databaseDump.shell, replacements)
      });
    } else {
      const dumpDir = path.dirname(dumpFile);
      if (dumpDir && dumpDir !== '.') {
        commands.push({
          name: 'Create database dump directory',
          shell: `mkdir -p ${shellQuote(dumpDir)}`
        });
      }

      const command = databaseDump.command || 'platform';
      const args = (databaseDump.args || ['db:dump', '-e', '{environment}', '-y', '--file', '{file}'])
        .map((arg) => interpolate(arg, replacements));

      commands.push({
        name: databaseDump.name || `Platform DB dump (${environment})`,
        command,
        args
      });

      if (databaseDump.import !== false) {
        commands.push({
          name: databaseDump.importName || `Import Platform DB dump (${environment})`,
          shell: interpolate(databaseDump.importShell || defaultConfig.databaseDump.importShell, shellReplacements)
        });
      }
    }
  }

  const stageFileProxy = config.stageFileProxy || {};
  if (stageFileProxy.enabled) {
    const origin = stageFileProxy.origin || config.liveBaseUrl;
    if (!origin) {
      throw new Error('stageFileProxy.origin or liveBaseUrl must be set when stageFileProxy.enabled is true.');
    }

    const drush = stageFileProxy.drush || './vendor/bin/drush';
    commands.push({
      name: 'Enable Stage File Proxy',
      command: drush,
      args: ['pm:enable', 'stage_file_proxy', '-y']
    });
    commands.push({
      name: 'Configure Stage File Proxy origin',
      command: drush,
      args: ['config:set', 'stage_file_proxy.settings', 'origin', origin, '-y']
    });

    if (stageFileProxy.originDir) {
      commands.push({
        name: 'Configure Stage File Proxy origin directory',
        command: drush,
        args: ['config:set', 'stage_file_proxy.settings', 'origin_dir', stageFileProxy.originDir, '-y']
      });
    }

    if (stageFileProxy.cacheRebuild !== false) {
      commands.push({
        name: 'Rebuild Drupal caches',
        command: drush,
        args: ['cache:rebuild']
      });
    }
  }

  for (const rawCommand of config.prepareCommands || []) {
    if (typeof rawCommand === 'string') {
      commands.push({
        name: rawCommand,
        shell: rawCommand
      });
      continue;
    }

    if (rawCommand.enabled === false) continue;

    if (rawCommand.shell) {
      commands.push({
        name: rawCommand.name || rawCommand.shell,
        shell: rawCommand.shell
      });
      continue;
    }

    if (!rawCommand.command) {
      throw new Error('Each prepareCommands entry must include command or shell.');
    }

    commands.push({
      name: rawCommand.name || rawCommand.command,
      command: rawCommand.command,
      args: Array.isArray(rawCommand.args) ? rawCommand.args.map(String) : []
    });
  }

  return commands;
}

function headersFor(config, side) {
  return {
    ...(config.headers || {}),
    ...(side === 'live' ? config.liveHeaders || {} : config.localHeaders || {})
  };
}

function interpolate(value, replacements) {
  return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
    Object.hasOwn(replacements, key) ? replacements[key] : match
  ));
}

function normalizeViewports(viewports) {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new Error('viewports must be a non-empty array.');
  }

  return viewports.map((viewport) => {
    if (!viewport.name || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) {
      throw new Error('Each viewport must include name, width, and height.');
    }
    return viewport;
  });
}

function normalizeThreshold(threshold) {
  const value = Number(threshold);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('threshold must be a number from 0 to 1.');
  }
  return value;
}

function joinUrl(baseUrl, route) {
  return new URL(route, `${baseUrl}/`).toString();
}

function makeArtifactId(route, viewportName) {
  const cleanRoute = route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const cleanViewport = viewportName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  return `${cleanRoute || 'route'}-${cleanViewport || 'viewport'}`.toLowerCase();
}

function isBadStatus(status) {
  return Number.isInteger(status) && status >= 400;
}

function pathIsInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findUrlsDeep(value, urls = []) {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      urls.push(value);
    }
    return urls;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findUrlsDeep(item, urls);
    }
    return urls;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      findUrlsDeep(item, urls);
    }
  }

  return urls;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function summarizeResults(results) {
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length
  };
}

function relativePath(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
