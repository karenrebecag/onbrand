# Hero section

> Three full screen SaaS heroes: a live dashboard rising from the bottom edge over a drifting mesh, a workflow graph that routes sample events node by node, and editorial type over a mesh gradient.

- Type: Block

- Access: Free, open source
- Registry id: `hero-section`
- Source file: `registry/blocks/hero-section/hero-section.tsx`
- Built from: Button, Line chart, Sparkline, Segmented control, Avatar, Gradient mesh
- Keywords: react hero section, saas hero, landing page hero, hero with dashboard screenshot, mesh gradient hero, workflow hero, perspective screenshot hero

Use this as the first section of a landing page and replace the sample copy and data with your own. Events in the workflow preview are simulated.

## When to use

- The first section of a SaaS landing page, when the product screen is the pitch (Screenshot).
- Developer tools, automation, and infrastructure products, where showing the product working is the pitch (Workflow).
- A launch or download page that wants one confident line and a sense of atmosphere (Mesh).

## When not to use

- Use page-header for titles inside app screens.
- Use hero-signup when the goal is collecting an email in the first section.

## Installation

### CLI

Run one of these in a project set up with `shadcn init`:

```bash
npx shadcn@latest add @uikit/hero-section
pnpm dlx shadcn@latest add @uikit/hero-section
yarn dlx shadcn@latest add @uikit/hero-section
bunx --bun shadcn@latest add @uikit/hero-section
```

The `@uikit` name needs `"registries": { "@uikit": "https://example.com/r/{name}.json" }` in `components.json`. Without it, use the full URL:

```bash
npx shadcn@latest add https://example.com/r/hero-section.json
```

### Manual

1. Install the dependencies:

```bash
npm install motion lucide-react
```

2. Copy the source into your project. Main file: `registry/blocks/hero-section/hero-section.tsx`


3. Imports use the `@/` alias for `registry/` and `lib/`. Keep the same folders or update the import paths.

## Usage

```tsx
import { HeroSection } from "@/components/uikit/blocks/hero-section/hero-section";

export function Hero() {
  return (
    <HeroSection
      variant="centered"
      primaryAction={{ label: "Start free trial", href: "/sign-up" }}
      secondaryAction={{ label: "Book a demo", href: "/demo" }}
    />
  );
}
```

## API reference

### HeroSection

A SaaS landing hero in three designs, each exactly one full screen (100svh) and edge to edge. `centered` (Screenshot) sets a headline over a drifting mesh gradient that fills the screen, with a live revenue dashboard rising from the bottom edge: the window settles from a tilt as it enters and runs off the screen into a fade. `split` (Workflow) puts the copy beside a live workflow graph on a dotted canvas: sample Stripe events run node by node, data draws along each edge, the branch decides which actions run, and every step reports its time. `minimal` (Mesh) is large editorial type over a full mesh gradient with grain, with customer marks along the bottom edge. Pass `title` to render your own content in any layout instead.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `variant` | `"centered" \| "split" \| "minimal"` | `"centered"` | Which design to render. |
| `animateIn` | `boolean` | `true` | Plays the entrance once on mount. |
| `primaryAction` | `HeroAction \| null` | – | The main call to action: { label, href?, onClick?, external?, doneLabel? }. With href it renders a link; without, a button that shows `doneLabel` for a moment after a press. |
| `secondaryAction` | `HeroAction \| null` | – | The second call to action, same shape. |
| `title` | `string` | – | Your own headline. When set, the hero renders your content (HeroContent) in the chosen layout. |
| `description` | `string` | – | Your own content: one or two sentences under the title. |
| `announcement` | `HeroAction \| null` | – | Your own content: a short link above the title for real news. |
| `install` | `{ label: string; command: string }[] \| null` | – | Your own content: the first command is shown with a copy button. |
| `media` | `ReactNode` | – | Your own content: a visual beside the copy in the split layout. |
| `meta` | `string[]` | – | Your own content: small facts under the actions. |
| `className` | `string` | – | Extra class on the section. |

### HeroLumen

The Screenshot design on its own. The dashboard is real markup built from Brand LineChart, Sparkline, SegmentedControl, and Avatar; its range control changes every figure on screen, and the chart can be scrubbed.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `primaryAction` | `HeroAction` | `{ label: "Start free trial", doneLabel: "Trial started" }` | The main call to action. |
| `secondaryAction` | `HeroAction` | `{ label: "Book a demo" }` | The second call to action. |

