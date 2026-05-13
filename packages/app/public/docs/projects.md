# Projects

The **Projects menu** (top-left) manages multiple persistent
projects.

## Actions

- **+ New project…** — prompt for a name; opens a fresh project
  with one empty MIDI track.
- **★ Demo Song** — open the ephemeral demo. Edits are scratch-only
  until you click **Save as new project…**.
- **Switch** — clicking any project in the list tears down the
  current one (releases plugin handles, stops the worklet) and boots
  the chosen one cleanly.
- **Rename** — pencil icon next to the active project.
- **Archive / Restore** — soft-delete into a trash drawer.
  - **Restore** brings it back from trash.
  - **Empty trash** purges the IndexedDB store for those projects.

## The demo song slot

> _The demo song's edits never overwrite the canonical seed._

When you fork via **Save as new project…**, the new persistent
project carries the demo's state verbatim — including any plugins
you installed during the demo session.

This is what we mean by "the demo is the cumulative audible
regression": every feature is supposed to be hearable from a fresh
demo seed. If a feature lands but doesn't show up in the demo, the
demo is wrong.

## Where projects live

Every project is one IndexedDB database, keyed by its `docName`.
The database holds the Y.Doc updates plus any recorded audio
references. See [Files & storage](#page:files).
