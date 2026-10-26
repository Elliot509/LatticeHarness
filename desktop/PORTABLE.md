# Lattice desktop engineering bundles

A new Linux x64 source/runtime bundle was exercised natively on the maintainer's
Archcraft host during the 2026-10-08 finalization sprint. This is engineering
validation, not formal Arch support. Older private Windows/Ubuntu archives do
not qualify the new source. No public portable download or signed installer is
offered for this revision.

The pinned Electron runtime is included in a complete bundle. Lattice itself does not need system Node, npm,
Git, Python, Go or Docker. Commands in your project may need their own tools.
This is a local engineering bundle, not a certified release or installer.

Windows 11 x64: extract the complete ZIP to a writable folder, then double-click
`Lattice.vbs`. Keep `app` beside it. The CMD launcher is available for diagnostics.
Windows download/security policy may require approval of the downloaded artifact;
do not disable security settings. No administrator is needed for this bundle.

Linux x64: extract the complete TAR. Run `./lattice-p0` as a normal desktop user.
It uses existing graphical/system libraries. Arch usability is engineering-only;
Ubuntu is the roadmap Linux baseline. `sh install-desktop.sh` optionally adds a
per-user menu entry without changing system packages.

Ubuntu 24.04: when unprivileged Chromium sandbox startup is blocked, use
`sudo sh install-ubuntu.sh` once from the extracted bundle. This copies the whole
app into a new root-owned `/opt/lattice-friday-demo` prefix, sets the bundled
Chromium sandbox helper to root:4755, and creates a menu entry. It refuses to
overwrite existing installations. Run the app normally from the menu afterwards.
Do not set SUID on a helper below a user-writable app prefix. No sandbox-disabling
flags, system Electron replacement, or global AppArmor changes are required.

First use: choose **Pasta / Escolher projeto**, choose a bounded project folder,
then **Modelo / Configurar**. Choose the provider, enter the exact model ID
manually (or list models), and configure the key in the session credential field.
Click **Usar este modelo**. For an absent disposable target, use the objective
"Crie uma pasta chamada TesteMuse dentro deste projeto e confirme que ela existe."
For this recognized simple creation, the optional criterion can stay blank; the
filesystem predicate is derived automatically. Alternatively, open **Critério de
conclusão opcional** and enter `directory-exists:TesteMuse`. Explicit criteria
always take precedence; ambiguous/compound creations require clarification.
Start, inspect tools and the filesystem observation, and expect **Concluído**.
The project root is
shown below the configuration controls. Project selection is session-only;
historical tasks keep their original project root.

Keys use `SESSION_ONLY`: they live in backend memory, bound to provider+endpoint,
and disappear on close. The credential field clears after submission. Reenter
the key after reopening. Provider/model defaults and task history persist.
Do not put a key in an endpoint URL, objective, project files, or terminal.

Data: Windows `%LOCALAPPDATA%\Lattice`; Linux `${XDG_DATA_HOME:-~/.local/share}/lattice`.
Browser state is inside `browser-state` there. Explicit existing Lattice data-dir
overrides remain available for laboratory use. The default project is unset;
launching from HOME or a drive root does not authorize that directory.

Removal: close Lattice, remove the extracted app and optional menu entry. For the
Ubuntu setup, an administrator can remove the exact `/opt/lattice-friday-demo`
prefix and `/usr/share/applications/lattice-friday.desktop`. Retain the data
directory to keep history, or remove it explicitly if you intend to delete data.

A data directory opened by this version is upgraded to schema v4. Earlier bundles
refuse it at startup ("Database schema version 4 is newer than supported 3") and do
not modify it; to run an earlier bundle again, give it a different data directory.

A human-run OpenRouter trial with `meta/muse-spark-1.3-contributor` completed
`Crie uma pasta chamada "Python" dentro desse lugar.` in one model call, with
the directory created and `directory-exists:Python` satisfied, without looping.
This is one successful real trial, not general Muse certification. Automated
regressions use fixtures and do not require paid inference. The exact model ID
must be selected at test time; no Muse identifier is built in. Provider-specific
high/xhigh reasoning options are not currently exposed by this build.

The main bar shows `Contexto: used / window (%)` from the matching call's observed
input and actual model metadata (`context_length` when supplied). Cache is included
once; cumulative task tokens and reservations are separate diagnostics. Missing
values show `—`; a nominal capacity is not a guaranteed effective route limit.
