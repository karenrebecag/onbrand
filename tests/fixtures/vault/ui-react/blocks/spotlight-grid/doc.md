# Spotlight grid

> A feature grid where light follows the pointer, cards play live demos, and a click morphs a card into its detail.

- Type: Block

- Registry id: `spotlight-grid`
- Source file: `registry/blocks/spotlight-grid/spotlight-grid.tsx`
- Built from: Motion
- Keywords: react spotlight grid, feature grid, bento grid, interactive feature section, landing page features, card spotlight hover, expanding feature cards, shared layout card morph

Use this as a starting point and replace the sample data with your own.

## When to use

- A product landing page section that shows four features with live, hands-on previews.
- Developer tool marketing where a small working demo explains a feature better than copy.
- Pages that want a bento grid with one wide card per row and a detail view that opens in place.

## When not to use

- Use use-case-gallery for a browsable set of customer or use case stories.
- Use expandable-card when you need a single card that expands, not a whole feature grid.
- Use feature-illustration for one static feature explained with an illustration.

## Installation


### CLI with a Pro token

1. Create a token in your account and set it in the environment (or `.env.local`). Never commit it.

```bash
export ARC_PRO_TOKEN=uikit_pro_...
```

2. Add the Pro registry to `components.json`:

```json
{
  "registries": {
    "@uikit": "https://example.com/r/{name}.json",
    "@uikit-pro": {
      "url": "https://example.com/r/pro/{name}.json",
      "headers": {
        "Authorization": "Bearer ${ARC_PRO_TOKEN}"
      }
    }
  }
}
```

3. Install:

```bash
npx shadcn@latest add @uikit-pro/spotlight-grid
```

### Manual

Signed-in Pro members can copy the source from the Manual tab on the docs page.


## Usage

```tsx
import { SpotlightGrid } from "@/components/uikit/blocks/spotlight-grid/spotlight-grid";

export function FeaturesSection() {
  return (
    <section style={{ padding: "96px 24px" }}>
      <SpotlightGrid />
    </section>
  );
}
```

## API reference

### SpotlightGrid

A marketing feature grid of four cards (latency, deploys, flags, review). A soft light follows the mouse along the card borders, hovering a card plays a small live preview, and opening a card morphs it into a working detail view in place. Copy, charts, and people are sample data inside the file. Also the default export.

No props.

## Keyboard interactions

| Keys | Action |
| --- | --- |
| Tab | Moves between the card buttons. Each card title is a button that stretches over the whole card. |
| Enter / Space | Opens the focused card into its detail view; focus moves to the close button. |
| Escape | Closes the open detail view and returns focus to the card that opened it. |
| Arrow keys | Inside a detail view, move and select within the time range and rollout segmented controls. |

## Accessibility

- The section is labelled by its heading. Card buttons carry aria-expanded and aria-controls pointing at the open detail region.
- The open detail is a role="region" labelled by its title, and the grid behind it is made inert.
- Segmented controls are radiogroups with roving tabindex; the flag toggle is a role="switch"; Approve uses aria-pressed.
- The latency chart is a role="img" SVG whose label states the range and p95. Deploy and approval results are announced through a polite live region.
- Mini previews are aria-hidden; the card title and blurb carry the meaning.

## Motion

- The card surface and title share layoutIds with the detail view, so opening grows the card on a spring with a little bounce and closing settles without overshoot.
- The border light tracks the pointer through springs and fades in and out; it only runs for mouse pointers.
- Hover previews: the latency sparkline redraws every 1.1s, the deploy counter ticks every 0.9s, the flag switch and comment pin spring in.
- Charts morph their path between time ranges; changed labels crossfade with a short blur.
- Reduced motion drops the layout morph, the pointer light, and the preview timers. Content fades or switches instantly and previews show their end state.

## Responsive behavior

- The root is a size container named spotlight. Below 520px the grid is one column, from 520px two columns with wide cards spanning both, from 820px three columns.
- Below 520px the detail view opens at the card's own position instead of the top of the grid, and cards, padding, and the chart get smaller.
- The pointer light and hover previews only run for a mouse; on touch, cards simply open on tap.

## Performance

- The pointer light is driven by motion values and CSS variables, so pointer moves do not re-render React.
- Each card reads its offset with a ResizeObserver. Preview intervals only run while a card is hovered or focused.
- useInView starts the first sparkline and tick animations once, when the grid is 30% visible.

## Notes for AI

- Use for a landing page feature section where each feature can be tried, not just described.
- All content lives in constants at the top of the file (CARDS, RANGES, SHIPS, COMMENTS). Edit those and the matching Mini and Detail components to present your own features.
- There are no props or callbacks; the deploy, flag, and approval interactions are simulated locally.
- Uses next/image with shared demo portraits from @/components/uikit/lib/media, and AnimatedCounter for numbers.

## Related

- [Expandable card]: Give a dense card more room when requested.
- [Scroll story]: A feature section where scrolling the copy drives a pinned product view through each step.

## Guidance for AI tools

Blocks are complete, self-contained screens with sample data. Replace the sample data and connect the callbacks described above. Follow the declared prop types and do not invent props. Keep keyboard access, reduced motion support, and both light and dark themes intact when adapting it.

