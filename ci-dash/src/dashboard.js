'use strict';

const { App } = require('./app');

const USAGE = `CI Dash - run GitHub Actions workflows from a Herdr pane

Usage: node src/dashboard.js [options]

Options:
  --quick      Start with the compact panel layout
  --diagnose   Print repository and workflow diagnostics as JSON and exit
  -h, --help   Show this help

Environment:
  CI_DASH_REPO   Override the repository (owner/repo or host/owner/repo)
  GH_BIN         Path to the GitHub CLI binary (default: gh)

The panel needs an interactive terminal. Open it with the plugin action or
"herdr plugin pane open --plugin <id> --entrypoint dashboard".`;

function parseArgs(argv) {
  const options = { quick: false, diagnose: false, help: false };

  for (const arg of argv) {
    switch (arg) {
      case '--quick':
        options.quick = true;
        break;
      case '--diagnose':
        options.diagnose = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const app = new App({
    cwd: process.env.CI_DASH_CWD || process.cwd(),
    quick: options.quick,
    diagnose: options.diagnose,
  });

  const restore = () => {
    if (app.tui) {
      try {
        app.tui.stop();
      } catch {
        // The terminal may already be gone.
      }
    }
  };

  process.on('uncaughtException', (error) => {
    restore();
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });

  process.on('unhandledRejection', (error) => {
    restore();
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    restore();
    process.exit(0);
  });

  app
    .run()
    .catch((error) => {
      restore();
      process.stderr.write(`${error?.stack || error}\n`);
      process.exit(1);
    });
}

main();
