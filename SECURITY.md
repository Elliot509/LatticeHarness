# Security policy

## Supported versions

Lattice `0.0.0` is a prerelease. Security fixes apply to the current
development HEAD until a stable release line is declared.

## Reporting a vulnerability

Report vulnerabilities privately to the repository maintainers. If GitHub
offers private vulnerability reporting in the Security tab, use that route;
otherwise contact the maintainers privately before sharing details. Do not
open a public issue with exploit details.

Please include: affected version/commit, steps to reproduce, and the
impact you observed. We will acknowledge receipt, assess the report, and
coordinate a fix before any public disclosure.

## Security boundaries and credential handling

Lattice currently uses a `local-trusted` execution model. Tools run with
the local user's privileges; workspace checks, environment filtering and
renderer isolation do not provide an OS sandbox for arbitrary commands.
Review the project and requested actions before running a task.

- UI provider keys live in backend session memory and are scoped to the
  provider and normalized endpoint. The `openai` CLI preset can read an
  explicitly supplied `LATTICE_API_KEY`. Product configuration does not
  persist provider keys; there is no durable credential store (an opt-in OS
  keyring is a pending product decision, not a current feature).
- Credential-bearing requests require HTTPS except for loopback fixtures.
  The compatible adapter refuses redirects and withholds responses that
  reflect the configured key in returned text or tool arguments. These
  controls are targeted protections, not a universal secret detector.
- Child commands receive a filtered environment. Files supplied by the
  user and explicit command arguments can still contain sensitive data;
  do not put secrets in task text, project files, logs or exports.
- Desktop session bootstrap uses the private main/backend channel. HTTP
  requests check the bound Host and Origin, and authenticated API access
  uses an ephemeral HttpOnly, SameSite=Strict cookie. A malicious process
  already running as the user is outside this protection boundary.
- The local usage export refuses data matching its secret-shaped patterns.
  Pattern checks and regression tests do not prove that every possible
  credential or sensitive value will be detected.

## Human confirmation is consent, not containment

The optional confirmation mode (per task, off by default) pauses every `edit`,
`exec` and process-control action until the human approves or denies that exact
action. It is enforced by the runtime before admission, so direct protocol calls
cannot skip it, and an approval is bound to the task, the tool, the canonical
arguments and the contract revision, consumed by one attempt. Waiting, reloads,
restarts and withdrawn requests never count as approval.

It does **not** sandbox anything: an approved command runs with your user
privileges and can do whatever that command does, including effects outside the
project folder. Long arguments are shown up to 64,000 characters with any cut
declared; approve only what you read. Read and search tools are not gated. Free
text "forbid" guidance is still guidance; typed restrictions are not exposed yet.

## Untrusted model output

Model answers are rendered as Markdown by an in-house parser into React elements;
raw HTML is shown as text, images are not loaded, and only `http:`, `https:` and
`mailto:` links are clickable. The desktop opens such links in the system browser;
other schemes, new windows and navigation away from the local backend origin are
refused. The page is served with a restrictive Content-Security-Policy
(`default-src 'self'`, no inline scripts). This limits rendering attacks; it does
not make model text trustworthy, and prompt injection through project files or
tool output remains possible.

## Desktop process isolation

The Electron renderer runs with `contextIsolation`, the renderer sandbox and no
Node integration; the preload exposes only the platform name, a protocol number
and the native project chooser. One instance runs per profile: a second launch
exits and focuses the first. The backend runs in a utility process and is stopped
when the app closes. Each profile (data directory) has its own browser state and
database.

## Interrupted and uncertain operations

If the app or backend dies mid-task, the task becomes `INTERRUPTED` on the next
start. An effect that was dispatched without a recorded receipt stays `UNKNOWN`
and is never repeated or reclassified automatically; the human observes,
records or acknowledges it. A model call in flight is counted as possibly consumed.

Keep credentials, browser profiles, databases and local validation evidence
out of source commits and distribution packages. Report a suspected leak
through the private reporting route above.
