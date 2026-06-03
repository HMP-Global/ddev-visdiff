# ddev-visdiff

A lightweight visual regression CLI that compares a local DDEV site against a live site.

It is designed for DDEV-based local development:

- live screenshots come from `liveBaseUrl`
- local screenshots come from the DDEV network by default
- each site owns its own important page list
- optional preparation commands can refresh the local database from production first
- reports are written as static HTML under `.visdiff/reports/`
- Chromium runs inside a dedicated DDEV service based on the Playwright image
- an optional `pre-push` hook runs `ddev visdiff` before code is pushed

## Setup

Install the add-on from the DDEV project root:

```sh
ddev add-on get HMP-Global/ddev-visdiff
ddev restart
```

The add-on creates:

- `.ddev/docker-compose.visdiff.yaml`
- `.ddev/visdiff/`
- `.ddev/visdiff/Dockerfile`
- `.ddev/commands/host/visdiff`

The `visdiff` service builds from `mcr.microsoft.com/playwright:v1.60.0-noble`, so Chromium is part of DDEV instead of the host machine. The image also installs the Platform.sh CLI and MySQL/PostgreSQL clients for preparation commands. The CLI runtime is vendored under `.ddev/visdiff/`, isolated from the application dependencies.

From the site repository root, create a config:

```sh
ddev visdiff init --live https://example.com
```

Run manually:

```sh
ddev visdiff run
```

Run manually and refresh production content first:

```sh
ddev visdiff run --prepare
```

Install the Git hook from the same site repository:

```sh
ddev visdiff install-hook --ddev
```

Verify the tool from this package checkout:

```sh
npm run check
npm run smoke
```

## npm Fallback

The package is also published to npm for direct CLI development and manual installs:

```sh
npm install --save-dev @hmp-global/ddev-visdiff
npx ddev-visdiff install-ddev
```

The DDEV add-on install is the preferred path for project use.

## Config

`init` creates `.visdiff.json` in the current repository.

```json
{
  "liveBaseUrl": "https://example.com",
  "localBaseUrl": "auto:ddev",
  "checks": [
    { "name": "Home", "path": "/" },
    { "name": "About", "path": "/about" },
    { "name": "Contact", "path": "/contact" }
  ],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 1000 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "databaseDump": {
    "enabled": false,
    "runBeforeCompare": false,
    "environment": "production",
    "command": "platform",
    "args": ["db:dump", "-e", "{environment}", "-y"]
  },
  "prepareCommands": [],
  "threshold": 0.01,
  "waitUntil": "networkidle",
  "fullPage": true,
  "hideSelectors": [],
  "ignoreSelectors": [],
  "headers": {},
  "liveHeaders": {},
  "localHeaders": {}
}
```

`checks` can use different live and local paths when a local route differs:

```json
{
  "checks": [
    {
      "name": "Landing page",
      "path": "/",
      "livePath": "/campaign",
      "localPath": "/campaign?cache-bust=1"
    }
  ]
}
```

DDEV sets `auto:ddev` to `http://web` inside the `visdiff` service. Use `localBaseUrl` when you want to override that:

```json
{
  "localBaseUrl": "http://web"
}
```

Use `localHeaders` for ordinary request headers. Chromium does not allow overriding the `Host` header.

```json
{
  "localBaseUrl": "http://web",
  "localHeaders": {
    "X-Visdiff": "local"
  }
}
```

## Production Content Refresh

Preparation commands run inside the DDEV `visdiff` service.

For most Platform.sh sites, set the environment name per site:

```json
{
  "databaseDump": {
    "enabled": true,
    "runBeforeCompare": true,
    "environment": "production",
    "command": "platform",
    "args": ["db:dump", "-e", "{environment}", "-y"]
  }
}
```

That creates a dump file in the working directory. For a full dump/import refresh against the DDEV database, use a shell preparation command:

```json
{
  "databaseDump": {
    "enabled": true,
    "runBeforeCompare": true,
    "environment": "production",
    "shell": "platform db:dump -e {environment} -y --stdout | mysql --host=db --user=db --password=db db"
  }
}
```

For sites where the main production environment has another name:

```json
{
  "databaseDump": {
    "enabled": true,
    "runBeforeCompare": true,
    "environment": "main"
  }
}
```

If you prefer separate steps, use `prepareCommands`:

```json
{
  "prepareCommands": [
    {
      "name": "Refresh DDEV database from Platform",
      "shell": "platform db:dump -e production -y --stdout | mysql --host=db --user=db --password=db db"
    },
    {
      "name": "Download Platform files",
      "shell": "platform mount:download --all --yes --quiet --project <project-id> --environment production --target=/var/www/html"
    }
  ]
}
```

The Platform CLI needs non-interactive auth inside the container, usually through `PLATFORMSH_CLI_TOKEN`.

Use `ddev visdiff prepare` when you want to refresh content without taking screenshots.

Add generated artifacts to the site repository's `.gitignore`:

```gitignore
.visdiff/reports/
.visdiff/latest.sql
```

## Hook behavior

The DDEV pre-push hook runs `ddev visdiff run --config .visdiff.json`.

When `databaseDump.runBeforeCompare` is true, the hook refreshes content before screenshots. When visual differences exceed the threshold, the command exits with status `1`, prints the report path, and blocks the push.

## Ignoring Unstable Areas

Use `hideSelectors` to hide volatile elements before capture:

```json
{
  "hideSelectors": [".cookie-banner", "[data-testid='timestamp']"]
}
```

Use `ignoreSelectors` to mask areas in both screenshots before comparison:

```json
{
  "ignoreSelectors": [".ad-slot", ".map"]
}
```
