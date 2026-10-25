# Profile snapshot

`desktop/` is a byte-for-byte snapshot of `~/.dsh/profiles/desktop` minus everything a machine has
to generate itself. It is what `node tools/dsh-plugins.mjs sync` writes back.

## The four files

| File | Why it is here |
| --- | --- |
| `package.json` | the bundle stack (`dsh.profile.bundles`) and the exact dependency specs |
| `cordis.patch.yml` | the row overrides on top of every bundle layer (model, theme, permissions, per-plugin config) |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` plus the `minimumReleaseAgeExclude` pins the app added |
| `pnpm-lock.yaml` | resolved versions and integrity hashes, so two machines install the same tree |

## What is deliberately absent

- `node_modules/` — installed per machine by pnpm.
- `~/.dsh/.credentials.yaml`, sessions, attachments, storages — machine state, not intent.
- The `@deepseek-ai/dsh-experimental-plugin-market-bundle` dependency the live profile used to carry:
  it was specified as `file:C:/Users/…/plugin-cache/….tgz` (absolute, machine-local) and was never
  mounted in the bundle stack. `sync --apply` therefore drops it; re-add it as a registry version if
  the Discover tab is ever needed again.

## Relative links

```json
"@dsh-external/workspace-todo": "link:../../plugins/workspace-todo"
```

The specifier is resolved from the directory holding `package.json`:

- from `~/.dsh/profiles/desktop` it is `~/.dsh/plugins/workspace-todo`
- from `profile/desktop` it is `plugins/workspace-todo` in this repo

That is why the same file works on every machine, user name and checkout path, and why
`sync --apply` creates a junction at `~/.dsh/plugins/<name>` that points at the checkout.

The **installed** junction is absolute (junctions always are), so `node_modules` is never portable —
every machine runs `pnpm install` once. Only the specifier in the lockfile is relative.