### HeroRelay

The Workflow design on its own: a Relay workflow (Stripe invoice paid, HubSpot lookup, an amount branch, then Slack, Linear, and warehouse actions) that runs sample events on its own while on screen. Send test event runs the next sample at once; a small invoice skips the Slack and Linear steps.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `primaryAction` | `HeroAction` | `{ label: "Start building", doneLabel: "Workspace created" }` | The main call to action. |
| `secondaryAction` | `HeroAction` | `{ label: "Read the docs" }` | The second call to action. |

### HeroCadence

The Mesh design on its own: type over a mesh gradient, and customer marks drawn in the text color.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `primaryAction` | `HeroAction` | `{ label: "Download for Mac" }` | The main call to action. |

### HeroMesh

The background renderer: a lean, non-editing version of the Gradient mesh. Points use the editor's model (x, y, spread); colors come from the CSS variables `--mesh-base` and `--mesh-1` onward, so each theme authors its own palette.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `points` | `{ x: number; y: number; spread: number }[]` | – | Up to eight points, bottom to top. |
| `grain` | `number` | `0.35` | Film grain, 0 to 1. |
| `speed` | `number` | `1` | Drift speed; 1 loops every 20 seconds, 0 holds still. |

### HeroSectionBlock

Default export: the hero full screen with a small glass design switch floating over its top edge; switching replays the entrance.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `variant` | `HeroSectionVariant` | `"centered"` | Initial design. |

## Accessibility

- Each design has one h1, and the calls to action are real links or buttons with visible text.
- The dashboard is a labelled group of sample data; its range control is a segmented control and the chart keeps its screen reader table.
- The workflow graph is a labelled group; each step's state has a text label (waiting, running, done, skipped) and its result is written out, never shown by color alone.
- The mesh and glow are decorative and hidden from assistive technology. Pointer focus draws no ring; keyboard focus shows shared focus ring.

## Motion

- Screenshot: the copy rises in reading order, then the window rises in behind it and settles flat from a tilt.
- Workflow: each step turns to the accent while it runs, the data draws along the edge to the next one, and the result and time swap in with a small spring. The run pauses while the hero is off screen or the tab is hidden.
- Mesh: the gradient drifts on the Gradient mesh editor's seamless 20 second loop.
- Reduced motion removes every transform: no rise or tilt, the mesh draws one still frame, content fades in briefly, and the workflow shows each event as its finished run without playing; Send test event moves to the next one at once.

## Responsive behavior

- Every design is one full screen (100svh, full width) on desktop and phones. Container queries: the split layout stacks below 900px; below 560px padding tightens and actions fill the width.
- The dashboard and the workflow graph are drawn at a fixed design size and scaled like a screenshot. The dashboard switches to a compact layout without the sidebar under 720px and runs off the bottom edge into a fade; the graph switches to compact action nodes on phones.
- On phones the logo row of the Mesh design becomes a grid.

## Performance

- One WebGL canvas at most per hero, drawn at one pixel per CSS pixel and thirty frames a second, only while on screen and the tab is visible. A static CSS render of the same mesh shows first.
- The workflow advances one React state step every few hundred milliseconds only while the hero is on screen and the tab is visible; nothing else loops at rest.

## Notes for AI

- The three designs carry sample products (Lumen, Relay, Cadence). Replace the copy in hero-lumen.tsx, hero-relay.tsx, and hero-cadence.tsx, the dashboard data in hero-lumen-data.ts, and the sample events at the top of hero-relay.tsx, or pass title and friends for a plain content hero.
- Mesh colors live in CSS per theme (hero-lumen.module.css and hero-cadence.module.css), in the variables --mesh-base and --mesh-1 onward.
- Brand marks are sample customers from public/block-logos, not endorsements.
- Composes Button, LineChart, Sparkline, SegmentedControl, and Avatar.

## Related

- [Site header]: A sticky website header that turns solid on scroll, with a gliding active link, mega menu panels, and a mobile sheet.
- [Logo marquee]: A quiet, continuously moving row of brand marks with a pause control.
- [Hero signup]: A full screen waitlist hero on a soft, drifting mesh gradient: the email field validates as you type and its button grows into the confirmation with your place in line.

## Guidance for AI tools

Blocks are complete, self-contained screens with sample data. Replace the sample data and connect the callbacks described above. Follow the declared prop types and do not invent props. Keep keyboard access, reduced motion support, and both light and dark themes intact when adapting it.

