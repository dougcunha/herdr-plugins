# CI Dash

A Herdr plugin that opens a panel for running GitHub Actions workflows in the
current repository. It mirrors the **Run workflow** experience on GitHub:
pick a workflow, pick the branch, fill in every `workflow_dispatch`
input, dispatch the run, and follow it to its final status.

```
╭────────────────────────────────────────────────────────╮
│ ◆ CI Dash         herdrdev/herdr                       │
│ ⎇ main  ›  @ dougcunha                                 │
│                                                        │
│ ❯ 1 Workflow  ›  2 Ref  ›  3 Inputs  ›  4 Run          │
│                                                        │
│ ◆ Workflows                                         6  │
│ ────────────────────────────────────────────────────── │
│ ⌕ press / to filter                                    │
│                                                        │
│   ◆ Build artifacts  .github/workflows/build-artifacts │
│ ❯ ◆ Release              .github/workflows/release.yml │
│   ...                                                  │
╰────────────────────────────────────────────────────────╯
```

## Requirements

- Herdr 0.9.0 or newer.
- Node.js 20 or newer.
- The [GitHub CLI](https://cli.github.com/) installed and authenticated with
  `gh auth login`. The token needs:

  - `repo` scope for private repositories (or `public_repo` for public ones),
  - permission to create workflow runs (`actions:write`),
  - SSO authorization if the organization enforces it.

CI Dash never stores credentials. Every API call goes through `gh`, so the
existing GitHub CLI session is reused.

## Install

From this directory:

```sh
npm ci --omit=dev
herdr plugin link .
```

Then invoke the action:

```sh
herdr plugin action invoke ci-dash.open
```

Keybindings are added automatically on the first Herdr server start after the
plugin is linked:

| Key             | Action         | Placement                                    |
| --------------- | -------------- | -------------------------------------------- |
| `prefix+alt+g`  | `ci-dash.open` | Panel split to the left of the focused pane. |
| `prefix+alt+q`  | `ci-dash.quick`| Transient popup.                             |

Herdr's built-in sidebar (workspaces, tabs and agents) is part of the UI and
cannot be extended by plugins. The closest a plugin can get is a split pane:
`ci-dash.open` splits the focused pane, swaps the dashboard to the left edge,
and shrinks it so it behaves like a side panel. It falls back to a tab when
there is no pane to split. Use `ci-dash.tab` when you want a full tab instead.

The plugin appends a marked block to `config.toml`, choosing the first free
combinations if those keys are already bound. To add them immediately instead
of waiting for the next server start:

```sh
herdr plugin action invoke ci-dash.setup-keys
```

The block is delimited by `# ci-dash:begin` and `# ci-dash:end`. Remove it to
disable the shortcuts; CI Dash will not add it again unless you run the
`setup-keys` action. A one-time backup is written next to the config as
`config.toml.ci-dash.bak`. Set `CI_DASH_NO_NOTIFY=1` to suppress the
confirmation notification. If your terminal or tmux intercepts Alt
combinations, change the two keys inside the block.

Four actions are available:

| Action                | Placement                      | Behavior                                                |
| --------------------- | ------------------------------ | ------------------------------------------------------- |
| `ci-dash.open`        | Split pane on the left.        | Opens the dashboard panel next to the focused pane, or a tab when there is nothing to split. |
| `ci-dash.tab`         | New tab.                       | Opens the dashboard in a full tab.                      |
| `ci-dash.quick`       | Popup.                         | Opens a transient popup, falling back to a tab if the Herdr build does not support popups. |
| `ci-dash.setup-keys`  | —                              | Adds the keybindings to `config.toml` again.            |

The pane opens in the workspace directory (or the focused pane's working
directory), not in the plugin directory. The panel can be resized with the
normal Herdr pane resize keys.

To unlink the plugin:

```sh
herdr plugin unlink ci-dash
```

## Usage

1. **Workflow** – select a workflow file, or press `/` to filter by name or
   path. Only active workflows that declare `workflow_dispatch` on the default
   branch are listed. `r` reloads the list.
2. **Ref** – select the branch to run from (set `CI_DASH_INCLUDE_TAGS=1` to
   also list tags). The branch of the focused pane and the repository default
   branch are marked.
3. **Inputs** – every input declared under
   `on.workflow_dispatch.inputs` is shown with its type, description, default
   value, required flag, and, for choices, the allowed options. Workflows that
   declare no inputs skip this step and go straight to Review.
4. **Review** – confirm the workflow, ref, and values. Nothing is dispatched
   until you press Enter here.
5. **Run** – CI Dash polls the run and shows each job and step until the run
   completes, then sends a Herdr notification with the conclusion. The run
   screen shows an **Open run** button whose click target is the full run URL;
   press Enter or `o` if the terminal does not support hyperlinks.

The input types supported by the GitHub API are handled as follows:

| Type          | Editor                                              |
| ------------- | --------------------------------------------------- |
| `string`      | Free text.                                          |
| `choice`      | Cycle through the declared options with left/right. |
| `boolean`     | Toggle with Enter or Space.                         |
| `number`      | Free text, validated as a number before dispatch.   |
| `environment` | Free text environment name.                         |

### Keyboard

| Key              | Action                                              |
| ---------------- | --------------------------------------------------- |
| `↑` / `↓`        | Move in a list, or between fields.                  |
| `PgUp` / `PgDn`  | Move ten rows at a time.                            |
| `Home` / `End`   | Jump to the first or last row.                      |
| `Enter`          | Select, edit, toggle, confirm, or open the run.     |
| `←` / `→`        | Change a choice value.                              |
| `Tab` / `Shift+Tab` | Next or previous field while editing.            |
| `/`              | Filter workflows or refs.                           |
| `Ctrl+D`         | Review inputs, then dispatch from the review page.  |
| `r`              | Reload the current data or refresh the run.         |
| `o`              | Open the run in the browser (same as `Enter` there). |
| `c`              | Cancel the run.                                     |
| `R`              | Rerun the run with the same inputs.                 |
| `b`              | Go back, or start another workflow from the run screen. |
| `q`              | Quit the panel.                                     |
| `Esc`            | Go back on input screens; on the run screen, back once the run completes. |
| `Ctrl+C`         | Quit.                                               |

## Configuration

| Variable       | Purpose                                                          |
| -------------- | ---------------------------------------------------------------- |
| `CI_DASH_REPO` | Override the repository: `owner/repo` or `host/owner/repo`.      |
| `CI_DASH_CWD`  | Project directory for a plugin pane (set by the open action).    |
| `GH_BIN`       | Path to the `gh` binary when it is not on `PATH`.                |
| `NO_COLOR`     | Disable ANSI colors.                                             |
| `CI_DASH_ASCII` | Set to `1` to use plain ASCII icons and borders.                |
| `CI_DASH_INCLUDE_TAGS` | Set to `1` to also list tags in the ref picker.          |
| `CI_DASH_NO_LINKS` | Set to `1` to disable terminal hyperlinks.                   |
| `CI_DASH_NO_NOTIFY` | Set to `1` to skip the keybinding notification.             |

The dashboard uses a card layout with Unicode icons, a step indicator, and
color depth chosen from `COLORTERM` / `TERM`. Set `CI_DASH_ASCII=1` when the
terminal font or encoding cannot show the icons.

Use `CI_DASH_REPO` when the working directory is not a Git repository or the
remote is not the repository you want:

```sh
CI_DASH_REPO=herdrdev/herdr herdr plugin action invoke ci-dash.open
```

## Diagnostics

Print the resolved repository, authenticated user, workflow list, and a parsed
sample workflow as JSON. Run it from a repository checkout, or set
`CI_DASH_REPO`:

```sh
npm run diagnose
```

or, in PowerShell:

```powershell
$env:CI_DASH_REPO='herdrdev/herdr'
node src/dashboard.js --diagnose
```

Run the tests:

```sh
npm test
```

## How dispatch and tracking work

- Workflows are listed with `GET /repos/{owner}/{repo}/actions/workflows`, then
  each active workflow is read on the default branch to keep only the ones that
  declare `workflow_dispatch`.
- Branches come from the branches REST endpoint. Tags are fetched too only when
  `CI_DASH_INCLUDE_TAGS=1`.
- The selected workflow file is read at the selected ref, and the dispatch
  form is parsed from `on.workflow_dispatch.inputs`.
- Dispatch uses `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches`
  with `return_run_details: true`. If GitHub answers with an empty `204`, the
  run is correlated by workflow, ref (for branches), actor, and creation time.
- While the pane is open, the run is polled with the runs and jobs endpoints,
  at 5-second intervals initially, backing off to 30 seconds for long runs.

## Limitations

- Tracking stops when the pane closes. There is no background daemon, so
  notifications only arrive while CI Dash is open.
- The workflow list shows only active workflows whose default branch declares
  `workflow_dispatch`. Confirming this costs one API request per workflow on
  load. A workflow that adds the trigger only on a feature branch stays hidden
  until it reaches the default branch.
- Inputs must be declared in the workflow YAML. Inputs defined dynamically at
  runtime are not supported by the GitHub API.
- Job and step statuses are shown, but step logs are not streamed.
- Reruns reuse the original inputs; GitHub does not allow changing them.
- The `environment` input is plain text, not a picker of repository
  environments.
- The ref picker lists branches only by default. Set
  `CI_DASH_INCLUDE_TAGS=1` to also list tags. It does not accept a typed ref
  that is not in those lists.
- For very large repositories, the branch list is fetched in full before the
  ref picker opens.

## Security

The plugin runs ordinary Node.js code as your user and calls the full Herdr
CLI, as any Herdr plugin can. It only reads repository metadata and dispatches
workflows you explicitly confirm. Review the source before linking a plugin
from an untrusted source.
