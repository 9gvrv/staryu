# staryu

A local-first CLI that finds GitHub repositories worth starring, asks before
starring anything, and keeps every star organized in one public GitHub list
named `staryu`.

- No server, worker, cron job, or telemetry.
- Your token and data stay on your machine.
- Every discovered candidate is stored in SQLite, so `staryu undo` is safe even
  for repositories you had already starred yourself.

## Quick start

```bash
npx staryu init
npx staryu discover
npx staryu apply
```

Then, any time you star something manually:

```bash
npx staryu sync
```

Or install it globally:

```bash
npm install -g staryu
staryu init
```

## Usage

| Command | What it does |
| --- | --- |
| `staryu init` | Validates your token, fetches your current stars, infers preferences, saves the config, and optionally backfills the `staryu` list. |
| `staryu discover` | Searches GitHub, filters and enriches candidates, scores them deterministically, and stores them. It does not change anything on GitHub. |
| `staryu apply` | Shows stored candidates, lets you pick which ones to star, then stars them and adds them to the `staryu` list. Always asks first unless you pass `--yes`. |
| `staryu sync` | Adds every starred repository to the `staryu` list. It never unstars and preserves membership in your other lists. |
| `staryu undo` | Reverses the most recent `apply` run. Only repositories starred *by staryu* are unstared. |
| `staryu status` | Shows paths, account, list state, rate limit, and database statistics. |

Useful flags:

```bash
staryu --debug                 # print GitHub requests
staryu apply --run 12          # use candidates from a specific discover run
staryu apply --yes             # apply the top N without prompts (explicit opt-in)
staryu undo --yes              # undo without a confirmation prompt
```

## Requirements

- Node.js **22.13+** (Node 24 recommended). `node:sqlite` is used without an
  experimental flag from 22.13 onward.
- Bun is supported as well, but it is not required.
- A GitHub personal access token.

`npx staryu` runs on Node, so the package uses `node:sqlite` instead of
`bun:sqlite`. There are no native dependencies.

## Token

Create a **classic** personal access token with the `repo` scope (or
`public_repo` if you only care about public repositories) and the `user` scope.
GitHub Lists are still a public preview feature. Fine-grained tokens may be
rejected for starring and list creation or membership updates, so the full
star + list flow needs a classic token.

Use this pre-filled link to create the right token:

<https://github.com/settings/tokens/new?scopes=repo,user&description=staryu>

`staryu init` prints the same link when it needs a token.

`staryu init` stores the token in a `0600` credentials file. You can bypass the
saved file with:

```bash
GITHUB_TOKEN=ghp_xxx staryu discover
```

`GH_TOKEN` works too. Environment variables take precedence over the saved file.

## Local data

Paths follow the operating system:

| OS | Config | Database |
| --- | --- | --- |
| Linux | `~/.config/staryu/` | `~/.local/share/staryu/staryu.db` |
| macOS | `~/Library/Application Support/staryu/` | `~/Library/Application Support/staryu/staryu.db` |
| Windows | `%APPDATA%\staryu\` | `%LOCALAPPDATA%\staryu\staryu.db` |

Override them with `STARYU_CONFIG_DIR`, `STARYU_DATA_DIR`, or `STARYU_DB_FILE`.

The config lives in `config.json` and the credentials in `credentials.json`.
The SQLite database keeps four tables:

- `repos` — every candidate ever seen, plus `starred_via` (`user`, `tool`, or
  `unknown`) and `list_added_via`.
- `runs` — each command invocation and its summary.
- `run_candidates` — the scored candidates for a run, with outcomes.
- `actions` — the audit log used by `undo`.

## Configuration

`staryu init` writes a JSON file like this:

```json
{
  "version": 1,
  "github": {
    "login": "octocat",
    "list": {
      "name": "staryu",
      "description": "Repositories I use and want to contribute to. Curated by staryu.",
      "private": false
    }
  },
  "preferences": {
    "languages": ["TypeScript", "Rust"],
    "stars": { "min": 100, "max": 50000 },
    "topics": {
      "include": ["cli", "developer-tools"],
      "exclude": ["awesome", "awesome-list"]
    },
    "activity": { "pushedWithinDays": 180 },
    "license": {
      "required": false,
      "allow": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "MPL-2.0"]
    },
    "contribution": {
      "enabled": true,
      "labels": ["good first issue", "help wanted", "first-timers-only", "up-for-grabs"],
      "minGoodFirstIssues": 0,
      "requireAnySignal": false
    }
  },
  "run": {
    "maxNewStars": 20,
    "candidatePool": 60,
    "search": { "perPage": 50, "pagesPerQuery": 1, "maxQueries": 8 },
    "enrich": { "enabled": true, "batchSize": 20, "deep": true }
  }
}
```

The file is validated on load. Missing fields fall back to defaults; unknown
fields are preserved but not used.

## How discovery works

1. Build search queries from your languages, star range, activity window,
   topics, and optional license requirement.
2. Run one general query and one beginner-friendly query per language
   (`good-first-issues:>=1`), then de-duplicate.
3. Apply hard filters: archived, forks, disabled repositories, excluded topics,
   awesome lists, inactivity, and license policy.
4. Enrich the best candidates via GraphQL: exact stars, topics, label counts,
   contributing guide presence, recent outside-merged pull requests, and
   whether you already starred the repository.
5. Score every candidate deterministically from 0 to 100 and record the reasons.
6. Store the candidates. Nothing is starred until `staryu apply` and you
   confirm.

Scoring is deterministic: language match, topic match, star popularity,
recency, contribution signals, and contributing guide presence. An LLM ranker
can be added later without changing the storage model.

## Undo semantics

`staryu undo` reverses the latest successful `apply` run:

- Repositories the tool added to the list are removed from the `staryu` list
  only. Membership in your other lists is preserved.
- A repository is unstared only when staryu starred it (recorded as
  `starred_via = 'tool'`) and it is still starred.
- Repositories you had already starred are never unstared.

The original run is marked `undone`, so running `staryu undo` twice does not
repeat the same reversal.

## Development

```bash
bun install
bun check          # type check
bun test           # unit tests
bun run build      # bundle dist/index.js for Node
node dist/index.js --help
```

The CLI is bundled with Bun targeting Node. The source uses `node:sqlite`,
`fetch`, and no native modules, so the same `dist/` output works with `npx`,
`bunx`, and global npm installs.

## Limitations

- GitHub Lists are still a public preview API. List failures are reported as
  partial runs and can be repaired with `staryu sync`.
- Discovery uses GitHub search, which is limited to 30 requests per minute for
  authenticated users. `discover` is intentionally small.
- Classic tokens report scopes through a header; fine-grained tokens do not, so
  scope warnings only appear when GitHub provides that header.

## License

MIT
