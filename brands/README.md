# Brands

Each folder here is a brand pack: an identity layer applied on top of the design system without changing it.

| Folder | What it is |
|---|---|
| `brand-pack/` | The neutral base and the default. With no brand requested, the page gets the plain contract (`neutral` accent). |
| `brand-pack-ejemplo/` | The template. Copy it to create your brand. |

| File in a pack | Required | Contract |
|---|---|---|
| `brand.json` | yes | [`brandpack-v2.schema.json`](brandpack-v2.schema.json): name, theme, overrides, logo (see [Format](#format-v2-and-v1)) |
| `DESIGN.md` | no | YAML frontmatter with the same values as `brand.json`, followed by three sections: `## Brand & Style`, `## Colors`, `## Typography` |
| `facts.json` | no | [`facts.schema.json`](facts.schema.json): domain, WhatsApp, clients, metrics, testimonials, prices |
| logo (`.svg`, `.png`, `.webp`) | if `brand.json` names one | a path relative to the pack, inside the pack |

Both schemas are linked from the example files through `$schema`, so an editor that understands JSON Schema autocompletes and flags errors while you type.

## Create your brand

1. **Copy the template.** Name the folder `brand-pack-<id>`. The id is lowercase letters and digits separated by single hyphens (`mi-marca`, `acme2`), up to 40 characters.

   ```sh
   cp -R brands/brand-pack-ejemplo brands/brand-pack-mi-marca
   ```

   A folder whose id breaks this rule is skipped and does not appear in the Theme panel.

2. **Edit `brand.json`.**
   - `name`
   - `theme.preset`: an accent from the contract (`neutral`, `violet`, `blue`, `green`, `amber`, `orange`, `coral`, `rose`). For your own accent, leave it out and set `--accent`, `--accent-strong`, `--accent-subtle` (and `--accent-foreground`) in `overrides`
   - `theme.seed`: instead of a preset or your own `--accent`, give one color (`{ "accent": "#rrggbb" }`) and the accent is derived in light and dark. Add `neutral` to tint backgrounds, text and borders, and `variant` (`tonal-spot` by default) to change how the palette is built. A derived value that would leave text or a button below AA is adjusted in tone, never in hue, and the pack lists what changed. Your `overrides` are never adjusted.
   - `overrides`: exact values for contract tokens, such as `--background`, `--surface`, `--foreground`, `--text-secondary`
   - `theme.fonts`: `display` and `body`, picked from the fonts the skill allows. Geist and Inter are installed. Display options include Fraunces, Playfair Display, Instrument Serif, Sora, Space Grotesk, Bricolage Grotesque and Outfit. Body options include Instrument Sans, Work Sans, IBM Plex Sans and Source Serif 4. Manrope, DM Sans, Figtree, Plus Jakarta Sans and Newsreader work for both. To load your own font CSS, use `theme.fonts.import`.
   - `overridesDark`: the dark-mode values
   - `theme.colorMode` (`light` or `dark`), `theme.roundness` and `theme.scale` (1 = the contract)
   - `logo`, `logoDark`, `logoKind`

   A key the schema does not list is an error, so a typo fails instead of being dropped.

3. **Write the `DESIGN.md` frontmatter from `brand.json`** and keep your prose.

   ```sh
   bun scripts/check-brand.ts brands/brand-pack-mi-marca --write-design
   ```

   It rewrites only the frontmatter. If the pack has no `DESIGN.md`, the command creates one with the three sections. Then write the prose: how the brand speaks, where the accent goes, which font goes where. The prose may only name colors that are in the frontmatter.

4. **Add `facts.json` if you have real data.** The agent treats every value in it as true and does not mark it as sample data, so leave out anything you would not publish. A metric needs a `source`. Without the file, the page uses clearly marked sample content.

5. **Check the pack.**

   ```sh
   bun scripts/check-brand.ts brands/brand-pack-mi-marca
   ```

   It runs the same validation as applying and publishing, and lists every error at once with the file it comes from (`brand-pack-mi-marca/DESIGN.md: …`). It exits with `0` when the pack is valid and `1` when it is not.

6. **Start and pick it.** With the transport running (`bun scripts/serve.ts`), open the builder and pick the brand in the Theme panel, or name it by id in your first message. Packs are read from disk on every run, so an edit shows up on the next page without a restart. A pack that does not validate appears in the Theme panel with its error, and a run that asks for it stops with that error instead of producing an unbranded page.

## Format: v2 and v1

A v2 `brand.json` declares only what the brand decides. Every token it leaves out keeps the contract's value
(`templates/arc-scaffold/src/components/arc/foundation.css`), so the neutral base is just `{ "name": "Base" }`.

Reading a v2 pack, in the order it is applied:

1. The contract, then `theme.preset` (its values are copied exactly from the contract).
2. `theme.fonts`, `theme.roundness` (`--radius-factor`) and `theme.scale` (`--scaling`).
3. `overrides`, in light and dark zones.
4. `overridesDark`, only in dark zones. It goes last.

`theme.colorMode` sets the page's default mode; sections with `data-theme` still pick their own. When the pack is
applied, any token it sets that leaves text or a button below 4.5:1 (3:1 for non-text) makes the apply fail.

The loader still reads v1 and always will: a run pinned to a v1 pack in the registry runs with today's code. A pack is
v1 when it has `accent`. Mixing the two forms is an error. `bun scripts/brandpack-migrate-v2.ts <pack>` checks a v1
pack and, with `--write`, rewrites it only if its `identity.css` comes out byte for byte the same.

| v1 | v2 |
|---|---|
| `accent: "violet"` | `theme.preset: "violet"` |
| `accent: { base, strong, subtle, foreground }` | `overrides`: `--accent`, `--accent-strong`, `--accent-subtle`, `--accent-foreground` |
| `surface: { background, surface, foreground, textSecondary }` | `overrides`: `--background`, `--surface`, `--foreground`, `--text-secondary` |
| `fonts` | `theme.fonts` |
| `tokens` | `overrides` (`--scaling` and `--radius-factor` move to `theme.scale` and `theme.roundness`) |
| `tokensDark` | `overridesDark` |
| `inherit` | dropped: the contract classifies every token once (`src/theme/contract-roles.json`) |
| `logo`, `logoDark`, `logoKind`, `composition`, `requires`, `components` | unchanged |

## Other folders

`WT_BRANDS_ROOT` points the transport at another folder of packs. A distro's profile module can set another default (`defaults.brandsRoot`); see `docs/profile-module.md`.
